/**
 * CLI reach records — the one authoritative write that says a CLI reached an
 * organization over MCP (Fizzy #2457, R2 and R32).
 *
 * Called only by the MCP runtime, at the point it has ALREADY decided a request
 * is legitimate: an API key whose owner is still a member, for the organization
 * the request actually resolved to. Nothing here re-derives that decision, and
 * nothing here may be keyed off a key's usage counter — both hosts stamp that
 * counter immediately after the secret matches, before the owner lookup and
 * before the membership check, so it counts requests that then return 401. See
 * the `OrganizationCliReach` model doc for why every other inference was wrong
 * in a reachable state.
 *
 * Two rows, deliberately not one:
 *
 *   - `OrganizationCliReach` is upserted per credential. It answers "is this
 *     organization connected *now*", by letting the reader ask whether any
 *     credential that reached it is still alive.
 *   - `OrganizationCliFirstReach` is created once per organization and never
 *     touched again, so the adoption funnel survives a later revocation.
 *
 * Only the second one's CREATION is the fact R25 cares about.
 * `firstReachForOrganization` in the result reports exactly that and nothing
 * else: true on exactly one call per organization, for the whole life of the
 * organization — that is a property of THIS ROW, guaranteed by the unique
 * index. The caller (`record-cli-reach.ts`) logs R25's first-reach event from
 * it, but that log line is a separate, best-effort action taken after this
 * function returns; it is at-most-once, not exactly-once — see that module for
 * why. Duplicates of the row are impossible; losses of the log line are not.
 */

import { db } from "../client";
import type { CliCredentialKind } from "../generated/client";

export interface RecordOrganizationCliReachParams {
	organizationId: string;
	/** Which key table `credentialId` lives in. */
	credentialKind: CliCredentialKind;
	/** The persisted id of the key row. Polymorphic — see the model doc. */
	credentialId: string;
}

export interface RecordOrganizationCliReachResult {
	/**
	 * Whether THIS call created the organization's first-reach row.
	 *
	 * True at most once per organization, ever. A second request — by the same
	 * credential or any other — refreshes `lastReachedAt` and leaves this false,
	 * which is what stops R25's first-reach event firing on every request.
	 */
	firstReachForOrganization: boolean;
}

/**
 * Record that a credential reached this organization over MCP.
 *
 * Idempotent under concurrency in both halves. The reach row upserts on
 * `(organizationId, credentialKind, credentialId)`. The first-reach row is
 * inserted with `createMany({ skipDuplicates: true })`, which Prisma compiles to
 * `INSERT ... ON CONFLICT DO NOTHING`. Postgres resolves that conflict
 * atomically at the unique index, so of two concurrent first requests exactly
 * one comes back with `count: 1` and the other with `count: 0` — never 1/1,
 * never 0/0. One row, ever, per organization — what the winning caller does
 * with that fact, including whether its log line survives to be observed, is
 * a separate question answered in `record-cli-reach.ts`.
 *
 * That exactly-one-winner property is the whole requirement, and an `upsert`
 * still cannot supply it: an upsert reports success to both racers, and R25's
 * funnel would double-count the first organization to connect from two
 * machines. `count` is simply the construct that reports the same winner
 * WITHOUT making an error the steady-state path. This function runs on every
 * authenticated MCP request, so the earlier bare `create` — whose caught P2002
 * was the normal outcome from an organization's second request onward — spent
 * the life of the deployment raising a genuine Postgres ERROR, logging it
 * server-side, and marshalling a Prisma exception, per request, to learn a fact
 * that `ON CONFLICT DO NOTHING` returns as an integer.
 *
 * The two writes stay SEQUENTIAL, and the order is load-bearing. Nobody waits
 * on them — the caller registers this as background work that outlives the
 * response — so overlapping them would buy no latency any client can observe,
 * while costing a second pooled connection on every request. What it would also
 * cost is the event: `Promise.all` does not cancel the sibling of a rejected
 * promise, so a reach upsert that failed alongside a first-reach insert that
 * succeeded would commit the row and still reject, and the caller would never
 * emit R25's event for an organization that can now never report a first reach
 * again. Upsert first means a failure there leaves the first-reach row unwritten
 * and the next request retries both.
 *
 * Throws only what the caller should log. Every caller is fire-and-forget: a
 * failure to record must never fail the request that was being recorded.
 */
export async function recordOrganizationCliReach({
	organizationId,
	credentialKind,
	credentialId,
}: RecordOrganizationCliReachParams): Promise<RecordOrganizationCliReachResult> {
	const now = new Date();

	await db.organizationCliReach.upsert({
		where: {
			organizationId_credentialKind_credentialId: {
				organizationId,
				credentialKind,
				credentialId,
			},
		},
		// `firstReachedAt` is deliberately absent from the update: this row's
		// first reach is set once by the create branch and never moves.
		create: {
			organizationId,
			credentialKind,
			credentialId,
			firstReachedAt: now,
			lastReachedAt: now,
		},
		update: { lastReachedAt: now },
		select: { id: true },
	});

	// `count` is the number of rows the statement actually inserted: 1 only for
	// the request that won the organization's first reach, 0 on every request
	// after it — the common case, and byte for byte what the loser of a
	// concurrent race sees. Not an error, and emphatically not a second event.
	const created = await db.organizationCliFirstReach.createMany({
		data: [{ organizationId, firstReachedAt: now }],
		skipDuplicates: true,
	});

	return { firstReachForOrganization: created.count === 1 };
}
