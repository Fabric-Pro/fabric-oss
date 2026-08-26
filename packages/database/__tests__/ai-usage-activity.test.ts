/**
 * Tests for AI usage activity query helpers.
 *
 * - `listAiUsageActivity`: tenant XOR isolation, period filter, cursor
 *   pagination, totals shape.
 * - `getMedianAiUsageByTaskType`: median computation for odd/even sample
 *   sets, null when no samples exist.
 *
 * Run with: pnpm --filter @repo/database test __tests__/ai-usage-activity.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const findManyMock = vi.fn();
const aggregateMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		aiUsageLog: {
			findMany: (args: unknown) => findManyMock(args),
			aggregate: (args: unknown) => aggregateMock(args),
		},
	},
	Prisma: {},
}));

import {
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
		findManyMock.mockResolvedValue([]);
		aggregateMock.mockResolvedValue(EMPTY_AGGREGATE);
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
