/**
 * Startup-wiring tests for `apps/web/instrumentation.ts`.
 *
 * These exist for one contract: the `CRON_SECRET` diagnostic is the *only*
 * remaining signal that the Vercel-scheduled cron jobs are silently dead, now
 * that `isCronRequestAuthorized` has no User-Agent fallback (issue #2883). So
 * it must be reported, and it must be reported before anything that can throw —
 * `validatePartykitConfig` does, and an unrelated PartyKit misconfiguration
 * must not be able to swallow the cron signal.
 *
 * The helper tests in `app/api/cron/lib/__tests__/cron-auth.test.ts` pin the
 * rule itself; deleting the call from `register()`, or moving it below the
 * PartyKit check, would leave those green. This file is what fails instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	validatePartykitConfigMock,
	initObservabilityMock,
	initAppInsightsLogsMock,
	ensureBucketsMock,
} = vi.hoisted(() => ({
	validatePartykitConfigMock: vi.fn(),
	initObservabilityMock: vi.fn(),
	initAppInsightsLogsMock: vi.fn(),
	ensureBucketsMock: vi.fn(),
}));

vi.mock("@shared/lib/partykit-config", () => ({
	validatePartykitConfig: validatePartykitConfigMock,
}));
vi.mock("@repo/observability/init", () => ({
	initObservability: initObservabilityMock,
}));
vi.mock("@repo/observability/web-startup", () => ({
	initAppInsightsLogs: initAppInsightsLogsMock,
	trackLog: vi.fn(),
	trackLogException: vi.fn(),
}));
vi.mock("@repo/utils", () => ({
	describeEncryptionKeyMisconfiguration: vi.fn(() => null),
}));
vi.mock("@repo/storage", () => ({ ensureBuckets: ensureBucketsMock }));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { documents: "documents" } } },
}));

import { register } from "../instrumentation";

function cronErrorCalls(spy: ReturnType<typeof vi.spyOn>): string[] {
	return spy.mock.calls
		.map((call) => String(call[0]))
		.filter((message) => message.includes("CRON_SECRET"));
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	validatePartykitConfigMock.mockReset();
	ensureBucketsMock.mockReset();
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	vi.stubEnv("NEXT_RUNTIME", "nodejs");
	vi.stubEnv("VERCEL_ENV", "production");
	vi.stubEnv("VERCEL", "1");
	vi.stubEnv("OTEL_ENABLED", "false");
	vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("register — CRON_SECRET startup diagnostic", () => {
	it("reports a production deployment with no usable secret", async () => {
		vi.stubEnv("CRON_SECRET", "");

		await register();

		expect(cronErrorCalls(errorSpy)).toHaveLength(1);
		expect(cronErrorCalls(errorSpy)[0]).toContain("[env]");
	});

	it("still reports it when a later startup check throws", async () => {
		// The ordering guarantee. PartyKit validation throwing must not cost us
		// the only signal that the cron schedule is dead.
		vi.stubEnv("CRON_SECRET", "");
		validatePartykitConfigMock.mockImplementation(() => {
			throw new Error("partykit misconfigured");
		});

		await expect(register()).rejects.toThrow("partykit misconfigured");

		expect(cronErrorCalls(errorSpy)).toHaveLength(1);
	});

	it("stays quiet when the secret is configured", async () => {
		vi.stubEnv("CRON_SECRET", "a-real-cron-secret");

		await register();

		expect(cronErrorCalls(errorSpy)).toEqual([]);
	});

	it("stays quiet outside the Node.js runtime", async () => {
		vi.stubEnv("NEXT_RUNTIME", "edge");
		vi.stubEnv("CRON_SECRET", "");

		await register();

		expect(cronErrorCalls(errorSpy)).toEqual([]);
		expect(validatePartykitConfigMock).not.toHaveBeenCalled();
	});
});

describe("register — Application Insights log forwarding", () => {
	it("starts forwarding the web app's logs under its own cloud role", async () => {
		vi.stubEnv("CRON_SECRET", "a-real-cron-secret");
		initAppInsightsLogsMock.mockClear();

		await register();

		expect(initAppInsightsLogsMock).toHaveBeenCalledWith({
			cloudRoleName: "fabric.web",
		});
	});

	it("skips Azure VM usage probes on Vercel while forwarding logs", async () => {
		vi.stubEnv("APPLICATION_INSIGHTS_NO_STATSBEAT", "");
		initAppInsightsLogsMock.mockClear();

		await register();

		expect(process.env.APPLICATION_INSIGHTS_NO_STATSBEAT).toBe("true");
		expect(initAppInsightsLogsMock).toHaveBeenCalledOnce();
	});
});

describe("register — OpenTelemetry startup", () => {
	it("does not initialize OTel when explicitly disabled", async () => {
		initObservabilityMock.mockClear();
		await register();
		expect(initObservabilityMock).not.toHaveBeenCalled();
	});

	it("initializes OTel when enabled", async () => {
		vi.stubEnv("OTEL_ENABLED", "true");
		initObservabilityMock.mockClear();
		await register();
		expect(initObservabilityMock).toHaveBeenCalledWith(
			expect.objectContaining({ serviceName: "fabric-web" }),
		);
	});

	it("auto-enables OTel when an endpoint is configured", async () => {
		vi.stubEnv("OTEL_ENABLED", "");
		vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317");
		initObservabilityMock.mockClear();
		await register();
		expect(initObservabilityMock).toHaveBeenCalledOnce();
	});

	it("honors an explicit disable even when an endpoint is configured", async () => {
		vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317");
		initObservabilityMock.mockClear();
		await register();
		expect(initObservabilityMock).not.toHaveBeenCalled();
	});
});

describe("register — storage startup", () => {
	it("does not check buckets before serving a Vercel request", async () => {
		await register();
		expect(ensureBucketsMock).not.toHaveBeenCalled();
	});

	it("creates missing buckets for local MinIO", async () => {
		vi.stubEnv("VERCEL", "");
		await register();
		expect(ensureBucketsMock).toHaveBeenCalledWith(["documents"]);
	});
});

describe("register — startup timing", () => {
	it("reports successful Node registration timing without request identifiers", async () => {
		// Arrange
		vi.stubEnv("CRON_SECRET", "a-real-cron-secret");
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(process, "uptime").mockReturnValue(12.345);
		vi.spyOn(performance, "now")
			.mockReturnValueOnce(100)
			.mockReturnValueOnce(110)
			.mockReturnValueOnce(125)
			.mockReturnValueOnce(145);

		// Act
		await register();

		// Assert
		expect(infoSpy).toHaveBeenCalledWith("Web instrumentation timing", {
			appInsightsInitMs: 15,
			event: "web.instrumentation_timing",
			processUptimeMs: 12345,
			registerMs: 45,
		});
	});
});
