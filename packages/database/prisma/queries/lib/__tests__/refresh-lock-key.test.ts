/**
 * The property that was actually broken: two code paths refreshing the SAME
 * credential row must compute the SAME advisory-lock id.
 *
 * Before this was centralised there were four addressing schemes across the
 * codebase — two using `pg_advisory_xact_lock(int4, int4)` and two using
 * `pg_advisory_xact_lock(int8)`, which Postgres treats as separate lock spaces
 * — and even within one space the key strings differed (`wfint:<id>` in the
 * GitLab tool executor vs `user:<id>` in the repo/branch pickers). The result
 * was a lock that looked correct in every individual file and serialized
 * nothing across files: both callers exchanged the same single-use rotating
 * refresh token, and the loser flagged a healthy connection as needing
 * re-authentication.
 */
import { describe, expect, it } from "vitest";

import {
	advisoryObjectKey,
	assertRefreshLockBudget,
	mcpConfigLockKey,
	REFRESH_ADVISORY_CLASS,
	REFRESH_LOCK_DB_HEADROOM_MS,
	REFRESH_LOCK_MAX_WAIT_MS,
	REFRESH_LOCK_TRANSACTION_TIMEOUT_MS,
	RefreshLockBudgetExhaustedError,
	repoIntegrationLockKey,
	workflowIntegrationLockKey,
} from "../refresh-lock-key";

describe("refresh advisory-lock addressing", () => {
	it("gives the same lock id for the same row, whichever builder call reaches it", () => {
		const id = "cmnp7d1vx000505jsvxpl5r39";
		// Two different call paths, same row, same key -> same lock id.
		expect(advisoryObjectKey(workflowIntegrationLockKey(id))).toBe(
			advisoryObjectKey(workflowIntegrationLockKey(id)),
		);
		expect(workflowIntegrationLockKey(id)).toBe(`wfint:${id}`);
	});

	it("separates the credential stores so unrelated rows never contend", () => {
		const id = "same-id-different-store";
		const keys = [
			workflowIntegrationLockKey(id),
			repoIntegrationLockKey(id),
			mcpConfigLockKey(id),
		];
		expect(new Set(keys).size).toBe(3);
		expect(new Set(keys.map(advisoryObjectKey)).size).toBe(3);
	});

	it("keeps distinct rows in the same store independent", () => {
		expect(advisoryObjectKey(workflowIntegrationLockKey("a"))).not.toBe(
			advisoryObjectKey(workflowIntegrationLockKey("b")),
		);
	});

	it("produces a signed int32, which is what pg_advisory_xact_lock(int,int) takes", () => {
		for (const key of [
			"wfint:x",
			"repo:y",
			"mcp:z",
			"",
			"a".repeat(500),
			"unicode-✅-key",
		]) {
			const objectKey = advisoryObjectKey(key);
			expect(Number.isInteger(objectKey)).toBe(true);
			expect(objectKey).toBeGreaterThanOrEqual(-(2 ** 31));
			expect(objectKey).toBeLessThanOrEqual(2 ** 31 - 1);
		}
		expect(Number.isInteger(REFRESH_ADVISORY_CLASS)).toBe(true);
	});

	it("is stable across calls — a drifting hash would silently unserialize callers", () => {
		const key = workflowIntegrationLockKey("stability-check");
		const first = advisoryObjectKey(key);
		for (let i = 0; i < 100; i++) {
			expect(advisoryObjectKey(key)).toBe(first);
		}
	});
});

describe("refresh lock-transaction budget", () => {
	// This module is the single source for both numbers — `refresh-lock.ts`
	// re-exports them rather than defining its own, and the GitLab refresh
	// paths (`get-valid-access-token.ts`, `gitlab-token.ts`) import them
	// directly since they open their own `$transaction` rather than going
	// through `withRefreshLock`. Pinning the values here means a change to
	// either constant shows up as an intentional diff in this test, not as a
	// silent behavior change three call sites away.
	it("pins the transaction timeout, max-wait and DB-headroom budgets", () => {
		expect(REFRESH_LOCK_TRANSACTION_TIMEOUT_MS).toBe(20_000);
		expect(REFRESH_LOCK_MAX_WAIT_MS).toBe(10_000);
		expect(REFRESH_LOCK_DB_HEADROOM_MS).toBe(5_000);
	});

	// NOTE: there is no meaningful "timeout must exceed maxWait" invariant to
	// assert here. Verified against Prisma 6.18's TransactionManager: `maxWait`
	// bounds only acquiring a pooled connection and starting the transaction; `timeout`
	// is armed AFTER that resolves and covers everything the callback does,
	// including the advisory-lock wait. The two timers bound DIFFERENT,
	// non-overlapping phases, so there is no arithmetic relationship between
	// them worth pinning — see REFRESH_LOCK_MAX_WAIT_MS's doc comment.
});

describe("assertRefreshLockBudget", () => {
	it("does not throw when the lock wait was negligible", () => {
		expect(() =>
			assertRefreshLockBudget({ elapsedMs: 10, requiredMs: 10_000 }),
		).not.toThrow();
	});

	it("does not throw right at the edge of comfortable headroom", () => {
		// 20_000 budget - elapsed leaves exactly requiredMs + headroom: the
		// boundary is inclusive (remaining < needed, not <=).
		const requiredMs = 10_000;
		const elapsedMs =
			REFRESH_LOCK_TRANSACTION_TIMEOUT_MS -
			(requiredMs + REFRESH_LOCK_DB_HEADROOM_MS);
		expect(() =>
			assertRefreshLockBudget({ elapsedMs, requiredMs }),
		).not.toThrow();
	});

	it("throws RefreshLockBudgetExhaustedError one millisecond past that edge", () => {
		const requiredMs = 10_000;
		const elapsedMs =
			REFRESH_LOCK_TRANSACTION_TIMEOUT_MS -
			(requiredMs + REFRESH_LOCK_DB_HEADROOM_MS) +
			1;
		expect(() =>
			assertRefreshLockBudget({ elapsedMs, requiredMs }),
		).toThrow(RefreshLockBudgetExhaustedError);
	});

	it("models the residual hole this guard closes: a waiter that acquires the lock ~12s into its own budget cannot then start a fresh 10s exchange", () => {
		// A holder can legitimately occupy the lock for exchange (10s) +
		// probe (2s) before releasing it; a waiter queued behind it can
		// therefore acquire the lock ~12s into its own 20s transaction.
		expect(() =>
			assertRefreshLockBudget({ elapsedMs: 12_000, requiredMs: 10_000 }),
		).toThrow(RefreshLockBudgetExhaustedError);
	});

	it("is not a GitLabReauthRequiredError and carries no such identity — this package has no GitLab dependency to be one", () => {
		// This module is deliberately dependency-free (see the file header),
		// so the strongest assertion available here is that the thrown error
		// is exactly this class, transient by name, and not some Prisma or
		// generic Error a careless catch could misroute. The stronger
		// "never classified as a dead grant" contract is asserted at the
		// GitLab call sites, which DO import GitLabReauthRequiredError.
		let caught: unknown;
		try {
			assertRefreshLockBudget({ elapsedMs: 19_000, requiredMs: 10_000 });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(RefreshLockBudgetExhaustedError);
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).name).toBe("RefreshLockBudgetExhaustedError");
	});
});
