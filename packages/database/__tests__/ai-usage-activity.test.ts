/**
 * Tests for AI usage activity query helpers.
 *
 * - `listAiUsageActivity`: tenant XOR isolation, period filter, cursor
 *   pagination, totals shape.
 * - Billing source: `chatgpt_plan` vs `api` filter, per-source totals and
 *   the facet counts.
 * - `getMedianAiUsageByTaskType`: median computation for odd/even sample
 *   sets, null when no samples exist.
 *
 * Run with: pnpm --filter @repo/database test __tests__/ai-usage-activity.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findManyMock = vi.fn();
const aggregateMock = vi.fn();
const groupByMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		aiUsageLog: {
			findMany: (args: unknown) => findManyMock(args),
			aggregate: (args: unknown) => aggregateMock(args),
			groupBy: (args: unknown) => groupByMock(args),
		},
	},
	Prisma: {},
}));

import {
	getAiUsageActivityFacets,
	getAiUsageActivityTimeSeries,
	getMedianAiUsageByTaskType,
	listAiUsageActivity,
} from "../prisma/queries/ai-usage-activity";

const EMPTY_AGGREGATE = {
	_count: { id: 0 },
	_sum: {
		inputTokens: null,
		outputTokens: null,
		totalTokens: null,
		costMicroUsd: null,
	},
	_avg: { latencyMs: null },
};

describe("listAiUsageActivity", () => {
	beforeEach(() => {
		findManyMock.mockReset();
		aggregateMock.mockReset();
		groupByMock.mockReset();
		findManyMock.mockResolvedValue([]);
		aggregateMock.mockResolvedValue(EMPTY_AGGREGATE);
		groupByMock.mockResolvedValue([]);
	});

	it("filters personal context with `userId` AND `organizationId: null`", async () => {
		await listAiUsageActivity({ userId: "user-1" });

		const findArgs = findManyMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		const aggregateArgs = aggregateMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;

		expect(findArgs.where).toMatchObject({
			userId: "user-1",
			organizationId: null,
		});
		expect(aggregateArgs.where).toMatchObject({
			userId: "user-1",
			organizationId: null,
		});
	});

	it("filters org context with `organizationId` only (no `userId`)", async () => {
		await listAiUsageActivity({ organizationId: "org-1" });

		const findWhere = (
			findManyMock.mock.calls[0]?.[0] as {
				where: Record<string, unknown>;
			}
		).where;

		expect(findWhere.organizationId).toBe("org-1");
		expect(findWhere.userId).toBeUndefined();
	});

	it("applies taskTypes (array) and status filters when provided", async () => {
		await listAiUsageActivity({
			userId: "user-1",
			taskTypes: ["CHAT", "TOOL_CALLING"],
			status: "error",
		});

		const findWhere = (
			findManyMock.mock.calls[0]?.[0] as {
				where: Record<string, unknown>;
			}
		).where;

		expect(findWhere.taskType).toEqual({ in: ["CHAT", "TOOL_CALLING"] });
		expect(findWhere.success).toBe(false);
	});

	it("applies cursor pagination with skip:1 to avoid duplicates", async () => {
		await listAiUsageActivity({
			userId: "user-1",
			cursor: "row-id-42",
		});

		const findArgs = findManyMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;

		expect(findArgs.cursor).toEqual({ id: "row-id-42" });
		expect(findArgs.skip).toBe(1);
	});

	it("returns nextCursor when overfetch detected, null otherwise", async () => {
		const baseRow = {
			provider: "OPENAI",
			modelCanonicalName: "gpt-4",
			providerModelId: "gpt-4",
			taskType: "CHAT",
			agentId: null,
			conversationId: null,
			projectId: null,
			project: null,
			inputTokens: 100,
			outputTokens: 50,
			totalTokens: 150,
			costMicroUsd: 1000,
			latencyMs: 500,
			success: true,
			errorMessage: null,
			userId: "user-1",
			createdAt: new Date(),
		};

		// Limit 2 → request 3 rows; if 3 returned, page has more.
		findManyMock.mockResolvedValue([
			{ ...baseRow, id: "a" },
			{ ...baseRow, id: "b" },
			{ ...baseRow, id: "c" },
		]);

		const result = await listAiUsageActivity({
			userId: "user-1",
			limit: 2,
		});

		expect(result.rows).toHaveLength(2);
		expect(result.nextCursor).toBe("b");

		findManyMock.mockResolvedValue([
			{ ...baseRow, id: "a" },
			{ ...baseRow, id: "b" },
		]);
		const result2 = await listAiUsageActivity({
			userId: "user-1",
			limit: 2,
		});
		expect(result2.nextCursor).toBeNull();
	});

	it("rounds totals.avgLatencyMs and defaults nulls to zero", async () => {
		aggregateMock.mockResolvedValue({
			_count: { id: 5 },
			_sum: {
				inputTokens: 1234,
				outputTokens: null,
				totalTokens: 2000,
				costMicroUsd: 9999,
			},
			_avg: { latencyMs: 423.7 },
		});

		const result = await listAiUsageActivity({ userId: "user-1" });

		expect(result.totals).toEqual({
			requests: 5,
			inputTokens: 1234,
			outputTokens: 0,
			totalTokens: 2000,
			costMicroUsd: 9999,
			avgLatencyMs: 424,
			bySource: {
				chatgpt_plan: {
					requests: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalTokens: 0,
					costMicroUsd: 0,
				},
				api: {
					requests: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalTokens: 0,
					costMicroUsd: 0,
				},
			},
		});
	});

	it("clamps periodDays minimum to 1 day", async () => {
		const before = Date.now();
		await listAiUsageActivity({ userId: "user-1", periodDays: -10 });
		const after = Date.now();

		const findWhere = (
			findManyMock.mock.calls[0]?.[0] as {
				where: { createdAt?: { gte: Date } };
			}
		).where;

		const start = findWhere.createdAt?.gte;
		expect(start).toBeInstanceOf(Date);
		// Clamped to 1 day, so start should be ~1 day before now.
		const diff = before - (start as Date).getTime();
		expect(diff).toBeGreaterThan(86_400_000 - 1000);
		expect(diff).toBeLessThan(after - before + 86_400_000 + 1000);
	});

	it("clamps limit to MAX_LIMIT=100", async () => {
		await listAiUsageActivity({ userId: "user-1", limit: 5000 });

		const findArgs = findManyMock.mock.calls[0]?.[0] as { take: number };

		// take = limit + 1 (overfetch), so MAX_LIMIT(100) + 1 = 101
		expect(findArgs.take).toBe(101);
	});

	it("uses explicit from/to range when provided (overrides periodDays)", async () => {
		const from = new Date("2026-04-01T00:00:00Z");
		const to = new Date("2026-04-30T23:59:59Z");
		await listAiUsageActivity({
			userId: "user-1",
			from,
			to,
			periodDays: 7, // should be ignored when from/to set
		});

		const findWhere = (
			findManyMock.mock.calls[0]?.[0] as {
				where: { createdAt: { gte?: Date; lte?: Date } };
			}
		).where;

		expect(findWhere.createdAt.gte).toEqual(from);
		expect(findWhere.createdAt.lte).toEqual(to);
	});

	it("filters by providerModelIds (array) when set", async () => {
		await listAiUsageActivity({
			userId: "user-1",
			providerModelIds: ["gpt-4.1-mini", "gpt-4o"],
		});

		const findWhere = (
			findManyMock.mock.calls[0]?.[0] as {
				where: Record<string, unknown>;
			}
		).where;

		expect(findWhere.providerModelId).toEqual({
			in: ["gpt-4.1-mini", "gpt-4o"],
		});
	});

	it("filters by projectIds with `in` for ids, `null` for no-project, and `OR` when both are mixed", async () => {
		// Single id → `{ in: [id] }`.
		await listAiUsageActivity({
			userId: "user-1",
			projectIds: ["proj-123"],
		});
		const w1 = (
			findManyMock.mock.calls[0]?.[0] as {
				where: Record<string, unknown>;
			}
		).where;
		expect(w1.projectId).toEqual({ in: ["proj-123"] });

		findManyMock.mockClear();
		aggregateMock.mockClear();

		// Only `null` → `projectId: null` (no `in`, since rows with NULL
		// FK can't match a NULL list element through `in`).
		await listAiUsageActivity({
			userId: "user-1",
			projectIds: [null],
		});
		const w2 = (
			findManyMock.mock.calls[0]?.[0] as {
				where: Record<string, unknown>;
			}
		).where;
		expect(w2.projectId).toBeNull();

		findManyMock.mockClear();
		aggregateMock.mockClear();

		// Mix of ids and `null` → `OR` clause covering both.
		await listAiUsageActivity({
			userId: "user-1",
			projectIds: ["proj-123", null, "proj-456"],
		});
		const w3 = (
			findManyMock.mock.calls[0]?.[0] as {
				where: Record<string, unknown>;
			}
		).where;
		expect(w3.OR).toEqual([
			{ projectId: { in: ["proj-123", "proj-456"] } },
			{ projectId: null },
		]);

		findManyMock.mockClear();
		aggregateMock.mockClear();

		// Empty array → no project filter at all.
		await listAiUsageActivity({
			userId: "user-1",
			projectIds: [],
		});
		const w4 = (
			findManyMock.mock.calls[0]?.[0] as {
				where: Record<string, unknown>;
			}
		).where;
		expect(w4.projectId).toBeUndefined();
		expect(w4.OR).toBeUndefined();
	});
});

describe("billing source (ChatGPT plan vs API)", () => {
	beforeEach(() => {
		findManyMock.mockReset();
		aggregateMock.mockReset();
		groupByMock.mockReset();
		findManyMock.mockResolvedValue([]);
		aggregateMock.mockResolvedValue(EMPTY_AGGREGATE);
		groupByMock.mockResolvedValue([]);
	});

	function whereOfFirstFindMany() {
		return (
			findManyMock.mock.calls[0]?.[0] as {
				where: Record<string, unknown>;
			}
		).where;
	}

	it("`chatgpt_plan` narrows to the plan provider, `api` to every other provider", async () => {
		await listAiUsageActivity({
			organizationId: "org-1",
			billingSource: "chatgpt_plan",
		});
		expect(whereOfFirstFindMany().provider).toBe("OPENAI_CHATGPT_PLAN");

		findManyMock.mockClear();
		await listAiUsageActivity({
			organizationId: "org-1",
			billingSource: "api",
		});
		const apiWhere = whereOfFirstFindMany();
		expect(apiWhere.provider).toEqual({ not: "OPENAI_CHATGPT_PLAN" });
		// Tenant scoping is untouched by the new filter.
		expect(apiWhere.organizationId).toBe("org-1");
	});

	it("applies no provider predicate when no billing source is chosen", async () => {
		await listAiUsageActivity({ organizationId: "org-1" });
		expect(whereOfFirstFindMany().provider).toBeUndefined();
	});

	it("keeps the project `OR` and the billing source together", async () => {
		await listAiUsageActivity({
			organizationId: "org-1",
			projectIds: ["proj-a", null],
			billingSource: "api",
		});
		const where = whereOfFirstFindMany();
		expect(where.OR).toEqual([
			{ projectId: { in: ["proj-a"] } },
			{ projectId: null },
		]);
		expect(where.provider).toEqual({ not: "OPENAI_CHATGPT_PLAN" });
	});

	it("splits mixed rows into plan and API totals over the filtered set", async () => {
		groupByMock.mockResolvedValue([
			{
				provider: "OPENAI_CHATGPT_PLAN",
				_count: { id: 7 },
				_sum: {
					inputTokens: 5000,
					outputTokens: 2000,
					totalTokens: 7000,
					costMicroUsd: 0,
				},
			},
			{
				provider: "OPENAI_DIRECT",
				_count: { id: 3 },
				_sum: {
					inputTokens: 600,
					outputTokens: 300,
					totalTokens: 900,
					costMicroUsd: 4500,
				},
			},
			{
				provider: "ANTHROPIC_DIRECT",
				_count: { id: 2 },
				_sum: {
					inputTokens: null,
					outputTokens: null,
					totalTokens: null,
					costMicroUsd: 500,
				},
			},
		]);

		const result = await listAiUsageActivity({
			organizationId: "org-1",
			taskTypes: ["CHAT"],
		});

		expect(result.totals.bySource).toEqual({
			chatgpt_plan: {
				requests: 7,
				inputTokens: 5000,
				outputTokens: 2000,
				totalTokens: 7000,
				costMicroUsd: 0,
			},
			api: {
				requests: 5,
				inputTokens: 600,
				outputTokens: 300,
				totalTokens: 900,
				costMicroUsd: 5000,
			},
		});
		const groupArgs = groupByMock.mock.calls[0]?.[0] as {
			by: string[];
			where: Record<string, unknown>;
		};
		expect(groupArgs.by).toEqual(["provider"]);
		// Same where as the rows, so the split honours every other filter.
		expect(groupArgs.where).toEqual(whereOfFirstFindMany());
	});

	it("reports zeroed sources when nothing matched", async () => {
		const result = await listAiUsageActivity({ userId: "user-1" });
		expect(result.totals.bySource).toEqual({
			chatgpt_plan: {
				requests: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				costMicroUsd: 0,
			},
			api: {
				requests: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				costMicroUsd: 0,
			},
		});
	});

	it("passes the billing source through to the time-series query", async () => {
		await getAiUsageActivityTimeSeries({
			organizationId: "org-1",
			from: new Date("2026-09-01T00:00:00Z"),
			to: new Date("2026-09-02T00:00:00Z"),
			billingSource: "chatgpt_plan",
		});
		expect(whereOfFirstFindMany()).toMatchObject({
			organizationId: "org-1",
			provider: "OPENAI_CHATGPT_PLAN",
		});
	});

	it("facets count both sources from an uncapped provider groupBy", async () => {
		groupByMock.mockImplementation(async (args: { by: string[] }) => {
			if (args.by.length === 1 && args.by[0] === "provider") {
				return [
					{ provider: "OPENAI_CHATGPT_PLAN", _count: { id: 4 } },
					{ provider: "OPENAI_DIRECT", _count: { id: 10 } },
					{ provider: "AZURE_OPENAI", _count: { id: 1 } },
				];
			}
			return [];
		});

		const facets = await getAiUsageActivityFacets({ userId: "user-1" });

		expect(facets.billingSources).toEqual([
			{ value: "chatgpt_plan", requests: 4 },
			{ value: "api", requests: 11 },
		]);
		const providerCall = groupByMock.mock.calls
			.map((call) => call[0] as { by: string[]; take?: number })
			.find((args) => args.by.join() === "provider");
		expect(providerCall?.take).toBeUndefined();
	});

	it("facets report both sources at zero for an empty window", async () => {
		const facets = await getAiUsageActivityFacets({ userId: "user-1" });
		expect(facets.billingSources).toEqual([
			{ value: "chatgpt_plan", requests: 0 },
			{ value: "api", requests: 0 },
		]);
	});
});

describe("getMedianAiUsageByTaskType", () => {
	beforeEach(() => {
		findManyMock.mockReset();
	});

	it("returns null when no samples exist", async () => {
		findManyMock.mockResolvedValue([]);
		const result = await getMedianAiUsageByTaskType({
			userId: "user-1",
			taskType: "CHAT",
		});
		expect(result).toBeNull();
	});

	it("computes median for an odd-sized sample (true middle)", async () => {
		findManyMock.mockResolvedValue([
			{
				inputTokens: 100,
				outputTokens: 50,
				totalTokens: 150,
				latencyMs: 500,
				costMicroUsd: 1000,
			},
			{
				inputTokens: 200,
				outputTokens: 100,
				totalTokens: 300,
				latencyMs: 1000,
				costMicroUsd: 2000,
			},
			{
				inputTokens: 300,
				outputTokens: 150,
				totalTokens: 450,
				latencyMs: 1500,
				costMicroUsd: 3000,
			},
		]);

		const result = await getMedianAiUsageByTaskType({
			userId: "user-1",
			taskType: "CHAT",
		});

		expect(result).toEqual({
			medianInputTokens: 200,
			medianOutputTokens: 100,
			medianTotalTokens: 300,
			medianLatencyMs: 1000,
			medianCostMicroUsd: 2000,
			sampleCount: 3,
		});
	});

	it("averages the two middle values for even-sized samples", async () => {
		findManyMock.mockResolvedValue([
			{
				inputTokens: 100,
				outputTokens: 50,
				totalTokens: 150,
				latencyMs: 400,
				costMicroUsd: 1000,
			},
			{
				inputTokens: 200,
				outputTokens: 100,
				totalTokens: 300,
				latencyMs: 600,
				costMicroUsd: 2000,
			},
		]);

		const result = await getMedianAiUsageByTaskType({
			userId: "user-1",
			taskType: "CHAT",
		});

		expect(result?.medianInputTokens).toBe(150);
		expect(result?.medianLatencyMs).toBe(500);
		expect(result?.sampleCount).toBe(2);
	});

	it("only samples successful runs (success: true filter)", async () => {
		findManyMock.mockResolvedValue([]);
		await getMedianAiUsageByTaskType({
			userId: "user-1",
			taskType: "CHAT",
		});

		const findWhere = (
			findManyMock.mock.calls[0]?.[0] as {
				where: Record<string, unknown>;
			}
		).where;

		expect(findWhere.success).toBe(true);
		expect(findWhere.taskType).toBe("CHAT");
		expect(findWhere.userId).toBe("user-1");
		expect(findWhere.organizationId).toBe(null);
	});
});
