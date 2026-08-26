/**
 * Tests for the `audit.stats` procedure handler.
 *
 * Same pattern as list.test.ts — call the handler directly and assert
 * that the aggregator is invoked with the resolved scope (org vs
 * personal). Tenant XOR is enforced by the scope resolver; we verify by
 * asserting `scope.organizationId` / `scope.userId` in the call args.
 *
 * v2 item 5 expectation: the handler also forwards `latencyWindow` and
 * surfaces `averageLatencyMs`, `latencySparkline`, `sessionsToday`,
 * `latencyWindow` on the response.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	aggregateAuditLogStats: vi.fn(),
	recordAudit: vi.fn(),
	getTrustedClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		aggregateAuditLogStats: mocks.aggregateAuditLogStats,
		recordAudit: mocks.recordAudit,
	};
});

vi.mock("@repo/auth/lib/client-ip", () => ({
	getTrustedClientIp: mocks.getTrustedClientIp,
}));

vi.mock("@repo/observability", () => ({
	auditWriteFailures: { inc: vi.fn() },
	auditWritesTotal: { inc: vi.fn() },
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class {},
}));

import { getAuditStatsProcedure } from "../procedures/stats";

function makeContext() {
	return {
		user: {
			id: "user-1",
			email: "alice@example.com",
			name: "Alice",
		},
		session: { id: "session-1" },
		headers: new Headers(),
	};
}

const handler = (
	getAuditStatsProcedure as unknown as {
		"~orpc": {
			handler: (args: {
				context: ReturnType<typeof makeContext>;
				input: Record<string, unknown>;
			}) => Promise<unknown>;
		};
	}
)["~orpc"].handler;

function statsPayload(over: Record<string, unknown> = {}) {
	return {
		eventsToday: 0,
		failuresToday: 0,
		uniqueActorsToday: 0,
		lastEventAt: null,
		topAction: null,
		hourlyVolume: Array.from({ length: 24 }, () => 0),
		sessionsToday: 0,
		averageLatencyMs: null,
		latencySparkline: Array.from({ length: 24 }, () => 0),
		latencyWindow: "24h" as const,
		...over,
	};
}

beforeEach(() => {
	mocks.aggregateAuditLogStats.mockReset();
});

describe("audit.stats handler", () => {
	it("invokes the aggregator with the org scope when organizationId is provided", async () => {
		mocks.aggregateAuditLogStats.mockResolvedValue(
			statsPayload({
				eventsToday: 12,
				failuresToday: 1,
				uniqueActorsToday: 3,
				lastEventAt: new Date("2026-05-16T10:00:00Z"),
				topAction: { action: "auth.login.success", count: 7 },
				sessionsToday: 4,
				averageLatencyMs: 42.5,
				latencySparkline: Array.from({ length: 24 }, () => 25),
				latencyWindow: "24h",
			}),
		);

		const result = (await handler({
			context: makeContext(),
			input: { organizationId: "org-1" },
		})) as {
			eventsToday: number;
			failuresToday: number;
			uniqueActorsToday: number;
			lastEventAt: Date | null;
			topAction: { action: string; count: number } | null;
			hourlyVolume: number[];
			sessionsToday: number;
			averageLatencyMs: number | null;
			latencySparkline: number[];
			latencyWindow: string;
		};

		expect(result.eventsToday).toBe(12);
		expect(result.failuresToday).toBe(1);
		expect(result.uniqueActorsToday).toBe(3);
		expect(result.topAction).toEqual({
			action: "auth.login.success",
			count: 7,
		});
		expect(result.hourlyVolume).toHaveLength(24);
		expect(result.sessionsToday).toBe(4);
		expect(result.averageLatencyMs).toBe(42.5);
		expect(result.latencySparkline).toHaveLength(24);
		expect(result.latencyWindow).toBe("24h");
		expect(mocks.aggregateAuditLogStats).toHaveBeenCalledTimes(1);
		const call = mocks.aggregateAuditLogStats.mock.calls[0]?.[0] as {
			scope: { organizationId: string | null; userId: string | null };
			latencyWindow?: string;
		};
		expect(call.scope.organizationId).toBe("org-1");
		expect(call.scope.userId).toBeNull();
	});

	it("scopes the aggregator to the caller's user id when organizationId is null", async () => {
		mocks.aggregateAuditLogStats.mockResolvedValue(statsPayload());

		await handler({
			context: makeContext(),
			input: { organizationId: null },
		});

		const call = mocks.aggregateAuditLogStats.mock.calls[0]?.[0] as {
			scope: { organizationId: string | null; userId: string | null };
		};
		expect(call.scope.organizationId).toBeNull();
		expect(call.scope.userId).toBe("user-1");
	});

	it("propagates a null lastEventAt and topAction", async () => {
		mocks.aggregateAuditLogStats.mockResolvedValue(statsPayload());

		const result = (await handler({
			context: makeContext(),
			input: { organizationId: "org-1" },
		})) as {
			lastEventAt: Date | null;
			topAction: { action: string; count: number } | null;
			hourlyVolume: number[];
		};

		expect(result.lastEventAt).toBeNull();
		expect(result.topAction).toBeNull();
		expect(result.hourlyVolume).toEqual(
			Array.from({ length: 24 }, () => 0),
		);
	});

	it("forwards latencyWindow to the aggregator (item 5)", async () => {
		mocks.aggregateAuditLogStats.mockResolvedValue(
			statsPayload({
				latencyWindow: "7d",
				latencySparkline: Array.from({ length: 7 }, () => 0),
			}),
		);

		await handler({
			context: makeContext(),
			input: { organizationId: "org-1", latencyWindow: "7d" },
		});

		const call = mocks.aggregateAuditLogStats.mock.calls[0]?.[0] as {
			scope: { organizationId: string | null; userId: string | null };
			latencyWindow?: string;
		};
		expect(call.latencyWindow).toBe("7d");
	});
});
