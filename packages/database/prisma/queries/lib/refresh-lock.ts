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
import { advisoryObjectKey, REFRESH_ADVISORY_CLASS } from "./refresh-lock-key";

export * from "./refresh-lock-key";

/** How long the exchange may hold the lock before the transaction gives up. */
const LOCK_TRANSACTION_TIMEOUT_MS = 20_000;
/** How long to wait for a connection + the lock itself. */
const LOCK_MAX_WAIT_MS = 10_000;

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
 */
export async function withRefreshLock<T>(
	key: string,
	fn: (
		tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
	) => Promise<T>,
): Promise<T> {
	return db.$transaction(
		async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFRESH_ADVISORY_CLASS}::int, ${advisoryObjectKey(key)}::int)`;
			return fn(tx);
		},
		{ timeout: LOCK_TRANSACTION_TIMEOUT_MS, maxWait: LOCK_MAX_WAIT_MS },
	);
}
