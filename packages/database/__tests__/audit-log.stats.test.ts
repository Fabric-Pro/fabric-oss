/**
 * Unit tests for `aggregateAuditLogStats`.
 *
 * v2 item 5: covers the new average-latency aggregation, per-bucket mean
 * latency sparkline, sessionsToday counter, and the latencyWindow echo.
 * The DB layer is mocked — we drive the pure aggregation by stubbing
 * `db.auditLog.{count,findMany,findFirst,groupBy}` and asserting the
 * computed result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	count: vi.fn(),
	findMany: vi.fn(),
	findFirst: vi.fn(),
	groupBy: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		auditLog: {
			count: (...args: unknown[]) => mocks.count(...args),
			findMany: (...args: unknown[]) => mocks.findMany(...args),
			findFirst: (...args: unknown[]) => mocks.findFirst(...args),
			groupBy: (...args: unknown[]) => mocks.groupBy(...args),
		},
	},
}));

import { aggregateAuditLogStats } from "../prisma/queries/audit-log";

beforeEach(() => {
	mocks.count.mockReset();
	mocks.findMany.mockReset();
	mocks.findFirst.mockReset();
	mocks.groupBy.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
});

function setupHappyMocks(args: {
	eventsToday: number;
	failuresToday: number;
	actorIds: string[];
	sessionIds: string[];
	latencyRows: Array<{ createdAt: Date; durationMs: number }>;
	last24Rows: Array<{ createdAt: Date }>;
	topAction?: { action: string; count: number };
	latest?: Date;
}): void {
	mocks.count
		// eventsToday
		.mockImplementationOnce(async () => args.eventsToday)
		// failuresToday
		.mockImplementationOnce(async () => args.failuresToday);

	// findMany is called in this order:
	//  1. actorRows (distinct userIds)
	//  2. last24Rows (createdAt only)
	//  3. latencyRows (createdAt + durationMs)
	//  4. sessionRows (distinct sessionIds)
	mocks.findMany
		.mockImplementationOnce(async () =>
			args.actorIds.map((id) => ({ userId: id })),
		)
		.mockImplementationOnce(async () => args.last24Rows)
		.mockImplementationOnce(async () => args.latencyRows)
		.mockImplementationOnce(async () =>
			args.sessionIds.map((id) => ({ sessionId: id })),
		);

	mocks.findFirst.mockResolvedValueOnce(
		args.latest ? { createdAt: args.latest } : null,
	);
	mocks.groupBy.mockResolvedValueOnce(
		args.topAction
			? [
					{
						action: args.topAction.action,
						_count: { action: args.topAction.count },
					},
				]
			: [],
	);
}

describe("aggregateAuditLogStats — v2 item 5", () => {
	it("returns the new fields with defaults when no events exist", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-17T10:00:00Z"));

		setupHappyMocks({
			eventsToday: 0,
			failuresToday: 0,
			actorIds: [],
			sessionIds: [],
			latencyRows: [],
			last24Rows: [],
		});

		const result = await aggregateAuditLogStats({
			scope: { organizationId: "org-1", userId: null },
		});

		expect(result.eventsToday).toBe(0);
		expect(result.failuresToday).toBe(0);
		expect(result.uniqueActorsToday).toBe(0);
		expect(result.sessionsToday).toBe(0);
		expect(result.averageLatencyMs).toBeNull();
		expect(result.latencyWindow).toBe("24h");
		expect(result.latencySparkline).toHaveLength(24);
		expect(result.latencySparkline.every((v) => v === 0)).toBe(true);
		expect(result.hourlyVolume).toHaveLength(24);
		expect(result.topAction).toBeNull();
	});

	it("computes a window-bucketed average latency for 1h window (12 buckets of 5min)", async () => {
		vi.useFakeTimers();
		const now = new Date("2026-05-17T10:00:00Z");
		vi.setSystemTime(now);

		// Two rows: one at 5min ago (bucket index 10), one at 25min ago
		// (bucket index 7). Each carries a known durationMs.
		const latencyRows = [
			{
				createdAt: new Date(now.getTime() - 5 * 60 * 1000),
				durationMs: 100,
			},
			{
				createdAt: new Date(now.getTime() - 25 * 60 * 1000),
				durationMs: 200,
			},
		];

		setupHappyMocks({
			eventsToday: 2,
			failuresToday: 0,
			actorIds: ["u-1"],
			sessionIds: ["s-1"],
			latencyRows,
			last24Rows: latencyRows,
		});

		const result = await aggregateAuditLogStats({
			scope: { organizationId: "org-1", userId: null },
			latencyWindow: "1h",
		});

		expect(result.latencyWindow).toBe("1h");
		expect(result.latencySparkline).toHaveLength(12);
		// mean of [100, 200] = 150
		expect(result.averageLatencyMs).toBe(150);
		// The two buckets that received data should be > 0.
		const nonZeroBuckets = result.latencySparkline.filter((v) => v > 0);
		expect(nonZeroBuckets.length).toBeGreaterThanOrEqual(2);
	});

	it("returns 7 buckets for the 7d window", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-17T10:00:00Z"));

		setupHappyMocks({
			eventsToday: 0,
			failuresToday: 0,
			actorIds: [],
			sessionIds: [],
			latencyRows: [],
			last24Rows: [],
		});

		const result = await aggregateAuditLogStats({
			scope: { organizationId: "org-1", userId: null },
			latencyWindow: "7d",
		});

		expect(result.latencyWindow).toBe("7d");
		expect(result.latencySparkline).toHaveLength(7);
	});

	it("counts distinct sessionIds for the sessionsToday slot", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-17T10:00:00Z"));

		setupHappyMocks({
			eventsToday: 5,
			failuresToday: 0,
			actorIds: ["u-1", "u-2"],
			sessionIds: ["s-a", "s-b", "s-c"],
			latencyRows: [],
			last24Rows: [],
		});

		const result = await aggregateAuditLogStats({
			scope: { organizationId: "org-1", userId: null },
		});

		expect(result.sessionsToday).toBe(3);
		expect(result.uniqueActorsToday).toBe(2);
	});
});
