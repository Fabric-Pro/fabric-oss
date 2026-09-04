/**
 * Usage reporting keeps working over rows written under the retired billing
 * modes (Fizzy #1875 — BYOK only, U2, AE4 / R7).
 *
 * The allowance and the Stripe-metered overage are gone, so nothing can write
 * `INCLUDED_CREDIT` or `STRIPE_METERED` again. The enum member and the
 * `billingCategory` column stay anyway (KTD3): rows already in the log carry
 * those categories, and this is the query pair that reads them —
 * `getProjectUsageSummary` buckets the full enum, and the project usage view
 * (`apps/web/modules/saas/projects/components/ProjectUsage.tsx`) reads
 * `byBillingCategory.INCLUDED_CREDIT` and `.STRIPE_METERED` by name, so
 * dropping either member would break the render rather than tidy it.
 *
 * Historical rows keep the categories they were written with. They are not
 * re-labelled, folded into the live categories, or swept into UNKNOWN.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/project-usage-historical-billing-categories.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();

vi.mock("../prisma/client", () => ({
	// A tag stub is enough: the SQL is never executed, only handed to the
	// mocked `$queryRaw`.
	Prisma: {
		sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
			strings,
			values,
		}),
	},
	db: {
		$queryRaw: queryRaw,
	},
}));

// `../zod` is imported for real — `BILLING_BUCKETS` is derived from
// `AiUsageBillingCategorySchema.options`, which is the mechanism that keeps a
// new (or removed) enum member from being silently mismapped.
const { getProjectUsageBreakdown, getProjectUsageSummary } = await import(
	"../prisma/queries/project-ai-usage"
);

/** One micro-USD-denominated summary row, as Postgres returns it. */
function summaryRow(
	billingCategory: string | null,
	costMicroUsd: bigint,
	calls: bigint,
) {
	return {
		billingCategory,
		costMicroUsd,
		calls,
		inputTokens: 100n,
		outputTokens: 50n,
		totalTokens: 150n,
		successCalls: calls,
	};
}

describe("getProjectUsageSummary — historical billing categories", () => {
	beforeEach(() => {
		queryRaw.mockReset();
	});

	it("keeps allowance and metered rows in their own buckets", async () => {
		queryRaw.mockResolvedValue([
			summaryRow("INCLUDED_CREDIT", 1_000_000n, 2n),
			summaryRow("STRIPE_METERED", 2_000_000n, 3n),
			summaryRow("EXTERNAL_BYOK", 4_000_000n, 5n),
		]);

		const summary = await getProjectUsageSummary({
			projectId: "project-1",
			range: "all",
		});

		expect(summary.byBillingCategory.INCLUDED_CREDIT).toMatchObject({
			calls: 2,
			costCents: 100,
		});
		expect(summary.byBillingCategory.STRIPE_METERED).toMatchObject({
			calls: 3,
			costCents: 200,
		});
		expect(summary.byBillingCategory.EXTERNAL_BYOK).toMatchObject({
			calls: 5,
			costCents: 400,
		});
		// Present and zeroed rather than absent — the view reads every bucket.
		expect(summary.byBillingCategory.PLATFORM_UNBILLED).toMatchObject({
			calls: 0,
			costCents: 0,
		});

		// Historical spend still counts towards the project total.
		expect(summary.totalCalls).toBe(10);
		expect(summary.totalCostUsd).toBe(7);
	});

	it("exposes a bucket for every enum member plus UNKNOWN", async () => {
		queryRaw.mockResolvedValue([]);

		const summary = await getProjectUsageSummary({
			projectId: "project-1",
			range: "30d",
		});

		expect(Object.keys(summary.byBillingCategory).sort()).toEqual([
			"EXTERNAL_BYOK",
			"INCLUDED_CREDIT",
			"PLATFORM_UNBILLED",
			"STRIPE_METERED",
			"UNKNOWN",
		]);
		// No calls in range: an empty state, not a misleading 100%.
		expect(summary.successRate).toBeNull();
	});

	it("routes an uncategorised row to UNKNOWN and leaves the named ones alone", async () => {
		queryRaw.mockResolvedValue([
			summaryRow(null, 500_000n, 1n),
			summaryRow("INCLUDED_CREDIT", 500_000n, 1n),
		]);

		const summary = await getProjectUsageSummary({
			projectId: "project-1",
			range: "all",
		});

		expect(summary.byBillingCategory.UNKNOWN.calls).toBe(1);
		expect(summary.byBillingCategory.INCLUDED_CREDIT.calls).toBe(1);
	});
});

describe("getProjectUsageBreakdown — grouped by billing category", () => {
	beforeEach(() => {
		queryRaw.mockReset();
	});

	it("renders historical categories under their original labels", async () => {
		queryRaw.mockResolvedValue([
			{
				key: "STRIPE_METERED",
				costMicroUsd: 3_000_000n,
				calls: 4n,
				totalTokens: 900n,
			},
			{
				key: "INCLUDED_CREDIT",
				costMicroUsd: 1_000_000n,
				calls: 2n,
				totalTokens: 300n,
			},
		]);

		const items = await getProjectUsageBreakdown({
			projectId: "project-1",
			range: "all",
			groupBy: "billingCategory",
		});

		expect(items).toEqual([
			{
				key: "STRIPE_METERED",
				label: "STRIPE_METERED",
				costCents: 300,
				costUsd: 3,
				calls: 4,
				totalTokens: 900,
			},
			{
				key: "INCLUDED_CREDIT",
				label: "INCLUDED_CREDIT",
				costCents: 100,
				costUsd: 1,
				calls: 2,
				totalTokens: 300,
			},
		]);
	});
});
