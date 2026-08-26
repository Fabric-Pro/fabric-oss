/**
 * Tests for the generic `runSyntheticProbe` activity.
 *
 * Verifies the data-driven probe dispatcher against:
 *   - registry lookup (unknown providers, providers without probe config)
 *   - generic HTTP probe path (expected status, auth header, env-var
 *     substitution in headers)
 *   - client probe function path (the s3-head-canary code path)
 *   - error-path normalization (no throws — outcomes returned as data)
 *
 * The integration-provider registry is the live module; the AWS S3 SDK
 * and `fetch` are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks so the factories see the references.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
	return {
		...actual,
		S3Client: class {
			send = sendMock;
		},
	};
});

// `@repo/observability`'s index now has a side-effect import for
// `integration-providers.ts`, so any consumer (including this test)
// gets the live registry populated automatically.
import {
	__resetBreakersForTests,
	syntheticProbeResult,
} from "@repo/observability";
import { runSyntheticProbe } from "../synthetic-probe";

beforeEach(() => {
	sendMock.mockReset();
	syntheticProbeResult.reset();
	__resetBreakersForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
});

function mockFetch(opts: {
	status?: number;
	statusText?: string;
	body?: unknown;
}) {
	return vi.spyOn(global, "fetch").mockResolvedValueOnce(
		new Response(JSON.stringify(opts.body ?? {}), {
			status: opts.status ?? 200,
			statusText: opts.statusText ?? "OK",
		}),
	);
}

describe("runSyntheticProbe — registry guard", () => {
	it("returns failure for an unregistered provider", async () => {
		const result = await runSyntheticProbe("does-not-exist");
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not registered/);
	});

	it("returns failure for a provider with no syntheticProbe config", async () => {
		// `github` is in the registry but has no synthetic probe.
		const result = await runSyntheticProbe("github");
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/no syntheticProbe config/);
	});
});

describe("runSyntheticProbe — generic HTTP probe path", () => {
	it("succeeds when the response status matches expectedStatus", async () => {
		process.env.OPENAI_API_KEY = "sk-test";
		const fetchSpy = mockFetch({ status: 200, body: { object: "list" } });

		const result = await runSyntheticProbe("openai");

		expect(result.success).toBe(true);
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://api.openai.com/v1/models",
			expect.objectContaining({ method: "GET" }),
		);
		// Authorization header injected from authHeaderEnvVar.
		const headers = fetchSpy.mock.calls[0]?.[1]?.headers as
			| Record<string, string>
			| undefined;
		expect(headers?.Authorization).toBe("Bearer sk-test");
	});

	it("returns NOT_CONFIGURED (not a failure) when authHeaderEnvVar is unset", async () => {
		// Missing env var means the synthetic probe is misconfigured for
		// this environment — the provider itself is not necessarily down.
		// The activity must return `notConfigured: true` so the workflow
		// records the registry row as NOT_CONFIGURED (gray badge) rather
		// than counting it toward the 3-failure SEV-1 threshold.
		delete process.env.OPENAI_API_KEY;

		const result = await runSyntheticProbe("openai");
		expect(result.success).toBe(false);
		expect(result.notConfigured).toBe(true);
		expect(result.error).toMatch(/Synthetic probe disabled/);
		expect(result.error).toMatch(/OPENAI_API_KEY/);
		expect(result.error).toMatch(/not set in this environment/);
	});

	it("substitutes env vars and lists ALL missing vars in the NOT_CONFIGURED error", async () => {
		// Anthropic uses `headers["x-api-key"] = "${ANTHROPIC_API_KEY}"`.
		// When the env var is unset, the pre-flight should detect the
		// placeholder reference and short-circuit with NOT_CONFIGURED
		// rather than allowing the probe to fire with an empty key.
		delete process.env.ANTHROPIC_API_KEY;

		const result = await runSyntheticProbe("anthropic");
		expect(result.success).toBe(false);
		expect(result.notConfigured).toBe(true);
		expect(result.error).toMatch(/ANTHROPIC_API_KEY/);
	});

	it("returns failure (NOT notConfigured) when the response status does not match expectedStatus", async () => {
		// A real upstream failure (provider returning 503) must remain
		// a probe failure — it is NOT the same thing as "missing creds".
		// The workflow needs this distinction so a real outage still
		// escalates after 3 consecutive failures.
		process.env.OPENAI_API_KEY = "sk-test";
		mockFetch({ status: 503, statusText: "Service Unavailable" });

		const result = await runSyntheticProbe("openai");
		expect(result.success).toBe(false);
		expect(result.notConfigured).toBeFalsy();
		expect(result.error).toMatch(/HTTP 503/);
	});

	it("substitutes ${ENV_VAR} placeholders in header values (Anthropic pattern)", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-test";
		const fetchSpy = mockFetch({ status: 200 });

		const result = await runSyntheticProbe("anthropic");

		expect(result.success).toBe(true);
		const headers = fetchSpy.mock.calls[0]?.[1]?.headers as
			| Record<string, string>
			| undefined;
		expect(headers?.["x-api-key"]).toBe("sk-ant-test");
		// `anthropic-version` is a literal — should be passed through.
		expect(headers?.["anthropic-version"]).toBe("2023-06-01");
	});

	it("works with stripe — uses authHeaderEnvVar for the bearer", async () => {
		process.env.STRIPE_SECRET_KEY = "sk-stripe-test";
		const fetchSpy = mockFetch({
			status: 200,
			body: { object: "balance" },
		});

		const result = await runSyntheticProbe("stripe");

		expect(result.success).toBe(true);
		const headers = fetchSpy.mock.calls[0]?.[1]?.headers as
			| Record<string, string>
			| undefined;
		expect(headers?.Authorization).toBe("Bearer sk-stripe-test");
	});

	it("works with resend — uses authHeaderEnvVar for the bearer", async () => {
		process.env.RESEND_API_KEY = "re-test";
		const fetchSpy = mockFetch({ status: 200, body: { data: [] } });

		const result = await runSyntheticProbe("resend");

		expect(result.success).toBe(true);
		const headers = fetchSpy.mock.calls[0]?.[1]?.headers as
			| Record<string, string>
			| undefined;
		expect(headers?.Authorization).toBe("Bearer re-test");
	});
});

describe("runSyntheticProbe — client probe function path (S3)", () => {
	it("invokes HeadBucket via the S3 SDK on success", async () => {
		process.env.AWS_S3_BUCKET = "test-bucket";
		process.env.AWS_S3_REGION = "us-east-1";
		sendMock.mockResolvedValueOnce({});

		const result = await runSyntheticProbe("aws_s3");
		expect(result.success).toBe(true);
		expect(sendMock).toHaveBeenCalledOnce();
	});

	it("returns NOT_CONFIGURED (not a failure) when AWS_S3_BUCKET is unset", async () => {
		// Same semantics as the HTTP-path test: a missing required env
		// var is "we can't probe from here", not "the provider is down".
		// The workflow must NOT open an incident in this case.
		delete process.env.AWS_S3_BUCKET;
		const result = await runSyntheticProbe("aws_s3");
		expect(result.success).toBe(false);
		expect(result.notConfigured).toBe(true);
		expect(result.error).toMatch(/Synthetic probe disabled/);
		expect(result.error).toMatch(/AWS_S3_BUCKET/);
		// Pre-flight short-circuits — the S3 SDK is never invoked.
		expect(sendMock).not.toHaveBeenCalled();
	});

	it("returns failure when HeadBucket throws", async () => {
		process.env.AWS_S3_BUCKET = "test-bucket";
		process.env.AWS_S3_REGION = "us-east-1";
		sendMock.mockRejectedValueOnce(new Error("NoSuchBucket"));

		const result = await runSyntheticProbe("aws_s3");
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/NoSuchBucket/);
	});
});

describe("runSyntheticProbe — observability surface", () => {
	it("emits synthetic_probe_result_total with the provider+outcome labels", async () => {
		process.env.OPENAI_API_KEY = "sk-test";
		mockFetch({ status: 200 });

		await runSyntheticProbe("openai");

		const { register } = await import("@repo/observability");
		const text = await register.metrics();
		expect(text).toContain("synthetic_probe_result_total");
		expect(text).toContain('provider="openai"');
		expect(text).toContain('outcome="success"');
	});
});
