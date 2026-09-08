/**
 * Integration Provider Registry — DB sync unit tests
 *
 * Verifies that the sync compares before writing (an unchanged row costs
 * no write at all), that the update path does NOT clobber runtime
 * columns, and that DB errors are swallowed without crashing the boot.
 *
 * The compare pass is the point of the file: the web app runs
 * serverless, so a Prisma `upsert` per registration meant every cold
 * start rewrote all 33 rows. Staging saw four boots in six minutes.
 *
 * Tests pass a representative registration set in directly as argument.
 * The sync function under test is package-agnostic — it does not import
 * `@repo/observability`. The caller (api boot) is responsible for
 * sourcing the live registrations via `getRegisteredProviders()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findManyMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		integrationProviderRegistry: {
			findMany: (args: unknown) => findManyMock(args),
			create: (args: unknown) => createMock(args),
			update: (args: unknown) => updateMock(args),
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

/**
 * The exact row shape `findMany` returns for a registration whose stored
 * config already matches — i.e. the steady state on every boot after the
 * first.
 */
function storedRowFor(
	reg: IntegrationProviderRegistrationInput,
): Record<string, unknown> {
	return {
		providerKey: reg.key,
		displayName: reg.displayName,
		statusPageUrl: reg.statusPageUrl ?? null,
		statusPageApiUrl: reg.statusPageApiUrl ?? null,
		statusPagePolling: reg.statusPagePolling !== false,
		syntheticProbeEnabled: reg.syntheticProbe !== undefined,
		syntheticProbeInterval: reg.syntheticProbe?.interval ?? null,
		breakerKey: reg.breakerKey ?? null,
		affectedFeatures: [...reg.affectedFeatures],
		dataConnectionProvider: reg.dataConnectionProvider ?? null,
	};
}

/** Every registration already stored, unchanged. */
function allRowsStored(): Record<string, unknown>[] {
	return TEST_REGISTRATIONS.map(storedRowFor);
}

beforeEach(() => {
	findManyMock.mockReset();
	createMock.mockReset();
	updateMock.mockReset();
	// Default: empty table — every registration takes the create path.
	findManyMock.mockResolvedValue([]);
	createMock.mockResolvedValue({});
	updateMock.mockResolvedValue({});
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("syncIntegrationProviderRegistry — first boot (empty table)", () => {
	it("creates one row per registration", async () => {
		const summary =
			await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		expect(summary).toEqual({
			created: TEST_REGISTRATIONS.length,
			updated: 0,
			skipped: 0,
			failed: 0,
		});
		expect(createMock).toHaveBeenCalledTimes(TEST_REGISTRATIONS.length);
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("reads the existing rows exactly once, not once per registration", async () => {
		await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);
		expect(findManyMock).toHaveBeenCalledTimes(1);
	});

	it("create path includes providerKey + static config columns", async () => {
		await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		const openaiCall = createMock.mock.calls.find(
			(c) =>
				(c[0] as { data?: { providerKey?: string } }).data
					?.providerKey === "openai",
		);
		expect(openaiCall).toBeDefined();
		const data = (openaiCall?.[0] as { data: Record<string, unknown> })
			.data;

		expect(data.providerKey).toBe("openai");
		expect(data.displayName).toBe("OpenAI");
		expect(data.statusPageUrl).toBe("https://status.openai.com");
		expect(data.statusPageApiUrl).toBe(
			"https://status.openai.com/api/v2/summary.json",
		);
		expect(data.statusPagePolling).toBe(true);
		expect(data.syntheticProbeEnabled).toBe(true);
		expect(data.syntheticProbeInterval).toBe("5m");
		expect(data.breakerKey).toBe("openai_completions");
		expect(data.affectedFeatures).toEqual(["ai_generation"]);
		expect(data.dataConnectionProvider).toBeNull();
	});

	it("create path does NOT set currentHealth, lastPolledAt, lastIncidentId", async () => {
		await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		for (const call of createMock.mock.calls) {
			const { data } = call[0] as { data: Record<string, unknown> };
			expect(data).not.toHaveProperty("currentHealth");
			expect(data).not.toHaveProperty("lastPolledAt");
			expect(data).not.toHaveProperty("lastIncidentId");
		}
	});

	it("statusPagePolling defaults to true unless explicitly false", async () => {
		await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		const byKey = new Map(
			createMock.mock.calls.map((c) => {
				const { data } = c[0] as {
					data: { providerKey: string; statusPagePolling: boolean };
				};
				return [data.providerKey, data.statusPagePolling];
			}),
		);

		// aws_s3 has explicit `statusPagePolling: false`.
		expect(byKey.get("aws_s3")).toBe(false);
		// github implicitly defaults — statusPagePolling: true.
		expect(byKey.get("github")).toBe(true);
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

		for (const call of createMock.mock.calls) {
			const { data } = call[0] as {
				data: { providerKey: string; syntheticProbeEnabled: boolean };
			};
			expect(
				data.syntheticProbeEnabled,
				`syntheticProbeEnabled mismatch for ${data.providerKey}`,
			).toBe(probed.has(data.providerKey));
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

		for (const call of createMock.mock.calls) {
			const { data } = call[0] as {
				data: {
					providerKey: string;
					dataConnectionProvider: string | null;
				};
			};
			if (mvp5.has(data.providerKey)) {
				expect(data.dataConnectionProvider).toBeNull();
			} else {
				expect(data.dataConnectionProvider).toBeTruthy();
			}
		}
	});
});

describe("syncIntegrationProviderRegistry — compare before writing", () => {
	it("writes nothing when every stored row already matches", async () => {
		findManyMock.mockResolvedValue(allRowsStored());

		const summary =
			await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		expect(summary).toEqual({
			created: 0,
			updated: 0,
			skipped: TEST_REGISTRATIONS.length,
			failed: 0,
		});
		expect(createMock).not.toHaveBeenCalled();
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("updates only the row whose config drifted", async () => {
		const rows = allRowsStored();
		const stripe = rows.find((r) => r.providerKey === "stripe");
		if (stripe) {
			stripe.displayName = "Stripe (old name)";
		}
		findManyMock.mockResolvedValue(rows);

		const summary =
			await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		expect(summary).toEqual({
			created: 0,
			updated: 1,
			skipped: TEST_REGISTRATIONS.length - 1,
			failed: 0,
		});
		expect(updateMock).toHaveBeenCalledTimes(1);
		const args = updateMock.mock.calls[0][0] as {
			where: { providerKey: string };
			data: Record<string, unknown>;
		};
		expect(args.where).toEqual({ providerKey: "stripe" });
		expect(args.data.displayName).toBe("Stripe");
	});

	it("creates the row that is missing and leaves the matching ones alone", async () => {
		findManyMock.mockResolvedValue(
			allRowsStored().filter((r) => r.providerKey !== "github"),
		);

		const summary =
			await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		expect(summary).toEqual({
			created: 1,
			updated: 0,
			skipped: TEST_REGISTRATIONS.length - 1,
			failed: 0,
		});
		expect(createMock).toHaveBeenCalledTimes(1);
		const { data } = createMock.mock.calls[0][0] as {
			data: { providerKey: string };
		};
		expect(data.providerKey).toBe("github");
	});

	it("treats a reordered affectedFeatures array as a change", async () => {
		const rows = allRowsStored();
		const aws = rows.find((r) => r.providerKey === "aws_s3");
		if (aws) {
			aws.affectedFeatures = ["document_processing", "file_storage"];
		}
		findManyMock.mockResolvedValue(rows);

		const summary =
			await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		expect(summary.updated).toBe(1);
		const args = updateMock.mock.calls[0][0] as {
			where: { providerKey: string };
			data: { affectedFeatures: string[] };
		};
		expect(args.where).toEqual({ providerKey: "aws_s3" });
		expect(args.data.affectedFeatures).toEqual([
			"file_storage",
			"document_processing",
		]);
	});

	it("detects a nullable column that gained a value", async () => {
		const rows = allRowsStored();
		const gh = rows.find((r) => r.providerKey === "github");
		if (gh) {
			gh.breakerKey = "github_api";
		}
		findManyMock.mockResolvedValue(rows);

		const summary =
			await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		expect(summary.updated).toBe(1);
		const args = updateMock.mock.calls[0][0] as {
			data: { breakerKey: string | null };
		};
		expect(args.data.breakerKey).toBeNull();
	});

	it("update path does NOT include currentHealth, lastPolledAt, lastIncidentId", async () => {
		// Every stored row differs, so every registration takes the update
		// path — the runtime columns must be absent from all of them.
		findManyMock.mockResolvedValue(
			allRowsStored().map((row) => ({ ...row, displayName: "stale" })),
		);

		await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		expect(updateMock).toHaveBeenCalledTimes(TEST_REGISTRATIONS.length);
		for (const call of updateMock.mock.calls) {
			const { data } = call[0] as { data: Record<string, unknown> };
			expect(data).not.toHaveProperty("currentHealth");
			expect(data).not.toHaveProperty("lastPolledAt");
			expect(data).not.toHaveProperty("lastIncidentId");
		}
	});

	it("is idempotent — a second run over unchanged rows writes nothing", async () => {
		findManyMock.mockResolvedValue(allRowsStored());

		const first = await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);
		const second =
			await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		expect(first.skipped).toBe(TEST_REGISTRATIONS.length);
		expect(second.skipped).toBe(TEST_REGISTRATIONS.length);
		expect(createMock).not.toHaveBeenCalled();
		expect(updateMock).not.toHaveBeenCalled();
	});
});

describe("syncIntegrationProviderRegistry — best-effort boot", () => {
	it("swallows per-row errors and continues", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
			/* silence */
		});

		let calls = 0;
		createMock.mockImplementation(async () => {
			calls++;
			if (calls <= 3) {
				throw new Error(`simulated DB error ${calls}`);
			}
			return {};
		});

		const summary =
			await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		expect(createMock).toHaveBeenCalledTimes(TEST_REGISTRATIONS.length);
		expect(summary.created).toBe(TEST_REGISTRATIONS.length - 3);
		expect(summary.failed).toBe(3);
		expect(errorSpy).toHaveBeenCalledTimes(3);
		// First error message should reference the providerKey for
		// debuggability.
		const firstLog = errorSpy.mock.calls[0]?.[0] as string;
		expect(firstLog).toMatch(/Failed to sync provider/);
	});

	it("never throws even when every write fails", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
			/* silence */
		});
		createMock.mockRejectedValue(new Error("DB unreachable"));

		const summary =
			await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		expect(summary.failed).toBe(TEST_REGISTRATIONS.length);
		expect(summary.created).toBe(0);
		expect(errorSpy).toHaveBeenCalledTimes(TEST_REGISTRATIONS.length);
	});

	it("attempts no writes when the read of existing rows fails", async () => {
		// A failed read means the database is unreachable, so the writes
		// would only reproduce the same failure N times. Log once, count
		// everything as failed, and let the next boot reconcile.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
			/* silence */
		});
		findManyMock.mockRejectedValue(new Error("read failed"));

		const summary =
			await syncIntegrationProviderRegistry(TEST_REGISTRATIONS);

		expect(summary).toEqual({
			created: 0,
			updated: 0,
			skipped: 0,
			failed: TEST_REGISTRATIONS.length,
		});
		expect(createMock).not.toHaveBeenCalled();
		expect(updateMock).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	it("does not throw when the read of existing rows fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {
			/* silence */
		});
		findManyMock.mockRejectedValue(new Error("read failed"));

		await expect(
			syncIntegrationProviderRegistry(TEST_REGISTRATIONS),
		).resolves.toBeDefined();
	});

	it("returns an all-zero summary and reads nothing for an empty registration list", async () => {
		const summary = await syncIntegrationProviderRegistry([]);

		expect(summary).toEqual({
			created: 0,
			updated: 0,
			skipped: 0,
			failed: 0,
		});
		expect(findManyMock).not.toHaveBeenCalled();
		expect(createMock).not.toHaveBeenCalled();
		expect(updateMock).not.toHaveBeenCalled();
	});
});
