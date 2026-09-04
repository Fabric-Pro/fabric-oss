/**
 * `logAiUsage` records usage and accrues nothing against the retired credit
 * ledger (Fizzy #1875 — BYOK only, U2).
 *
 * WHAT WENT WRONG, AND WHY THIS IS PINNED
 *
 * The ledger increment used to sit unconditionally at the end of `logAiUsage`,
 * after every usage row, with no check on the call's billing category or on
 * who actually paid for it. So a tenant spending on its OWN provider key
 * accrued against a platform allowance that never funded a cent of it:
 * production held eight `AiCreditAccount` rows totalling roughly $1,636 while
 * not one usage row had ever been categorised as platform-funded.
 *
 * The allowance grants no access any more, so nothing accrues. The table and
 * the rows already in it stay (KTD3) — they are simply never written again.
 *
 * The `aiCreditAccount.upsert` stub below is the assertion: it exists on the
 * mocked client precisely so that re-introducing the write is a red test
 * rather than a silent regression.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/log-ai-usage-no-credit-accrual.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const usageLogCreate = vi.fn();
const creditAccountUpsert = vi.fn();

vi.mock("../prisma/client", () => ({
	// Nothing under test constructs a Decimal; a placeholder keeps the sibling
	// `ai-credits` module (imported for real, see below) loadable.
	Prisma: { Decimal: class {} },
	db: {
		aiUsageLog: { create: usageLogCreate },
		aiCreditAccount: { upsert: creditAccountUpsert },
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

// `../prisma/queries/ai-credits` is deliberately NOT mocked — the last test
// below asserts against the module's real export surface.
const { logAiUsage } = await import("../prisma/queries/ai-models");

const BASE_USAGE = {
	provider: "OPENAI_DIRECT" as const,
	providerModelId: "gpt-4o",
	modelCanonicalName: "gpt-4o",
	inputTokens: 1000,
	outputTokens: 500,
	totalTokens: 1500,
	// Supplied so the cost estimator is never consulted; this test is about
	// what happens after the row is written, not about pricing.
	costUsd: 1.5,
	latencyMs: 42,
};

describe("logAiUsage — the credit ledger no longer accrues", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		usageLogCreate.mockResolvedValue({ id: "usage-1" });
	});

	it("writes the usage row for an organization without touching the ledger", async () => {
		await logAiUsage({
			...BASE_USAGE,
			userId: "user-1",
			organizationId: "org-1",
			billingCategory: "EXTERNAL_BYOK",
		});

		expect(usageLogCreate).toHaveBeenCalledTimes(1);
		expect(usageLogCreate.mock.calls[0][0].data).toMatchObject({
			organizationId: "org-1",
			billingCategory: "EXTERNAL_BYOK",
		});
		expect(creditAccountUpsert).not.toHaveBeenCalled();
	});

	it("writes a personal-scope usage row without touching the ledger", async () => {
		// The personal arm was the second call site: an organization-less row
		// accrued against the user's own allowance instead.
		await logAiUsage({
			...BASE_USAGE,
			userId: "user-1",
			billingCategory: "EXTERNAL_BYOK",
		});

		expect(usageLogCreate).toHaveBeenCalledTimes(1);
		expect(creditAccountUpsert).not.toHaveBeenCalled();
	});

	it("does not accrue for a platform-funded background call either", async () => {
		// The one category that genuinely names platform spend is also the one
		// the allowance was supposed to meter. It still writes its usage row,
		// and it still accrues nothing — there is no allowance to draw down.
		await logAiUsage({
			...BASE_USAGE,
			provider: "VERCEL_GATEWAY",
			userId: "user-1",
			organizationId: "org-1",
			jobType: "context-indexing",
			billingCategory: "PLATFORM_UNBILLED",
		});

		expect(usageLogCreate).toHaveBeenCalledTimes(1);
		expect(creditAccountUpsert).not.toHaveBeenCalled();
	});

	it("no longer exports a ledger writer for anything to call", async () => {
		// The direct check on the removal: a future caller cannot re-import
		// what no longer exists, and `getTenantAiUsageBreakdown` /
		// `estimateAiUsageCostUsd` — which have live consumers — are untouched.
		const credits = (await import(
			"../prisma/queries/ai-credits"
		)) as Record<string, unknown>;

		expect(credits.incrementTenantAiCreditUsage).toBeUndefined();
		expect(typeof credits.estimateAiUsageCostUsd).toBe("function");
		expect(typeof credits.getTenantAiUsageBreakdown).toBe("function");
	});
});
