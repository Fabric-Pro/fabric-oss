/**
 * The single definition of how an OAuth-refresh advisory lock is addressed.
 *
 * Deliberately dependency-free — no Prisma client, no `db` import — so every
 * refresh implementation can share it regardless of whether it owns its own
 * transaction or borrows one. That matters because the alternative (forcing
 * everything through one `withRefreshLock` wrapper) would break the structural
 * `db` accessor abstraction the GitLab helper uses for testability.
 *
 * WHY THIS EXISTS: refresh locks were previously addressed four different ways.
 * Two used `pg_advisory_xact_lock(int4, int4)`, two used
 * `pg_advisory_xact_lock(int8)` — and Postgres treats those as SEPARATE lock
 * spaces, so they could never block each other. The GitLab personal connection
 * was the live casualty: `gitlab/index.ts` locked it as `wfint:<id>` in the
 * two-int space while the repo/branch pickers locked the SAME row as
 * `user:<id>` in the bigint space. Neither waited for the other, both spent the
 * same single-use rotating refresh token, and the loser flagged a healthy
 * connection as needing re-authentication.
 *
 * Two rules keep that fixed:
 *   1. every caller uses `REFRESH_ADVISORY_CLASS` + `advisoryObjectKey`, so all
 *      locks live in one space;
 *   2. the key comes from a builder below, so the same row is always addressed
 *      by the same string no matter which code path reaches it.
 */

/**
 * Advisory-lock class id namespacing OAuth refresh exchanges (arbitrary but
 * stable). Paired with a per-credential object key so refreshes of the SAME
 * credential serialize across every process, while different credentials stay
 * independent.
 */
export const REFRESH_ADVISORY_CLASS = 0x52674b; // "RgK"

/**
 * Stable signed-int32 hash (FNV-1a) of a key for the advisory-lock object id.
 *
 * Must stay byte-identical across callers: two paths that hash the same key
 * differently would land on different lock ids and silently stop serializing.
 */
export function advisoryObjectKey(id: string): number {
	let hash = 0x811c9dc5; // offset basis
	for (let i = 0; i < id.length; i++) {
		hash ^= id.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193); // FNV prime
	}
	return hash | 0; // coerce to signed int32
}

/**
 * Lock key for a personal/org connection (`WorkflowIntegration`) — the store
 * behind the workflow builder, repo pickers and agent tool calls.
 */
export function workflowIntegrationLockKey(integrationId: string): string {
	return `wfint:${integrationId}`;
}

/**
 * Lock key for a project-repository connection
 * (`ProjectRepositoryIntegration`) — the store behind cloning, indexing,
 * code search and scans.
 */
export function repoIntegrationLockKey(integrationId: string): string {
	return `repo:${integrationId}`;
}

/** Lock key for an MCP server credential (`MCPConfig`). */
export function mcpConfigLockKey(configId: string): string {
	return `mcp:${configId}`;
}

/**
 * Budget for a transaction that holds one of the advisory locks above WHILE
 * a provider token exchange runs inside it (see `refresh-lock.ts` and the
 * GitLab refresh paths, which inline the same shape rather than going
 * through `withRefreshLock`). Defined here rather than in `refresh-lock.ts`
 * for the same reason this whole module is dependency-free — see the header
 * above — every refresh implementation needs the SAME budget regardless of
 * whether it owns its own `$transaction` call or borrows one, and a caller
 * that computed its own number would drift from this one silently, exactly
 * the class of bug the lock-key unification above exists to prevent.
 *
 * INVARIANT: the exchange runs INSIDE the lock (doing the HTTP outside and
 * locking only the persist would let two callers both spend the same
 * single-use rotating refresh token — the exact failure this lock exists to
 * prevent), so this budget must exceed the bounded provider round-trip(s)
 * PLUS the in-transaction DB round-trips (the advisory-lock acquisition, the
 * re-read, the persist). A budget shorter than that sum does not fail
 * loudly: Prisma's own timer issues `ROLLBACK` at the deadline, releases the
 * advisory lock, and returns the connection to the pool while the JS
 * callback is still awaiting the HTTP call. The exchange can then still
 * succeed at the provider — rotating and killing the single-use refresh
 * token — while the persist fails, so the rotated token is lost, the
 * credential gets condemned on the very next call, and a second process can
 * enter the exchange window with the same now-dead token. Each call site
 * that uses this budget carries its own comment doing the specific
 * arithmetic (bounded HTTP calls + DB round-trips) against these numbers.
 */
export const REFRESH_LOCK_TRANSACTION_TIMEOUT_MS = 20_000;

/**
 * How long to wait for Prisma to acquire a POOLED CONNECTION and start the
 * interactive transaction (`driverAdapter.startTransaction()`) — nothing
 * more. Verified against Prisma 6.18's `TransactionManager`: `maxWait` is
 * armed around that call and cleared the instant it resolves; only THEN does
 * `timeout` get armed and the callback run. The `pg_advisory_xact_lock(...)`
 * statement is issued from INSIDE the callback (via `$executeRaw`), i.e.
 * after `maxWait`'s window has already closed — so a slow or contended
 * advisory-lock wait is charged entirely against `timeout`
 * (`REFRESH_LOCK_TRANSACTION_TIMEOUT_MS`), never against this constant —
 * `maxWait` does NOT cover "the lock itself"; see `assertRefreshLockBudget`
 * below for how the lock-wait time is actually accounted for.
 */
export const REFRESH_LOCK_MAX_WAIT_MS = 10_000;

/**
 * Allowance for the DB round-trips a locked-refresh transaction performs
 * around its bounded provider work: the advisory-lock statement(s) it just
 * ran, the re-read that decides whether a refresh is still needed, and the
 * persist that follows a successful exchange. These are simple, indexed
 * single-row operations — normally single-digit milliseconds — but this repo
 * runs on serverless Postgres, where the database can scale its compute down
 * to zero between bursts of traffic and a request that lands while it is
 * suspended pays a real, if occasional, cold-start/wake-up latency on top of
 * ordinary pool-connection acquisition. 5s is generous relative to the query
 * cost itself and is sized to absorb that class of hiccup without needing
 * its own investigation; treat a `RefreshLockBudgetExhaustedError` that
 * recurs outside real lock contention as evidence this number is too tight,
 * not too generous.
 */
export const REFRESH_LOCK_DB_HEADROOM_MS = 5_000;

/**
 * Thrown when a locked-refresh transaction, immediately before starting its
 * bounded provider work (after acquiring the advisory lock and after any
 * re-read/short-circuit that decided the work is still needed), determines
 * that too little of `REFRESH_LOCK_TRANSACTION_TIMEOUT_MS` remains to safely
 * start it (see `assertRefreshLockBudget`).
 *
 * TRANSIENT — NEVER a verdict about the credential. A holder can
 * legitimately occupy the lock for the full bounded-work window (e.g. a 10s
 * token exchange plus a 2s capability probe) before releasing it; a waiter
 * that queues behind that holder can acquire the lock with most of its own
 * budget already spent on the wait, and starting a fresh exchange it cannot
 * finish would reproduce the exact defect this budget exists to prevent —
 * Prisma rolls the transaction back and releases the lock mid-exchange while
 * GitLab may still honor it. Retrying (the lock is now free, or will be
 * shortly) is the correct response.
 *
 * Every caller MUST treat this the same way an abort/timeout is treated:
 * never `instanceof GitLabReauthRequiredError`, never routed into
 * `markNeedsReauth`/`markNeedsReauthOnTx`, never recorded as a provider
 * refresh failure.
 */
export class RefreshLockBudgetExhaustedError extends Error {
	constructor(message = "REFRESH_LOCK_BUDGET_EXHAUSTED") {
		super(message);
		this.name = "RefreshLockBudgetExhaustedError";
	}
}

/**
 * Guard against starting bounded provider work that the transaction's
 * REMAINING budget cannot fit, instead of trusting the fixed constants alone
 * to have left enough room.
 *
 * Call this immediately BEFORE the bounded HTTP work it guards — after the
 * advisory-lock statement(s), after the in-lock re-read that decides whether
 * a refresh is still needed, and after every short-circuit that returns
 * without touching the provider (an already-fresh token found by that
 * re-read, an unknown-expiry/PAT row with no refresh token to exchange, and
 * so on). NOT immediately after the lock statement(s): a caller that queues
 * behind a winner and finds, via its own re-read, that there is nothing left
 * to do must be able to return however long the lock wait was — gating
 * unconditionally right after the lock would reject exactly that caller,
 * which is the common case under contention, not the rare one. The
 * invariant this encodes: a path with no bounded HTTP work ahead of it is
 * never gated, and a path about to start bounded HTTP work always is.
 *
 * `elapsedMs` must still be measured from the FIRST statement inside the
 * `$transaction` callback regardless of where THIS call sits — that is the
 * instant closest to when Prisma arms the `timeout` timer (see
 * `REFRESH_LOCK_MAX_WAIT_MS` above: `maxWait` covers only the pre-callback
 * connection acquisition, so measuring any earlier would wrongly charge that
 * window against this budget). Only the call site moves; the measurement
 * origin does not. `requiredMs` is the bounded HTTP work the caller is about
 * to start (the token exchange alone, or exchange + probe).
 *
 * Throws `RefreshLockBudgetExhaustedError` when what remains of
 * `REFRESH_LOCK_TRANSACTION_TIMEOUT_MS` would not cover `requiredMs` plus
 * `REFRESH_LOCK_DB_HEADROOM_MS` of further in-transaction DB round-trips.
 */
export function assertRefreshLockBudget(args: {
	elapsedMs: number;
	requiredMs: number;
}): void {
	const remainingMs = REFRESH_LOCK_TRANSACTION_TIMEOUT_MS - args.elapsedMs;
	const neededMs = args.requiredMs + REFRESH_LOCK_DB_HEADROOM_MS;
	if (remainingMs < neededMs) {
		throw new RefreshLockBudgetExhaustedError(
			`Only ${remainingMs}ms left of the ${REFRESH_LOCK_TRANSACTION_TIMEOUT_MS}ms lock-transaction budget after ${args.elapsedMs}ms already spent in this transaction (the advisory-lock wait plus any re-read/short-circuit work ahead of this call) — need ${neededMs}ms (${args.requiredMs}ms bounded provider work + ${REFRESH_LOCK_DB_HEADROOM_MS}ms DB headroom). Transient: the lock was likely held by another refresh's own exchange; retry.`,
		);
	}
}
