import type { Prisma } from "../generated/client";

/**
 * How old a held PM create claim (`pmCreateClaimedAt`) must be before a
 * user's recovery (Link to existing item, Unlink & re-create) may clear it.
 *
 * The claim's holder may still send its create only while
 * `PM_CREATE_SEND_TIMEOUT_MS` (50s, in
 * `packages/temporal/src/activities/pm-integration/pm-create-claim.ts`) has
 * not run out, counted on its own monotonic clock from a start it takes
 * before it asks for the claim. Each place that sends a create under a claim
 * compares that clock with the deadline immediately before the request is
 * handed to `fetch`, and does not send past it. `pmCreateClaimedAt` is a
 * reading of the database clock taken after that start (`readDatabaseClock`,
 * by the claim write), and a recovery clears a claim only when the same
 * database clock reads at least this bound past it. So, for a holder still
 * running this code:
 *
 *   dispatch time <= holder start + ceiling   (the explicit check)
 *                 <= stamp + ceiling          (the stamp is read after the start)
 *                 <  stamp + this bound       (ceiling < bound)
 *                 <= the recovery's clear     (its WHERE, on the database clock)
 *
 * Assumptions: one database clock for the stamp and every recovery, which
 * does not jump backward and keeps real time; and a holder's monotonic
 * clock that does not run slow by more than the margin over 50s. The bound
 * is five minutes: 250s of margin past the ceiling for that, and for the gap
 * between Fabric handing a request to `fetch` and its bytes leaving the
 * process (connection setup, an event loop stall); nothing shortens that
 * gap, because the per-call abort does not reach a request already handed
 * to `fetch` on the HTTP and SSE MCP transports. A pinned test
 * (`packages/temporal/__tests__/pm-create-claim-recovery-bound.test.ts`)
 * fails if this falls to within two minutes of the send ceiling.
 *
 * Limits:
 * - Not covered: a worker or API process still running a previous app
 *   version during a rollout. Its create paths have no deadline check, so
 *   until it is gone a claim it holds can be cleared while it is still able
 *   to send; nothing in the code fences it out.
 * - The bound cannot recall a request the PM tool already received: one that
 *   completes on the tool's side after Fabric gave up on it still leaves an
 *   item Fabric did not link. The holder's link write is fenced on its own
 *   claim, so it does not land after a recovery cleared that claim.
 */
export const PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS = 5 * 60_000;

/**
 * The database clock (`SELECT now()`: the start of the transaction the
 * statement runs in). The stamp of a PM create claim and the recovery
 * cutoff are both read from it, so the two are compared on one clock.
 */
export async function readDatabaseClock(client: {
	$queryRaw: Prisma.TransactionClient["$queryRaw"];
}): Promise<Date> {
	const rows = await client.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
	const now = rows[0]?.now;
	if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
		throw new Error("Could not read the database clock");
	}
	return now;
}

/**
 * The newest `pmCreateClaimedAt` a recovery may clear: the database clock
 * minus `PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS`. One clock for every recovery
 * write, whichever process sends it. Read before the write it guards, so
 * the time that passes in between only makes the cutoff stricter.
 */
export async function pmCreateClaimRecoveryCutoff(client: {
	$queryRaw: Prisma.TransactionClient["$queryRaw"];
}): Promise<Date> {
	const now = await readDatabaseClock(client);
	return new Date(now.getTime() - PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS);
}

/**
 * The claim condition of a recovery write: the row holds exactly the claim
 * the caller read and, when that is a held claim, it was taken at or before
 * `cutoff`. A held claim with no `pmCreateClaimedAt` never matches (SQL
 * `NULL <= x` is not true), so it reads as too recent.
 */
export function recoverableClaimWhere(
	expectedClaimId: string | null,
	cutoff: Date,
): {
	pmCreateClaimId: string | null;
	pmCreateClaimedAt?: { lte: Date };
} {
	return expectedClaimId === null
		? { pmCreateClaimId: null }
		: {
				pmCreateClaimId: expectedClaimId,
				pmCreateClaimedAt: { lte: cutoff },
			};
}

/**
 * When a held claim taken at `claimedAt` becomes recoverable; `null` when
 * the time is unknown (no `pmCreateClaimedAt`).
 */
export function pmCreateClaimRecoverableAt(
	claimedAt: Date | null,
): Date | null {
	return claimedAt
		? new Date(claimedAt.getTime() + PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS)
		: null;
}
