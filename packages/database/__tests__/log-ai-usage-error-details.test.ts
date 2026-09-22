/**
 * `logAiUsage` — errorStatusCode/errorDetails persistence (Fizzy #2623).
 *
 * A failed `ai_usage_log` row used to persist only `error.message`. For
 * gateway-backed calls (VERCEL_GATEWAY, e.g. the decision model
 * `typesafe-ai/jev`) the thrown error also carries the HTTP status code and,
 * in its raw response body, the gateway's routing metadata — this pins:
 *   - `errorDetails` is redacted through the shared `redactSensitiveKeys`
 *     denylist before it reaches the database, the same as every other
 *     redacted metadata column.
 *   - A credential-shaped VALUE (not just a sensitive KEY) inside
 *     `errorDetails` — e.g. upstream provider text echoed into
 *     `routing.attempts[].error` — is scrubbed the same way `errorMessage`
 *     already is (Fizzy #2623 review).
 *   - `errorDetails` is dropped (never persisted) on a successful row, even
 *     if a caller mistakenly supplies one.
 *   - `errorDetails` is size-capped: a redacted payload over 4096 serialized
 *     characters drops the (potentially unbounded) `routing` key, adds
 *     `truncated: true`, and keeps the remaining scalar fields; it never
 *     persists anything still over the cap.
 *   - `errorStatusCode`/`errorDetails` are persisted only when the row is
 *     actually a failure (`success === false`), and `errorStatusCode` only
 *     when it is a finite integer.
 *   - Neither field can turn into a rejected insert: an unexpected
 *     `errorDetails` shape, or the redactor itself throwing, drops the extra
 *     attribution rather than losing the whole usage row.
 *
 * Run with:
 *   pnpm --filter @repo/database exec vitest run __tests__/log-ai-usage-error-details.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const usageLogCreate = vi.fn();
const { redactSensitiveKeysMock } = vi.hoisted(() => ({
	redactSensitiveKeysMock: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	// Nothing under test constructs a Decimal; a placeholder keeps the sibling
	// `ai-credits` module (imported for real, see below) loadable. `DbNull` is
	// a distinct sentinel object so a successful-row / non-object errorDetails
	// assertion can check identity against it, mirroring how the real
	// generated client's `Prisma.DbNull` sentinel is used in production code.
	Prisma: { Decimal: class {}, DbNull: { __dbNull: true } },
	db: {
		aiUsageLog: { create: usageLogCreate },
		aiCreditAccount: { upsert: vi.fn() },
		aiModelProviderMapping: { findFirst: vi.fn() },
		aiModel: { findUnique: vi.fn() },
	},
}));

// Pass-through so no TTL cache or cleanup timer survives the run.
vi.mock("../prisma/queries/cache", () => ({
	aiModelCatalogCache: {
		getOrSet: async (_key: string, factory: () => Promise<unknown>) =>
			factory(),
	},
	aiTaskDefaultsCache: {
		getOrSet: async (_key: string, factory: () => Promise<unknown>) =>
			factory(),
	},
}));

// A thin, controllable wrapper over the REAL `redactSensitiveKeys` — every
// test but one gets the actual redaction behavior, and exactly one test
// (the "redactor throws" case below) overrides it for a single call via
// `mockImplementationOnce`. `vi.clearAllMocks()` in `beforeEach` clears call
// history only, never the base implementation set here.
vi.mock("../prisma/queries/audit-log", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../prisma/queries/audit-log")>();
	redactSensitiveKeysMock.mockImplementation(actual.redactSensitiveKeys);
	return { ...actual, redactSensitiveKeys: redactSensitiveKeysMock };
});

const { Prisma } = await import("../prisma/client");
const { logAiUsage } = await import("../prisma/queries/ai-models");

const BASE_USAGE = {
	provider: "VERCEL_GATEWAY" as const,
	providerModelId: "typesafe-ai/jev",
	modelCanonicalName: "typesafe-ai-jev",
	inputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
	// Supplied so the cost estimator is never consulted; these tests are
	// about errorDetails persistence, not pricing.
	costUsd: 0,
	latencyMs: 12,
};

describe("logAiUsage — errorDetails redaction, success gating, and size cap", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		usageLogCreate.mockResolvedValue({ id: "usage-1" });
	});

	it("redacts a sensitive-shaped key nested inside errorDetails before persisting", async () => {
		await logAiUsage({
			...BASE_USAGE,
			success: false,
			errorMessage: "gateway down",
			errorStatusCode: 503,
			errorDetails: {
				type: "internal_server_error",
				routing: {
					apiKey: "vck_super_secret_tenant_key",
					resolvedProvider: "typesafe-ai",
				},
			},
		});

		expect(usageLogCreate).toHaveBeenCalledTimes(1);
		const { data } = usageLogCreate.mock.calls[0][0];
		expect(data.errorStatusCode).toBe(503);
		expect(data.errorDetails).toEqual({
			type: "internal_server_error",
			routing: {
				apiKey: "[REDACTED]",
				resolvedProvider: "typesafe-ai",
			},
		});
	});

	it("scrubs a credential-shaped VALUE nested inside errorDetails, not just a sensitive key", async () => {
		// `redactSensitiveKeys` matches on object KEYS and never inspects
		// values — `routing.attempts[].error` is upstream provider free text
		// that can echo a submitted key back ("Incorrect API key provided:
		// sk-…"), under an ordinary, non-sensitive `error` key. This must be
		// scrubbed the same way `errorMessage` already is (Fizzy #2623 review).
		await logAiUsage({
			...BASE_USAGE,
			success: false,
			errorDetails: {
				type: "internal_server_error",
				routing: {
					resolvedProvider: "openai-compat",
					attempts: [
						{
							provider: "openai-compat",
							statusCode: 401,
							error: "sk-abcdefghijklmnopqrstuvwxyz123456",
						},
					],
				},
			},
		});

		const { data } = usageLogCreate.mock.calls[0][0];
		expect(data.errorDetails.routing.attempts[0].error).toBe("[redacted]");
	});

	it("strips NUL bytes from a string leaf (Postgres JSONB rejects \\u0000)", async () => {
		await logAiUsage({
			...BASE_USAGE,
			success: false,
			errorDetails: {
				routing: { attempts: [{ error: "bad\u0000byte" }] },
			},
		});

		const { data } = usageLogCreate.mock.calls[0][0];
		expect(data.errorDetails.routing.attempts[0].error).toBe("badbyte");
	});

	it("never rejects the insert when the redactor itself throws", async () => {
		redactSensitiveKeysMock.mockImplementationOnce(() => {
			throw new Error("redactor exploded");
		});

		await expect(
			logAiUsage({
				...BASE_USAGE,
				success: false,
				errorMessage: "gateway down",
				errorDetails: { type: "internal_server_error" },
			}),
		).resolves.toBeDefined();

		expect(usageLogCreate).toHaveBeenCalledTimes(1);
		const { data } = usageLogCreate.mock.calls[0][0];
		// The row itself still lands — only the extra attribution is dropped.
		expect(data.errorMessage).toBe("gateway down");
		expect(data.errorDetails).toBe(Prisma.DbNull);
	});

	it("drops errorDetails on a success row even when the caller supplies one", async () => {
		await logAiUsage({
			...BASE_USAGE,
			success: true,
			errorDetails: { type: "should-not-persist" },
		});

		const { data } = usageLogCreate.mock.calls[0][0];
		expect(data.errorDetails).toBe(Prisma.DbNull);
	});

	it("drops errorDetails when it is not an object (defensive — never a bare string/number)", async () => {
		await logAiUsage({
			...BASE_USAGE,
			success: false,
			errorDetails: "not an object" as unknown,
		});

		const { data } = usageLogCreate.mock.calls[0][0];
		expect(data.errorDetails).toBe(Prisma.DbNull);
	});

	it("drops the routing payload but keeps scalar fields once the redacted JSON exceeds the 4096-char cap", async () => {
		const oversizedRouting = {
			originalModelId: "typesafe-ai/jev",
			resolvedProvider: "typesafe-ai",
			attempts: Array.from({ length: 200 }, (_, i) => ({
				provider: `provider-${i}`,
				statusCode: 503,
				error: "Service temporarily unavailable for this attempt, retried",
			})),
		};
		expect(JSON.stringify(oversizedRouting).length).toBeGreaterThan(4096);

		await logAiUsage({
			...BASE_USAGE,
			success: false,
			errorStatusCode: 503,
			errorDetails: {
				name: "GatewayInternalServerError",
				type: "internal_server_error",
				isRetryable: true,
				routing: oversizedRouting,
			},
		});

		const { data } = usageLogCreate.mock.calls[0][0];
		expect(JSON.stringify(data.errorDetails).length).toBeLessThanOrEqual(
			4096,
		);
		expect(data.errorDetails).toEqual({
			name: "GatewayInternalServerError",
			type: "internal_server_error",
			isRetryable: true,
			// Flags that `routing` was cut for size, distinguishing this row from
			// one whose error genuinely carried no routing metadata at all.
			truncated: true,
		});
	});

	it("drops errorDetails entirely when even the scalars-only trim is still over the cap", async () => {
		await logAiUsage({
			...BASE_USAGE,
			success: false,
			errorDetails: {
				// No `routing` key to drop, so the trim step can't shrink this —
				// the whole thing must be dropped rather than persisting a
				// partial, still-oversized payload.
				name: "x".repeat(5000),
			},
		});

		const { data } = usageLogCreate.mock.calls[0][0];
		expect(data.errorDetails).toBe(Prisma.DbNull);
	});

	it("persists errorStatusCode only when it is a finite integer", async () => {
		await logAiUsage({
			...BASE_USAGE,
			success: false,
			errorStatusCode: 503.5,
		});

		const { data } = usageLogCreate.mock.calls[0][0];
		expect(data.errorStatusCode).toBeNull();
	});

	it("persists a finite integer errorStatusCode as-is", async () => {
		await logAiUsage({
			...BASE_USAGE,
			success: false,
			errorStatusCode: 429,
		});

		const { data } = usageLogCreate.mock.calls[0][0];
		expect(data.errorStatusCode).toBe(429);
	});

	it("drops errorStatusCode on a success row even when the caller supplies one", async () => {
		await logAiUsage({
			...BASE_USAGE,
			success: true,
			errorStatusCode: 503,
		});

		const { data } = usageLogCreate.mock.calls[0][0];
		expect(data.errorStatusCode).toBeNull();
	});
});
