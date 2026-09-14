/**
 * Cross-process serialization for OAuth refresh-token exchanges.
 *
 * Every provider Fabric refreshes against — GitHub, GitLab, Notion, Atlassian —
 * rotates the refresh token single-use: the moment one exchange succeeds, the
 * token it consumed is dead. So two callers holding the same refresh token must
 * never exchange concurrently, or the loser gets `invalid_grant` and (worse)
 * some paths then persist `needsReauth` on a connection the winner had just
 * refreshed perfectly well.
 *
 * A module-level `Map` only serializes within ONE Node process. Fabric runs the
 * web app and the temporal worker as separate processes, and the worker can
 * scale to multiple replicas — so an in-process map is not serialization, it is
 * the appearance of it. This helper takes a Postgres advisory lock instead,
 * which every process on the same database shares.
 *
 * The exchange itself has to happen INSIDE the lock. Doing the HTTP call
 * outside and locking only the persist would let both callers spend the token,
 * which is the exact failure being prevented. That does mean a pool connection
 * is held for the duration of the provider round-trip, so the transaction
 * carries an explicit timeout rather than relying on the default.
 */
import { db } from "../../client";
import {
	advisoryObjectKey,
	assertRefreshLockBudget,
	REFRESH_ADVISORY_CLASS,
	REFRESH_LOCK_MAX_WAIT_MS,
	REFRESH_LOCK_TRANSACTION_TIMEOUT_MS,
} from "./refresh-lock-key";

export * from "./refresh-lock-key";

/**
 * Run `fn` holding a per-key Postgres advisory lock, serialized across every
 * process sharing this database.
 *
 * `fn` receives the transaction client so it can read-check-and-persist inside
 * the same lock — the re-read matters, because a caller that queued behind the
 * winner must see the winner's freshly rotated token rather than exchanging
 * again with the token it captured before waiting.
 *
 * MUST use `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock()` returns
 * `void`, which the Postgres driver adapter's `$queryRaw` cannot deserialize
 * ("Failed to deserialize column of type 'void'"). That throw previously
 * aborted every project-repo token refresh silently.
 *
 * `fn` receives a SECOND argument, `assertBudget`, a ready-made closure with
 * `lockStartedAt` baked in. It is OPTIONAL to call — every GitHub caller
 * ignores it today, deliberately: this guard is scoped to GitLab for now —
 * but calling it is the only correct way to enforce a budget, because only
 * `fn` knows where its own short-circuits are. A caller that queues behind a
 * winner and finds (via its own in-lock re-read) that there is no bounded
 * HTTP work left to do must be able to return without ever calling
 * `assertBudget`. Gating unconditionally right after the lock statement
 * instead — before `fn` gets a chance to short-circuit — would reject that
 * exact caller: it queued behind a holder's legitimate ~12s of work, only
 * needs to read the row the holder just persisted, and yet would be
 * rejected before it ever looked. `assertBudget(requiredMs)` should be
 * called by `fn` immediately before starting bounded work whose duration is
 * `requiredMs`, never earlier — see `assertRefreshLockBudget` for what it
 * checks.
 */
export async function withRefreshLock<T>(
	key: string,
	fn: (
		tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
		assertBudget: (requiredMs: number) => void,
	) => Promise<T>,
): Promise<T> {
	return db.$transaction(
		async (tx) => {
			// Measured from the first statement in the callback — the instant
			// closest to when Prisma arms the `timeout` timer. See
			// REFRESH_LOCK_MAX_WAIT_MS's comment: `maxWait` covers only the
			// pre-callback connection acquisition, so timing from before this
			// callback runs would wrongly charge that window against the
			// budget this guard protects.
			//
			// `performance.now()`, not `Date.now()`: this measures a DURATION,
			// and `Date.now()` is wall-clock — an NTP correction stepping the
			// clock backwards mid-transaction would make elapsed look smaller
			// than it really was and let the guard under-reject work it
			// should have refused. `performance.now()` is monotonic and never
			// steps backwards; the different epoch doesn't matter since only
			// the delta between two calls is ever used.
			const lockStartedAt = performance.now();
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFRESH_ADVISORY_CLASS}::int, ${advisoryObjectKey(key)}::int)`;
			const assertBudget = (requiredMs: number): void => {
				assertRefreshLockBudget({
					elapsedMs: performance.now() - lockStartedAt,
					requiredMs,
				});
			};
			return fn(tx, assertBudget);
		},
		{
			timeout: REFRESH_LOCK_TRANSACTION_TIMEOUT_MS,
			maxWait: REFRESH_LOCK_MAX_WAIT_MS,
		},
	);
}
