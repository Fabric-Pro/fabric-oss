/**
 * Unit tests for `withRefreshLock`'s `assertBudget` wiring.
 *
 * `withRefreshLock` itself is mocked away entirely in every GitLab/GitHub
 * consumer test (a plain pass-through that ignores lock timing), which is
 * exactly why the budget-guard wiring needs its own coverage here against
 * the REAL implementation: nothing exercising the mocked callers would ever
 * catch a regression in this file.
 *
 * `withRefreshLock` does NOT gate on its own — it hands `fn` a ready-made
 * `assertBudget(requiredMs)` closure (second callback argument) and leaves
 * the decision of WHERE to call it, and WHETHER to call it at all, entirely
 * to `fn`. That shape is deliberate: only `fn` knows where its own
 * short-circuits are, so `withRefreshLock` gating unconditionally right
 * after the lock statement would reject a caller that queued behind a
 * winner and, via its own in-lock re-read, finds there is no bounded HTTP
 * work left to do at all.
 *
 * Elapsed time is measured with `performance.now()`, a monotonic clock —
 * `vi.setSystemTime()` does NOT move it (verified against this project's
 * Vitest/Node combination: only `Date` and timer callbacks are tied to the
 * fake "now" that `setSystemTime` sets). Simulating a lock wait here
 * therefore uses `vi.advanceTimersByTime()`, which moves the fake clock's
 * `Date` AND `performance.now()` together, instead of `setSystemTime`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTransaction = vi.fn();

vi.mock("../../../client", () => ({
	db: {
		$transaction: (...args: unknown[]) => mockTransaction(...args),
	},
}));

describe("withRefreshLock", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.useRealTimers();
		mockTransaction.mockReset();
	});

	it("passes the standard timeout/maxWait transaction options and runs fn under the lock, in that order", async () => {
		// Order matters: this is what "under the lock" means. A double that
		// merely records both calls happened, without checking which came
		// first, would pass even if `fn` ran BEFORE the advisory-lock
		// statement — this array is what actually establishes the ordering.
		const callOrder: string[] = [];
		const executeRawSpy = vi.fn().mockImplementation(async () => {
			callOrder.push("lock");
			return 1;
		});
		mockTransaction.mockImplementation(
			async (cb: (tx: unknown) => Promise<unknown>) =>
				cb({ $executeRaw: executeRawSpy }),
		);

		const { withRefreshLock } = await import("../refresh-lock");
		const {
			REFRESH_LOCK_MAX_WAIT_MS,
			REFRESH_LOCK_TRANSACTION_TIMEOUT_MS,
		} = await import("../refresh-lock-key");

		// GitHub's shape today: a single-argument callback that never touches
		// the second (`assertBudget`) argument at all.
		const fn = vi.fn().mockImplementation(async () => {
			callOrder.push("fn");
			return "token";
		});
		const result = await withRefreshLock("wfint:x", fn);

		expect(result).toBe("token");
		expect(executeRawSpy).toHaveBeenCalledTimes(1);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(callOrder).toEqual(["lock", "fn"]);
		expect(mockTransaction.mock.calls[0][1]).toEqual({
			timeout: REFRESH_LOCK_TRANSACTION_TIMEOUT_MS,
			maxWait: REFRESH_LOCK_MAX_WAIT_MS,
		});
	});

	it("never gates a callback that doesn't call assertBudget — every GitHub caller's shape today", async () => {
		vi.useFakeTimers();
		const start = new Date(2026, 0, 1);
		vi.setSystemTime(start);

		mockTransaction.mockImplementation(
			async (cb: (tx: unknown) => Promise<unknown>) =>
				cb({
					$executeRaw: vi.fn().mockImplementation(async () => {
						// A lock wait that WOULD trip the guard if
						// assertBudget were called — proves this path is
						// really unguarded, not just that the wait happened
						// to be short.
						vi.advanceTimersByTime(15_000);
						return 1;
					}),
				}),
		);

		const { withRefreshLock } = await import("../refresh-lock");
		// Deliberately ignores the second argument.
		const fn = vi.fn().mockResolvedValue("token");
		const result = await withRefreshLock("wfint:x", fn);

		expect(result).toBe("token");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("hands fn a working assertBudget that throws RefreshLockBudgetExhaustedError when too little budget remains after the lock wait", async () => {
		vi.useFakeTimers();
		const start = new Date(2026, 0, 1);
		vi.setSystemTime(start);

		mockTransaction.mockImplementation(
			async (cb: (tx: unknown) => Promise<unknown>) =>
				cb({
					$executeRaw: vi.fn().mockImplementation(async () => {
						// Models a waiter that queued behind another holder's
						// own ~12s exchange-plus-probe and only now acquires
						// the lock, 15s into its own 20s transaction budget.
						vi.advanceTimersByTime(15_000);
						return 1;
					}),
				}),
		);

		const { withRefreshLock } = await import("../refresh-lock");
		const { RefreshLockBudgetExhaustedError } = await import(
			"../refresh-lock-key"
		);

		// Models a callback shaped like the GitLab call sites: it calls
		// assertBudget immediately before the bounded work it is about to
		// start (never reached here), not unconditionally on entry.
		const afterGuard = vi.fn();
		const fn = vi.fn(
			async (
				_tx: unknown,
				assertBudget: (requiredMs: number) => void,
			) => {
				// 10s of required work + budget already 15s spent leaves only
				// 5s, which cannot cover 10s of work plus the DB headroom.
				assertBudget(10_000);
				afterGuard();
				return "unreachable";
			},
		);

		await expect(withRefreshLock("wfint:x", fn)).rejects.toBeInstanceOf(
			RefreshLockBudgetExhaustedError,
		);
		expect(afterGuard).not.toHaveBeenCalled();
	});

	it("hands fn a working assertBudget that does not throw when comfortable budget remains after a short lock wait", async () => {
		vi.useFakeTimers();
		const start = new Date(2026, 0, 1);
		vi.setSystemTime(start);

		mockTransaction.mockImplementation(
			async (cb: (tx: unknown) => Promise<unknown>) =>
				cb({
					$executeRaw: vi.fn().mockImplementation(async () => {
						vi.advanceTimersByTime(500);
						return 1;
					}),
				}),
		);

		const { withRefreshLock } = await import("../refresh-lock");
		const fn = vi.fn(
			async (
				_tx: unknown,
				assertBudget: (requiredMs: number) => void,
			) => {
				assertBudget(10_000);
				return "token";
			},
		);

		const result = await withRefreshLock("wfint:x", fn);
		expect(result).toBe("token");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("bakes lockStartedAt into assertBudget from the FIRST statement in the callback, not from when assertBudget is called", async () => {
		// A callback that does some of its own (unbounded) work before ever
		// calling assertBudget must still have that earlier time charged
		// against the budget — otherwise a callback could dodge the guard by
		// simply delaying the call.
		vi.useFakeTimers();
		const start = new Date(2026, 0, 1);
		vi.setSystemTime(start);

		mockTransaction.mockImplementation(
			async (cb: (tx: unknown) => Promise<unknown>) =>
				cb({
					$executeRaw: vi.fn().mockResolvedValue(1),
				}),
		);

		const { withRefreshLock } = await import("../refresh-lock");
		const { RefreshLockBudgetExhaustedError } = await import(
			"../refresh-lock-key"
		);

		const fn = vi.fn(
			async (
				_tx: unknown,
				assertBudget: (requiredMs: number) => void,
			) => {
				// The lock statement itself was instantaneous (no wait
				// simulated above); this models the callback doing its OWN
				// 15s of work before reaching the exchange.
				vi.advanceTimersByTime(15_000);
				assertBudget(10_000);
				return "unreachable";
			},
		);

		await expect(withRefreshLock("wfint:x", fn)).rejects.toBeInstanceOf(
			RefreshLockBudgetExhaustedError,
		);
	});
});
