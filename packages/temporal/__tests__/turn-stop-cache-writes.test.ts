/**
 * Cache writes a chat turn's tools make check the turn's stop immediately
 * before the write, after the reads that precede it: the Letta tool-result
 * cache (after its rate-limit check and the read of the current block) and
 * the Redis cache (after its client lookup). The turn's dispatch guard is the
 * real one (`runWithTurnDispatch`) in an activity context, cancelled during
 * that preceding read.
 */

import { CancelledFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	during: {} as Record<string, (() => void) | undefined>,
	validateLettaOperation: vi.fn(),
	getMemoryBlock: vi.fn(),
	updateMemoryBlock: vi.fn(),
	getRedisClient: vi.fn(),
	redisSet: vi.fn(),
	redisDel: vi.fn(),
}));

async function reading<T>(name: string, value: T): Promise<T> {
	await Promise.resolve();
	h.during[name]?.();
	return value;
}

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: vi.fn(async () => ({ ok: true })),
	reserveConversationTurnAttempt: vi.fn(),
	settleConversationTurnAttempt: vi.fn(),
	getConversationTurnLedgerSnapshot: vi.fn(async () => null),
}));

vi.mock("@repo/letta", () => ({
	getLettaClient: () => ({
		getMemoryBlock: h.getMemoryBlock,
		updateMemoryBlock: h.updateMemoryBlock,
	}),
}));

vi.mock("../src/activities/letta-security", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../src/activities/letta-security")
	>()),
	validateLettaOperation: h.validateLettaOperation,
	logSecurityEvent: vi.fn(),
}));

vi.mock("../src/lib/redis-publisher", () => ({
	getRedisClient: h.getRedisClient,
}));

const { cacheToolResult } = await import(
	"../src/activities/letta-memory-activities"
);
const { RedisCache } = await import("../src/lib/redis-cache");
const { runWithTurnDispatch } = await import(
	"../src/activities/orchestrator/turn-dispatch"
);

const SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-00000000-0000-4000-8000-000000000001",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

async function inTurn(
	cancelDuring: string | undefined,
	work: () => Promise<unknown>,
): Promise<unknown> {
	const env = new MockActivityEnvironment();
	if (cancelDuring) {
		h.during[cancelDuring] = () => env.cancel();
	}
	return env
		.run(() => runWithTurnDispatch(SCOPE, work))
		.then(
			(value) => ({ resolvedWith: value }),
			(error: unknown) => error,
		);
}

const ORIGINAL_LETTA_URL = process.env.LETTA_BASE_URL;

beforeEach(() => {
	h.during = {};
	process.env.LETTA_BASE_URL = "https://letta.example.com";
	for (const mock of [
		h.validateLettaOperation,
		h.getMemoryBlock,
		h.updateMemoryBlock,
		h.getRedisClient,
		h.redisSet,
		h.redisDel,
	]) {
		mock.mockReset();
	}
	h.validateLettaOperation.mockImplementation(() =>
		reading("rate-limit check", { valid: true }),
	);
	h.getMemoryBlock.mockImplementation(() =>
		reading("cache block read", { value: "{}" }),
	);
	h.updateMemoryBlock.mockResolvedValue(undefined);
	h.getRedisClient.mockImplementation(() =>
		reading("client lookup", { set: h.redisSet, del: h.redisDel }),
	);
	h.redisSet.mockResolvedValue("OK");
	h.redisDel.mockResolvedValue(1);
});

afterEach(() => {
	process.env.LETTA_BASE_URL = ORIGINAL_LETTA_URL;
});

const cacheResult = () =>
	cacheToolResult({
		lettaAgentId: "letta-agent-example-1",
		userId: SCOPE.userId,
		organizationId: SCOPE.organizationId,
		toolName: "list_issues",
		toolArgs: { state: "open" },
		result: { issues: [] },
		durationMs: 12,
		success: true,
	});

describe("the Letta tool-result cache inside a chat turn", () => {
	it("writes the block when nothing stops the turn", async () => {
		await inTurn(undefined, cacheResult);
		expect(h.updateMemoryBlock).toHaveBeenCalledTimes(1);
	});

	it.each(["rate-limit check", "cache block read"])(
		"writes nothing when the activity is cancelled during the %s, and does not swallow the stop",
		async (step) => {
			const outcome = await inTurn(step, cacheResult);
			expect(outcome).toBeInstanceOf(CancelledFailure);
			expect(h.updateMemoryBlock).not.toHaveBeenCalled();
		},
	);
});

describe("the Redis cache inside a chat turn", () => {
	const set = () => RedisCache.set("example-key", { value: 1 }, 60);

	it("writes when nothing stops the turn", async () => {
		await inTurn(undefined, set);
		expect(h.redisSet).toHaveBeenCalledTimes(1);
	});

	it("writes nothing when the activity is cancelled during the client lookup", async () => {
		const outcome = await inTurn("client lookup", set);
		expect(outcome).toBeInstanceOf(CancelledFailure);
		expect(h.redisSet).not.toHaveBeenCalled();
	});

	it("rejects with the stop, so the caller's next statement is not reached", async () => {
		let reached = false;
		let helperError: unknown;
		const outcome = await inTurn("client lookup", async () => {
			try {
				await set();
				reached = true;
			} catch (error) {
				helperError = error;
				throw error;
			}
		});
		expect(outcome).toBeInstanceOf(CancelledFailure);
		// The helper itself failed with the stop: not only the activity's
		// completion backstop.
		expect(helperError).toBeInstanceOf(CancelledFailure);
		expect(reached).toBe(false);
		expect(h.redisSet).not.toHaveBeenCalled();
	});

	it("deletes nothing after a stop, and rejects with it", async () => {
		let reached = false;
		const outcome = await inTurn("client lookup", async () => {
			await RedisCache.del("example-key");
			reached = true;
		});
		expect(outcome).toBeInstanceOf(CancelledFailure);
		expect(reached).toBe(false);
		expect(h.redisDel).not.toHaveBeenCalled();
	});

	it("still never fails its caller on an ordinary Redis error", async () => {
		h.redisSet.mockRejectedValueOnce(new Error("connection reset"));
		const outcome = await inTurn(undefined, async () => {
			await set();
			return "next statement ran";
		});
		expect(outcome).toEqual({ resolvedWith: "next statement ran" });
	});
});
