/**
 * Integration Provider Registry — DB sync unit tests
 *
 * Verifies idempotency, that the update path does NOT clobber runtime
 * columns, and that DB errors are swallowed without crashing the boot.
 *
 * Tests pass a representative registration set in directly as argument.
 * The sync function under test is package-agnostic — it does not import
 * `@repo/observability`. The caller (api boot) is responsible for
 * sourcing the live registrations via `getRegisteredProviders()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const upsertMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		integrationProviderRegistry: {
			upsert: (args: unknown) => upsertMock(args),
		},
	},
}));

import {
	type IntegrationProviderRegistrationInput,
	syncIntegrationProviderRegistry,
} from "../prisma/queries/integration-provider-registry-sync";

/**
 * Representative MVP-5 + sampled DataConnectionProvider registrations.
 * Keeps the test independent of the live `@repo/observability` set
 * while still covering every code path:
 *   - MVP-5 with full breaker + synthetic probe config
 *   - MVP-5 with `statusPagePolling: false` (aws_s3)
 *   - DataConnectionProvider with statusPagePolling default
 *   - DataConnectionProvider with explicit `statusPagePolling: false`
 */
const TEST_REGISTRATIONS: IntegrationProviderRegistrationInput[] = [
	{
		key: "openai",
		displayName: "OpenAI",
		statusPageUrl: "https://status.openai.com",
		statusPageApiUrl: "https://status.openai.com/api/v2/summary.json",
		statusPagePolling: true,
		syntheticProbe: { interval: "5m" },
		breakerKey: "openai_completions",
		affectedFeatures: ["ai_generation"],
	},
	{
		key: "anthropic",
		displayName: "Anthropic",
		statusPageUrl: "https://status.anthropic.com",
		statusPageApiUrl: "https://status.anthropic.com/api/v2/summary.json",
		statusPagePolling: true,
		syntheticProbe: { interval: "5m" },
		breakerKey: "anthropic_messages",
		affectedFeatures: ["ai_generation"],
	},
	{
		key: "stripe",
		displayName: "Stripe",
		statusPageUrl: "https://status.stripe.com",
		statusPageApiUrl: "https://status.stripe.com/api/v2/summary.json",
		statusPagePolling: true,
		syntheticProbe: { interval: "5m" },
		breakerKey: "stripe_payments",
		affectedFeatures: ["payments"],
	},
	{
		key: "resend",
		displayName: "Resend",
		statusPageUrl: "https://resend-status.com",
		statusPageApiUrl: "https://resend-status.com/api/v2/summary.json",
		statusPagePolling: true,
		syntheticProbe: { interval: "5m" },
		breakerKey: "resend_email",
		affectedFeatures: ["transactional_email"],
	},
	{
		key: "aws_s3",
		displayName: "AWS S3",
		statusPageUrl: "https://health.aws.amazon.com/health/status",
		// No statusPageApiUrl — no public summary.json for AWS.
		statusPagePolling: false,
		syntheticProbe: { interval: "5m" },
		breakerKey: "aws_s3_put",
		affectedFeatures: ["file_storage", "document_processing"],
	},
	{
		key: "github",
		displayName: "GitHub",
		statusPageUrl: "https://www.githubstatus.com",
		statusPageApiUrl: "https://www.githubstatus.com/api/v2/summary.json",
		// statusPagePolling implicitly defaults to true
		affectedFeatures: [],
		dataConnectionProvider: "GITHUB",
	},
	{
		key: "salesforce",
		displayName: "Salesforce",
		statusPageUrl: "https://status.salesforce.com",
		// No summary.json
		statusPagePolling: false,
		affectedFeatures: [],
		dataConnectionProvider: "SALESFORCE",
	},
];

beforeEach(() => {
	upsertMock.mockReset();
	// Default: every upsert call resolves to an object — the actual
	// returned row isn't read by `syncIntegrationProviderRegistry`.
	upsertMock.mockResolvedValue({});
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("syncIntegrationProviderRegistry", () => {
	it("upserts one row per registration", async () => {
		const count = await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		expect(count).toBe(TEST_REGISTRATIONS.length);
		expect(upsertMock).toHaveBeenCalledTimes(TEST_REGISTRATIONS.length);
	});

	it("matches on providerKey unique constraint", async () => {
		await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		// Spot-check one call.
		const openaiCall = upsertMock.mock.calls.find(
			(c) =>
				(c[0] as { where?: { providerKey?: string } }).where
					?.providerKey === "openai",
		);
		expect(openaiCall).toBeDefined();
		expect(openaiCall?.[0].where).toEqual({ providerKey: "openai" });
	});

	it("create path includes providerKey + static config columns", async () => {
		await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		const openaiCall = upsertMock.mock.calls.find(
			(c) =>
				(c[0] as { where?: { providerKey?: string } }).where
					?.providerKey === "openai",
		);
		expect(openaiCall).toBeDefined();
		const args = openaiCall?.[0] as {
			create: Record<string, unknown>;
			update: Record<string, unknown>;
		};

		expect(args.create.providerKey).toBe("openai");
		expect(args.create.displayName).toBe("OpenAI");
		expect(args.create.statusPageUrl).toBe("https://status.openai.com");
		expect(args.create.statusPageApiUrl).toBe(
			"https://status.openai.com/api/v2/summary.json",
		);
		expect(args.create.statusPagePolling).toBe(true);
		expect(args.create.syntheticProbeEnabled).toBe(true);
		expect(args.create.syntheticProbeInterval).toBe("5m");
		expect(args.create.breakerKey).toBe("openai_completions");
		expect(args.create.affectedFeatures).toEqual(["ai_generation"]);
		expect(args.create.dataConnectionProvider).toBeNull();
	});

	it("update path does NOT include currentHealth, lastPolledAt, lastIncidentId", async () => {
		await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		// Every update path must omit the runtime columns so re-boot
		// does not clobber poller state.
		for (const call of upsertMock.mock.calls) {
			const { update } = call[0] as { update: Record<string, unknown> };
			expect(update).not.toHaveProperty("currentHealth");
			expect(update).not.toHaveProperty("lastPolledAt");
			expect(update).not.toHaveProperty("lastIncidentId");
		}
	});

	it("statusPagePolling defaults to true unless explicitly false", async () => {
		await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		// aws_s3 has explicit `statusPagePolling: false`.
		const awsCall = upsertMock.mock.calls.find(
			(c) =>
				(c[0] as { where?: { providerKey?: string } }).where
					?.providerKey === "aws_s3",
		);
		expect(awsCall).toBeDefined();
		const aws = (awsCall?.[0] as { create: { statusPagePolling: boolean } })
			.create;
		expect(aws.statusPagePolling).toBe(false);

		// github implicitly defaults — statusPagePolling: true.
		const ghCall = upsertMock.mock.calls.find(
			(c) =>
				(c[0] as { where?: { providerKey?: string } }).where
					?.providerKey === "github",
		);
		expect(ghCall).toBeDefined();
		const gh = (ghCall?.[0] as { create: { statusPagePolling: boolean } })
			.create;
		expect(gh.statusPagePolling).toBe(true);
	});

	it("syntheticProbeEnabled tracks whether syntheticProbe is set", async () => {
		await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		const probed = new Set([
			"openai",
			"anthropic",
			"stripe",
			"resend",
			"aws_s3",
		]);

		for (const call of upsertMock.mock.calls) {
			const args = call[0] as {
				where: { providerKey: string };
				create: { syntheticProbeEnabled: boolean };
			};
			const expected = probed.has(args.where.providerKey);
			expect(
				args.create.syntheticProbeEnabled,
				`syntheticProbeEnabled mismatch for ${args.where.providerKey}`,
			).toBe(expected);
		}
	});

	it("dataConnectionProvider is null for MVP-5 and set for the enum providers", async () => {
		await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		const mvp5 = new Set([
			"openai",
			"anthropic",
			"stripe",
			"resend",
			"aws_s3",
		]);

		for (const call of upsertMock.mock.calls) {
			const args = call[0] as {
				where: { providerKey: string };
				create: { dataConnectionProvider: string | null };
			};
			if (mvp5.has(args.where.providerKey)) {
				expect(args.create.dataConnectionProvider).toBeNull();
			} else {
				expect(args.create.dataConnectionProvider).toBeTruthy();
			}
		}
	});

	it("is idempotent — re-running does not duplicate logic, just re-issues upserts", async () => {
		const first = await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);
		expect(first).toBe(TEST_REGISTRATIONS.length);
		expect(upsertMock).toHaveBeenCalledTimes(TEST_REGISTRATIONS.length);

		upsertMock.mockClear();

		const second =
			await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);
		expect(second).toBe(TEST_REGISTRATIONS.length);
		expect(upsertMock).toHaveBeenCalledTimes(TEST_REGISTRATIONS.length);
	});

	it("swallows per-row errors and continues — best-effort boot", async () => {
		// Fail the first 3 calls, succeed the rest.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
			/* silence */
		});

		let calls = 0;
		upsertMock.mockImplementation(async () => {
			calls++;
			if (calls <= 3) {
				throw new Error(`simulated DB error ${calls}`);
			}
			return {};
		});

		const upserted =
			await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		expect(upsertMock).toHaveBeenCalledTimes(TEST_REGISTRATIONS.length);
		expect(upserted).toBe(TEST_REGISTRATIONS.length - 3); // 3 failed
		expect(errorSpy).toHaveBeenCalledTimes(3);
		// First error message should reference the providerKey for
		// debuggability.
		const firstLog = errorSpy.mock.calls[0]?.[0] as string;
		expect(firstLog).toMatch(/Failed to upsert provider/);
	});

	it("never throws even when every upsert fails", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
			/* silence */
		});
		upsertMock.mockRejectedValue(new Error("DB unreachable"));

		await expect(
			syncIntegrationProviderRegistry(TEST_REGISTRATIONS),
		).resolves.toBe(0);
		expect(errorSpy).toHaveBeenCalledTimes(TEST_REGISTRATIONS.length);
	});

	it("returns 0 when given an empty registration list", async () => {
		const count = await syncIntegrationProviderRegistry([]);
		expect(count).toBe(0);
		expect(upsertMock).not.toHaveBeenCalled();
	});
});
