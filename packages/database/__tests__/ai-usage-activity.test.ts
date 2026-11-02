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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rawMock = vi.fn();
const findManyMock = vi.fn();
const modelFind = vi.fn(
	async (_args: unknown) =>
		[] as Array<{
			canonicalName: string;
			suitableForTasks: string[];
			capabilities: string[];
			qualityTier: string;
		}>,
);
const aggregateMock = vi.fn();
const groupByMock = vi.fn();
const countMock = vi.fn(async (_args: unknown) => 0);
const organizationFind = vi.fn(async (_args: unknown) => ({
	slug: "example-org",
}));

vi.mock("../prisma/client", async () => ({
	db: {
		$queryRaw: (args: unknown) => rawMock(args),
		aiModel: { findMany: (args: unknown) => modelFind(args) },
		aiUsageLog: {
			findMany: (args: unknown) => findManyMock(args),
			aggregate: (args: unknown) => aggregateMock(args),
			groupBy: (args: unknown) => groupByMock(args),
			count: (args: unknown) => countMock(args),
		},
		organization: { findUnique: (args: unknown) => organizationFind(args) },
	},
	Prisma: (await import("../prisma/generated/client")).Prisma,
}));

import {
	getAiUsageActivityFacets,
	getAiUsageActivityTimeSeries,
	getChatGptPlanUsageBySource,
	getMedianAiUsageByTaskType,
	listAiUsageActivity,
} from "../prisma/queries/ai-usage-activity";

beforeEach(() => {
	rawMock.mockReset();
	rawMock.mockImplementation(async () => {
		const rows = await findManyMock({ where: {} });
		return rows.map((row: Record<string, unknown>) => ({
			...row,
			requests: 1,
		}));
	});
});

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
		modelFind.mockReset();
		modelFind.mockResolvedValue([]);
		findManyMock.mockReset();
		aggregateMock.mockReset();
		groupByMock.mockReset();
		findManyMock.mockResolvedValue([]);
		aggregateMock.mockResolvedValue(EMPTY_AGGREGATE);
		groupByMock.mockResolvedValue([]);
		organizationFind.mockClear();
	});

	it("classifies distinct page models in one lookup and ignores missing metadata", async () => {
		findManyMock.mockResolvedValue([
			{
				id: "weak",
				modelCanonicalName: "example-basic",
				taskType: "COMPLEX",
			},
			{
				id: "cost",
				modelCanonicalName: "example-premium",
				taskType: "SIMPLE",
			},
			{
				id: "suitable",
				modelCanonicalName: "example-basic",
				taskType: "CHAT",
			},
			{
				id: "no-task",
				modelCanonicalName: "example-basic",
				taskType: null,
			},
			{ id: "no-model", modelCanonicalName: null, taskType: "CHAT" },
			{
				id: "unknown",
				modelCanonicalName: "example-unknown",
				taskType: "CHAT",
			},
			{
				id: "plan",
				provider: "OPENAI_CHATGPT_PLAN",
				modelCanonicalName: "example-basic",
				taskType: "COMPLEX",
			},
			{
				id: "unrated",
				modelCanonicalName: "example-unrated",
				taskType: "CHAT",
			},
		]);
		modelFind.mockResolvedValue([
			{
				canonicalName: "example-basic",
				suitableForTasks: ["COMPLEX", "CHAT"],
				capabilities: ["TEXT"],
				qualityTier: "BASIC",
			},
			{
				canonicalName: "example-premium",
				suitableForTasks: ["SIMPLE"],
				capabilities: ["TEXT"],
				qualityTier: "PREMIUM",
			},
			{
				canonicalName: "example-unrated",
				suitableForTasks: [],
				capabilities: [],
				qualityTier: "BASIC",
			},
		]);
		const result = await listAiUsageActivity({
			organizationId: "example-org",
		});
		expect(modelFind).toHaveBeenCalledExactlyOnceWith({
			where: {
				canonicalName: {
					in: [
						"example-basic",
						"example-premium",
						"example-unknown",
						"example-unrated",
					],
				},
			},
			select: {
				canonicalName: true,
				suitableForTasks: true,
				capabilities: true,
				qualityTier: true,
			},
		});
		expect(result.rows.map((r) => r.modelFit ?? null)).toEqual([
			{ kind: "quality", reason: "basic-tier" },
			null,
			null,
			null,
			null,
			null,
			null,
			null,
		]);
	});
	it("returns persisted origins and derives workflow navigation from its execution", async () => {
		findManyMock.mockResolvedValue([
			{
				id: "usage-origin-1",
				userId: null,
				frameId: "frame-1",
				workflowExecutionId: "execution-1",
				workflowExecution: { workflowId: "workflow-1" },
				featureKey: "workspace",
				promptVersionId: "prompt-1",
			},
		]);
		const result = await listAiUsageActivity({ organizationId: "org-1" });
		expect(result.rows[0]).toMatchObject({
			frameId: "frame-1",
			workflowExecutionId: "execution-1",
			workflowId: "workflow-1",
			originOrganizationSlug: "example-org",
			featureKey: "workspace",
			promptVersionId: "prompt-1",
		});
		expect(organizationFind).toHaveBeenCalledExactlyOnceWith({
			where: { id: "org-1" },
			select: { slug: true },
		});
	});

	it("does no origin lookup for an empty history", async () => {
		await listAiUsageActivity({ organizationId: "org-1" });
		expect(organizationFind).not.toHaveBeenCalled();
	});

	it("filters personal context with `userId` AND `organizationId: null`", async () => {
		await listAiUsageActivity({ userId: "user-1" });

		const findArgs = findManyMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		const aggregateArgs = groupByMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;

		expect(findArgs.where).toMatchObject({
			userId: "user-1",
			organizationId: null,
		});
		// Totals count successful calls only (Fizzy #2972 AC3).
		expect(aggregateArgs.where).toEqual({
			AND: [findArgs.where, { success: true }],
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

		groupByMock.mockImplementation(
			async (args: { by: string[]; _sum: object }) =>
				args.by[0] === "provider" && Object.keys(args._sum).length > 1
					? [
							{
								provider: "OPENAI_DIRECT",
								_count: { id: 5 },
								_sum: {
									inputTokens: 1234,
									outputTokens: null,
									totalTokens: 2000,
									costMicroUsd: null,
								},
							},
						]
					: [],
		);
		const result = await listAiUsageActivity({ userId: "user-1" });

		expect(result.totals).toEqual({
			requests: 5,
			failedAttempts: 0,
			rowCount: 0,
			inputTokens: 1234,
			outputTokens: 0,
			totalTokens: 2000,
			// Cost comes from every billed row, not the success aggregate.
			costMicroUsd: 0,
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
					requests: 5,
					inputTokens: 1234,
					outputTokens: 0,
					totalTokens: 2000,
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

// Fizzy #2972 AC3: a request a plan failed and another subscription then
// served is counted once, for the success; the log still lists both rows.
describe("failed attempts", () => {
	beforeEach(() => {
		findManyMock.mockReset();
		aggregateMock.mockReset();
		groupByMock.mockReset();
		countMock.mockReset();
		findManyMock.mockResolvedValue([]);
		aggregateMock.mockResolvedValue({
			...EMPTY_AGGREGATE,
			_count: { id: 1 },
		});
		groupByMock.mockResolvedValue([]);
		countMock.mockImplementation(async (args: unknown) =>
			JSON.stringify(args).includes('"success":false') ? 1 : 2,
		);
	});

	it("counts the success only, and reports the failed attempt apart", async () => {
		groupByMock.mockImplementation(
			async (args: { by: string[]; _sum: object }) =>
				args.by[0] === "provider" && Object.keys(args._sum).length > 1
					? [
							{
								provider: "OPENAI_DIRECT",
								_count: { id: 1 },
								_sum: {
									inputTokens: null,
									outputTokens: null,
									totalTokens: null,
									costMicroUsd: null,
								},
							},
						]
					: [],
		);
		const result = await listAiUsageActivity({ organizationId: "org-1" });
		expect(result.totals).toMatchObject({
			requests: 1,
			failedAttempts: 1,
			rowCount: 2,
		});
		const planGroupArgs = groupByMock.mock.calls[1]?.[0] as {
			where: { AND: unknown[] };
		};
		expect(planGroupArgs.where.AND).toContainEqual({ success: true });
	});

	it("keeps a billed failed attempt's cost: cost is real spend", async () => {
		const isCostGroup = (args: { by: string[]; _sum: object }) =>
			args.by.length === 1 &&
			args.by[0] === "provider" &&
			Object.keys(args._sum).join() === "costMicroUsd";
		groupByMock.mockImplementation(
			async (args: { by: string[]; _sum: object }) =>
				isCostGroup(args)
					? [
							{
								provider: "OPENAI_DIRECT",
								_sum: { costMicroUsd: 700 },
							},
						]
					: [],
		);
		const result = await listAiUsageActivity({ organizationId: "org-1" });
		expect(result.totals.costMicroUsd).toBe(700);
		expect(result.totals.bySource.api.costMicroUsd).toBe(700);
		const costArgs = groupByMock.mock.calls.find((call) =>
			isCostGroup(call[0] as { by: string[]; _sum: object }),
		)?.[0] as { where: unknown };
		expect(JSON.stringify(costArgs.where)).not.toContain('"success"');
	});

	it("totals the failed attempts themselves when filtered to errors", async () => {
		await listAiUsageActivity({ organizationId: "org-1", status: "error" });
		const aggregateArgs = groupByMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
		};
		expect(aggregateArgs.where).toMatchObject({ success: false });
		expect(JSON.stringify(aggregateArgs.where)).not.toContain(
			'"success":true',
		);
	});

	it("charts successful calls, the billed cost of every row, or the failures when filtered to errors", async () => {
		const at = new Date("2026-09-01T12:00:00Z");
		findManyMock.mockResolvedValue([
			{
				createdAt: at,
				totalTokens: 100,
				costMicroUsd: 50,
				latencyMs: 10,
				success: true,
			},
			{
				createdAt: at,
				totalTokens: 40,
				costMicroUsd: 20,
				latencyMs: 30,
				success: false,
			},
		]);
		const series = await getAiUsageActivityTimeSeries({
			organizationId: "org-1",
			from: new Date("2026-09-01T00:00:00Z"),
			to: new Date("2026-09-02T00:00:00Z"),
		});
		const totals = series.reduce(
			(sum, point) => ({
				requests: sum.requests + point.requests,
				totalTokens: sum.totalTokens + point.totalTokens,
				costMicroUsd: sum.costMicroUsd + point.costMicroUsd,
			}),
			{ requests: 0, totalTokens: 0, costMicroUsd: 0 },
		);
		// The tile and the chart agree: cost includes the billed failure.
		expect(totals).toEqual({
			requests: 1,
			totalTokens: 100,
			costMicroUsd: 70,
		});

		await getAiUsageActivityTimeSeries({
			organizationId: "org-1",
			status: "error",
			from: new Date("2026-09-01T00:00:00Z"),
			to: new Date("2026-09-02T00:00:00Z"),
		});
		expect(rawMock.mock.calls.at(-1)?.[0].values).toContain(false);
	});
});

// Meeting-time and realtime-voice rows have no request latency: an hour-long
// meeting bot row must not read as an hour-long request.
describe("rows without a request latency", () => {
	const notRequestLatency = {
		NOT: {
			providerModelId: {
				in: [
					"attendee/teams-bot",
					"@cf/deepgram/flux",
					"gpt-realtime-2.1",
				],
			},
		},
	};

	beforeEach(() => {
		findManyMock.mockReset();
		aggregateMock.mockReset();
		groupByMock.mockReset();
		countMock.mockReset();
		countMock.mockResolvedValue(0);
		findManyMock.mockResolvedValue([]);
		aggregateMock.mockResolvedValue(EMPTY_AGGREGATE);
		groupByMock.mockResolvedValue([]);
	});

	it("averages latency only over rows that have one", async () => {
		aggregateMock.mockImplementation(async (args: object) =>
			"_avg" in args
				? { _avg: { latencyMs: 812.4 } }
				: { ...EMPTY_AGGREGATE, _count: { id: 3 } },
		);

		groupByMock.mockImplementation(
			async (args: { by: string[]; _sum: object }) =>
				args.by[0] === "provider" && Object.keys(args._sum).length > 1
					? [
							{
								provider: "OPENAI_DIRECT",
								_count: { id: 3 },
								_sum: {
									inputTokens: null,
									outputTokens: null,
									totalTokens: null,
									costMicroUsd: null,
								},
							},
						]
					: [],
		);
		const result = await listAiUsageActivity({ organizationId: "org-1" });

		expect(result.totals).toMatchObject({ requests: 3, avgLatencyMs: 812 });
		const totalsArgs = groupByMock.mock.calls[0]?.[0] as { where: unknown };
		expect(totalsArgs).not.toHaveProperty("_avg");
		const latencyArgs = aggregateMock.mock.calls.find(
			(call) => "_avg" in (call[0] as object),
		)?.[0] as { where: { AND: unknown[] } };
		expect(latencyArgs.where.AND).toContainEqual(notRequestLatency);
		expect(latencyArgs.where.AND[0]).toEqual(totalsArgs.where);
	});

	it("keeps those rows out of a latency filter, and leaves the filter off otherwise", async () => {
		await listAiUsageActivity({
			organizationId: "org-1",
			minLatencyMs: 1_000,
			providerModelIds: ["attendee/teams-bot"],
		});
		const filtered = (
			findManyMock.mock.calls[0]?.[0] as {
				where: Record<string, unknown>;
			}
		).where;
		expect(filtered).toMatchObject({
			latencyMs: { gte: 1_000 },
			providerModelId: { in: ["attendee/teams-bot"] },
			...notRequestLatency,
		});

		findManyMock.mockClear();
		await listAiUsageActivity({ organizationId: "org-1" });
		const unfiltered = (
			findManyMock.mock.calls[0]?.[0] as {
				where: Record<string, unknown>;
			}
		).where;
		expect(unfiltered).not.toHaveProperty("latencyMs");
		expect(unfiltered).not.toHaveProperty("NOT");
	});

	it("shows no latency on a meeting bot row that stored the meeting's length", async () => {
		findManyMock.mockResolvedValue([
			{
				id: "bot",
				provider: "CUSTOM",
				providerModelId: "attendee/teams-bot",
				modelCanonicalName: null,
				latencyMs: 1_800_000,
			},
			{
				id: "turn",
				provider: "OPENAI_DIRECT",
				providerModelId: "gpt-4.1",
				modelCanonicalName: null,
				latencyMs: 640,
			},
		]);

		const result = await listAiUsageActivity({ organizationId: "org-1" });

		expect(result.rows.map((row) => [row.id, row.latencyMs])).toEqual([
			["bot", 0],
			["turn", 640],
		]);
	});

	it("charts latency only over rows that have one", async () => {
		const at = new Date("2026-09-01T12:00:00Z");
		findManyMock.mockResolvedValue([
			{
				createdAt: at,
				totalTokens: 0,
				costMicroUsd: 250_000,
				latencyMs: 1_800_000,
				providerModelId: "attendee/teams-bot",
				success: true,
			},
			{
				createdAt: at,
				totalTokens: 900,
				costMicroUsd: 4_000,
				latencyMs: 0,
				providerModelId: "gpt-realtime-2.1",
				success: true,
			},
			{
				createdAt: at,
				totalTokens: 100,
				costMicroUsd: 50,
				latencyMs: 600,
				providerModelId: "gpt-4.1",
				success: true,
			},
		]);

		const series = await getAiUsageActivityTimeSeries({
			organizationId: "org-1",
			from: new Date("2026-09-01T00:00:00Z"),
			to: new Date("2026-09-02T00:00:00Z"),
		});

		const point = series.find((entry) => entry.requests > 0);
		expect(point).toMatchObject({
			requests: 3,
			costMicroUsd: 254_050,
			avgLatencyMs: 600,
		});
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
		// Same where as the rows, so the split honours every other filter —
		// successful calls only.
		expect(groupArgs.where).toEqual({
			AND: [whereOfFirstFindMany(), { success: true }],
		});
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
		expect(rawMock.mock.calls.at(-1)?.[0].values).toEqual(
			expect.arrayContaining(["org-1", "OPENAI_CHATGPT_PLAN"]),
		);
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

// Fizzy #2972 FR4: per-subscription plan usage — one organization, the
// range, successful plan calls only, grouped by source and model.
describe("getChatGptPlanUsageBySource", () => {
	it("groups one organization's successful plan calls in the range by source and model", async () => {
		groupByMock.mockReset();
		groupByMock.mockResolvedValue([
			{
				providerConfigId: "acc-1",
				userId: "user-1",
				providerModelId: "gpt-6.1-sol",
				_count: { id: 3 },
				_sum: {
					inputTokens: 900,
					cachedInputTokens: 300,
					outputTokens: 50,
				},
			},
		]);
		const from = new Date("2026-10-01T00:00:00Z");
		const to = new Date("2026-10-08T00:00:00Z");
		await expect(
			getChatGptPlanUsageBySource({ organizationId: "org-1", from, to }),
		).resolves.toEqual([
			{
				accountId: "acc-1",
				userId: "user-1",
				providerModelId: "gpt-6.1-sol",
				requests: 3,
				inputTokens: 900,
				cachedInputTokens: 300,
				outputTokens: 50,
			},
		]);
		expect(groupByMock.mock.calls[0]?.[0]).toMatchObject({
			by: ["providerConfigId", "userId", "providerModelId"],
			where: {
				organizationId: "org-1",
				provider: "OPENAI_CHATGPT_PLAN",
				success: true,
				createdAt: { gte: from, lte: to },
			},
		});
	});
});

describe("SQL chart aggregation", () => {
	const from = new Date("2026-09-01T00:00:00Z");
	const to = new Date("2026-09-03T00:00:00Z");
	it("retains the newest bucket after more than 50,000 requests", async () => {
		findManyMock.mockImplementation(async (args: { take: number }) =>
			Array.from({ length: Math.min(args.take, 50001) }, (_, index) => ({
				createdAt: index < 50000 ? from : to,
				success: true,
				providerModelId: "example-model",
				totalTokens: 2,
				costMicroUsd: 1,
				latencyMs: 10,
			})),
		);
		rawMock.mockResolvedValue([
			{
				createdAt: from,
				providerModelId: "example-model",
				success: true,
				requests: 50000n,
				totalTokens: 100000n,
				costMicroUsd: 50000n,
				latencyMs: 500000n,
			},
			{
				createdAt: to,
				providerModelId: "example-model",
				success: true,
				requests: 1n,
				totalTokens: 2n,
				costMicroUsd: 3n,
				latencyMs: 20n,
			},
		]);
		const points = await getAiUsageActivityTimeSeries({
			organizationId: "example-org",
			from,
			to,
		});
		expect(points.map((p) => p.requests)).toEqual([50000, 0, 1]);
		expect(points[2]).toMatchObject({
			totalTokens: 2,
			costMicroUsd: 3,
			avgLatencyMs: 20,
		});
		const sql = rawMock.mock.calls[0][0].sql;
		expect(sql).toContain('GROUP BY 1, "providerModelId", success');
		expect(sql).not.toMatch(/LIMIT/i);
	});
	it.each([
		[{ taskTypes: ["SIMPLE"] }, '"taskType"::text IN (?)', "SIMPLE"],
		[{ status: "error" }, "success = ?", false],
		[
			{ providerModelIds: ["example-model"] },
			'"providerModelId" IN (?)',
			"example-model",
		],
		[
			{ projectIds: ["example-project", null] },
			'(("projectId" IN (?))) OR ("projectId" IS NULL)',
			"example-project",
		],
		[{ projectIds: [null] }, '"projectId" IS NULL', undefined],
		[
			{ billingSource: "api" },
			"provider::text <> ?",
			"OPENAI_CHATGPT_PLAN",
		],
		[
			{ billingSource: "chatgpt_plan" },
			"provider::text = ?",
			"OPENAI_CHATGPT_PLAN",
		],
		[
			{ filterUserIds: ["example-user"] },
			'"userId" IN (?)',
			"example-user",
		],
		[{ minCostMicroUsd: 12 }, '"costMicroUsd" >= ?', 12],
		[{ maxCostMicroUsd: 34 }, '"costMicroUsd" <= ?', 34],
		[{ minLatencyMs: 56 }, '"latencyMs" >= ?', 56],
		[{ maxLatencyMs: 78 }, '"latencyMs" <= ?', 78],
	] as const)("preserves filter %j", async (filter, fragment, value) => {
		rawMock.mockResolvedValue([]);
		await getAiUsageActivityTimeSeries({
			organizationId: "example-org",
			from,
			to,
			...filter,
		} as Parameters<typeof getAiUsageActivityTimeSeries>[0]);
		const query = rawMock.mock.calls[0][0];
		expect(query.sql).toContain(fragment);
		expect(query.sql).toContain('"organizationId" = ?');
		expect(query.sql).toContain('"createdAt" >= ?');
		expect(query.sql).toContain('"createdAt" <= ?');
		expect(query.values).toEqual(
			expect.arrayContaining(["example-org", from, to]),
		);
		if (value !== undefined) {
			expect(query.values).toContain(value);
		}
		if ("minLatencyMs" in filter || "maxLatencyMs" in filter) {
			expect(query.sql).toContain(
				'NOT ((("providerModelId" IN (?,?,?))))',
			);
			expect(query.values).toEqual(
				expect.arrayContaining([
					"attendee/teams-bot",
					"@cf/deepgram/flux",
					"gpt-realtime-2.1",
				]),
			);
		}
	});
	it("keeps the null organization tenant arm exclusive and ignores org user filters", async () => {
		rawMock.mockResolvedValue([]);
		await getAiUsageActivityTimeSeries({
			userId: "example-user",
			filterUserIds: ["other-user"],
			from,
			to,
		});
		const query = rawMock.mock.calls[0][0];
		expect(query.sql).toContain('"organizationId" IS NULL');
		expect(query.sql).toContain('"userId" = ?');
		expect(query.sql).not.toContain(" OR ");
		expect(query.values).not.toContain("other-user");
	});
});

it("derives identical overall totals from mixed provider groups with one fewer query", async () => {
	findManyMock.mockResolvedValue([]);
	countMock.mockResolvedValue(0);
	aggregateMock.mockResolvedValue({ _avg: { latencyMs: 150 } });
	groupByMock.mockImplementation(
		async (args: { by: string[]; _sum: object }) => {
			if (args.by[0] !== "provider") {
				return [];
			}
			if (Object.keys(args._sum).length === 1) {
				return [
					{ provider: "OPENAI_DIRECT", _sum: { costMicroUsd: 90 } },
					{ provider: "ANTHROPIC", _sum: { costMicroUsd: 70 } },
					{
						provider: "OPENAI_CHATGPT_PLAN",
						_sum: { costMicroUsd: 0 },
					},
				];
			}
			return [
				{
					provider: "OPENAI_DIRECT",
					_count: { id: 2 },
					_sum: {
						inputTokens: 10,
						outputTokens: 20,
						totalTokens: 30,
						costMicroUsd: 60,
					},
				},
				{
					provider: "ANTHROPIC",
					_count: { id: 3 },
					_sum: {
						inputTokens: 40,
						outputTokens: 50,
						totalTokens: 90,
						costMicroUsd: 50,
					},
				},
				{
					provider: "OPENAI_CHATGPT_PLAN",
					_count: { id: 1 },
					_sum: {
						inputTokens: 100,
						outputTokens: 200,
						totalTokens: 300,
						costMicroUsd: 0,
					},
				},
			];
		},
	);
	const result = await listAiUsageActivity({ organizationId: "example-org" });
	expect(result.totals).toMatchObject({
		requests: 6,
		inputTokens: 150,
		outputTokens: 270,
		totalTokens: 420,
		costMicroUsd: 160,
		avgLatencyMs: 150,
		bySource: {
			api: { requests: 5, totalTokens: 120, costMicroUsd: 160 },
			chatgpt_plan: { requests: 1, totalTokens: 300, costMicroUsd: 0 },
		},
	});
	expect(aggregateMock).toHaveBeenCalledTimes(1);
	expect(aggregateMock.mock.calls[0][0]).toHaveProperty("_avg");
});

describe("UTC chart boundaries", () => {
	// CI runs in UTC, where local-time bucketing matches UTC by accident. A
	// half-hour zone makes local-time day and hour boundaries visibly differ.
	const originalTz = process.env.TZ;

	beforeEach(() => {
		process.env.TZ = "Asia/Kolkata";
	});

	afterEach(() => {
		if (originalTz === undefined) {
			delete process.env.TZ;
		} else {
			process.env.TZ = originalTz;
		}
	});

	it.each([
		[
			"day",
			"2026-09-01T10:00:00Z",
			"2026-09-03T10:00:00Z",
			[
				"2026-09-01T00:00:00.000Z",
				"2026-09-02T00:00:00.000Z",
				"2026-09-03T00:00:00.000Z",
			],
		],
		[
			"hour",
			"2026-09-01T10:45:00Z",
			"2026-09-01T12:45:00Z",
			[
				"2026-09-01T10:00:00.000Z",
				"2026-09-01T11:00:00.000Z",
				"2026-09-01T12:00:00.000Z",
			],
		],
		[
			"minute",
			"2026-09-01T10:07:00Z",
			"2026-09-01T10:17:00Z",
			[
				"2026-09-01T10:05:00.000Z",
				"2026-09-01T10:10:00.000Z",
				"2026-09-01T10:15:00.000Z",
			],
		],
	] as const)(
		"uses UTC %s boundaries for SQL rows and empty buckets",
		async (granularity, from, to, dates) => {
			// SQL returns the UTC bucket start, which can precede the exact range start.
			rawMock.mockResolvedValue(
				[0, 2].map((index) => ({
					createdAt: new Date(dates[index]),
					providerModelId: "example-model",
					success: true,
					requests: 1n,
					totalTokens: 2n,
					costMicroUsd: 3n,
					latencyMs: 4n,
				})),
			);
			const points = await getAiUsageActivityTimeSeries({
				organizationId: "example-org",
				from: new Date(from),
				to: new Date(to),
				granularity,
			});
			expect(points.map((point) => point.date)).toEqual(dates);
			expect(points.map((point) => point.requests)).toEqual([1, 0, 1]);
			expect(points.map((point) => point.costMicroUsd)).toEqual([
				3, 0, 3,
			]);
		},
	);
});

describe("chart success SQL predicate", () => {
	it.each([undefined, "error", "success"] as const)(
		"filters success only for explicit status %s",
		async (status) => {
			rawMock.mockResolvedValue([]);
			await getAiUsageActivityTimeSeries({
				organizationId: "example-org",
				from: new Date("2026-09-01T00:00:00Z"),
				to: new Date("2026-09-02T00:00:00Z"),
				status,
			});
			const query = rawMock.mock.calls[0][0];
			const where = query.sql.split("WHERE")[1].split("GROUP BY")[0];
			if (status === undefined) {
				expect(where).not.toMatch(/\bsuccess\b/i);
				expect(query.values).not.toContain(true);
				expect(query.values).not.toContain(false);
			} else {
				expect(where).toContain("success = ?");
				expect(query.values).toContain(status === "success");
				expect(query.values).not.toContain(status !== "success");
			}
		},
	);
});
