import { beforeEach, describe, expect, it, vi } from "vitest";

const usageGroupBy = vi.hoisted(() => vi.fn());
const organizationFindMany = vi.hoisted(() => vi.fn());

vi.mock("../../client", () => ({
	db: {
		aiUsageLog: { groupBy: usageGroupBy },
		organization: { findMany: organizationFindMany },
	},
	Prisma: {},
}));

import { getAiBillingSourceByOrganization } from "../ai-adoption";

const RANGE = {
	from: new Date("2026-09-01T00:00:00Z"),
	to: new Date("2026-09-30T00:00:00Z"),
};

function group(
	organizationId: string | null,
	provider: string,
	requests: number,
	totalTokens: number | null,
	costMicroUsd: number | null,
) {
	return {
		organizationId,
		provider,
		_count: { _all: requests },
		_sum: { totalTokens, costMicroUsd },
	};
}

/** Answers the provider split with `groups` and the plan-model split with `planModels`. */
function mockGroups(groups: unknown[], planModels: unknown[] = []) {
	usageGroupBy.mockImplementation(async ({ by }: { by: string[] }) =>
		by.includes("providerModelId") ? planModels : groups,
	);
}

describe("getAiBillingSourceByOrganization", () => {
	beforeEach(() => {
		usageGroupBy.mockReset();
		organizationFindMany.mockReset();
		organizationFindMany.mockResolvedValue([]);
	});

	it("splits mixed rows per organization into plan and API buckets", async () => {
		mockGroups([
			group("org-a", "OPENAI_CHATGPT_PLAN", 30, 30_000, 0),
			group("org-a", "OPENAI_DIRECT", 10, 5_000, 2_000_000),
			group("org-a", "ANTHROPIC_DIRECT", 5, 1_000, 500_000),
			group("org-b", "AZURE_OPENAI", 8, null, null),
		]);
		organizationFindMany.mockResolvedValue([
			{ id: "org-a", name: "Example Org A" },
			{ id: "org-b", name: "Example Org B" },
		]);

		const result = await getAiBillingSourceByOrganization(RANGE);

		expect(result.totalOrganizations).toBe(2);
		expect(result.rows).toEqual([
			{
				organizationId: "org-a",
				organizationName: "Example Org A",
				plan: { requests: 30, totalTokens: 30_000, usageByModel: [] },
				api: {
					requests: 15,
					totalTokens: 6_000,
					costMicroUsd: 2_500_000,
				},
			},
			{
				organizationId: "org-b",
				organizationName: "Example Org B",
				plan: { requests: 0, totalTokens: 0, usageByModel: [] },
				api: { requests: 8, totalTokens: 0, costMicroUsd: 0 },
			},
		]);
	});

	it("groups by organization and provider inside the clamped window", async () => {
		mockGroups([]);

		await getAiBillingSourceByOrganization({
			from: new Date("2020-01-01T00:00:00Z"),
			to: RANGE.to,
		});

		const args = usageGroupBy.mock.calls[0]?.[0] as {
			by: string[];
			where: { createdAt: { gte: Date; lte: Date } };
		};
		expect(args.by).toEqual(["organizationId", "provider"]);
		expect(args.where.createdAt.lte).toEqual(RANGE.to);
		// 365-day cap, same as the other adoption aggregates.
		const spanDays =
			(args.where.createdAt.lte.getTime() -
				args.where.createdAt.gte.getTime()) /
			86_400_000;
		expect(spanDays).toBe(365);
		expect(organizationFindMany).not.toHaveBeenCalled();
	});

	it("orders by plan requests first and keeps the no-organization bucket unnamed", async () => {
		mockGroups([
			group("org-api-heavy", "OPENAI_DIRECT", 500, 1, 1),
			group("org-plan", "OPENAI_CHATGPT_PLAN", 3, 1, 0),
			group(null, "OPENAI_CHATGPT_PLAN", 1, 1, 0),
		]);
		organizationFindMany.mockResolvedValue([
			{ id: "org-plan", name: "Example Plan Org" },
			{ id: "org-api-heavy", name: "Example API Org" },
		]);

		const result = await getAiBillingSourceByOrganization(RANGE);

		expect(result.rows.map((row) => row.organizationId)).toEqual([
			"org-plan",
			null,
			"org-api-heavy",
		]);
		expect(result.rows[1]?.organizationName).toBeNull();
		const lookup = organizationFindMany.mock.calls[0]?.[0] as {
			where: { id: { in: string[] } };
		};
		expect(lookup.where.id.in).toEqual(["org-plan", "org-api-heavy"]);
	});

	it("caps the table at 50 organizations but counts all of them", async () => {
		mockGroups(
			Array.from({ length: 60 }, (_, index) =>
				group(`org-${index}`, "OPENAI_DIRECT", index + 1, 1, 1),
			),
		);

		const result = await getAiBillingSourceByOrganization(RANGE);

		expect(result.rows).toHaveLength(50);
		expect(result.totalOrganizations).toBe(60);
		expect(result.rows[0]?.organizationId).toBe("org-59");
	});
});

describe("getAiBillingSourceByOrganization — plan tokens per model", () => {
	beforeEach(() => {
		usageGroupBy.mockReset();
		organizationFindMany.mockResolvedValue([]);
	});

	it("carries each organization's plan tokens per plan model, for the API estimate", async () => {
		mockGroups(
			[group("org-a", "OPENAI_CHATGPT_PLAN", 3, 1_500, 0)],
			[
				{
					organizationId: "org-a",
					providerModelId: "gpt-6-astra",
					_sum: {
						inputTokens: 1_000,
						outputTokens: 400,
						cachedInputTokens: 100,
					},
				},
			],
		);
		const result = await getAiBillingSourceByOrganization(RANGE);
		expect(result.rows[0]?.plan.usageByModel).toEqual([
			{
				providerModelId: "gpt-6-astra",
				inputTokens: 1_000,
				outputTokens: 400,
				cachedInputTokens: 100,
			},
		]);
	});
});
