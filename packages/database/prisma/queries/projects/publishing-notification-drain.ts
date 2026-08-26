import { randomUUID } from "node:crypto";
import { db, type Prisma } from "../../client";
import {
	PUBLISHING_DELIVERY_ATTEMPT_BOUND,
	PUBLISHING_EMAIL_LEASE_MS,
	type PublishingEmailFailureReason,
	publishingEmailClaimableSql,
} from "./publishing-notification-delivery";
import { PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND } from "./publishing-notification-reconcile";

/**
 * Publishing Suite 1C-2d-2b-2 — the reconciliation sweep's pass 3, the DRAIN.
 * Fizzy #2213.
 *
 * ## What is here, and why it is its own module
 *
 * Everything the drain needs to decide WHICH deferred obligation to act on and
 * to TAKE it: the keyset page and its residual probe, the atomic claim that
 * increments the attempt count, the at-bound discharge that rides on the claim's
 * refusal, the release that returns a failed send to the deferral lifecycle, and
 * the row-scoped refusal a gate writes.
 *
 * THE LAYERING IS ONE-WAY AND THAT IS WHY THIS FILE EXISTS. It imports from
 * `publishing-notification-delivery` (the claim predicate, the bound, the lease)
 * AND from `publishing-notification-reconcile` (the at-bound reason, whose second
 * writer is below). The reconcile module already imports the delivery one, so
 * putting these writers in the delivery module — where they would sit beside the
 * primary path's claim, which is the readable place for them — would close a
 * cycle: delivery -> reconcile -> delivery. A third module keeps every edge
 * pointing the same way.
 *
 * ## Why the page is a frozen string
 *
 * THE STATUS MUST BE A SQL LITERAL, NEVER A BIND PARAMETER. A partial index is
 * usable only where the query's predicate provably IMPLIES the index predicate,
 * and a generic plan -- the one PostgreSQL builds with no parameter values in
 * hand -- has nothing with which to prove "status" = $1 implies = 'DEFERRED'.
 * The drain index leaves the planner's search space and the page becomes a
 * sequential scan of the whole ledger, which is exactly the state the backlog
 * this pass exists for makes worst. Same requirement, same reason, as the sweep's
 * own statements and as 20260815120200_..._deferral_indexes/migration.sql:117.
 *
 * That requirement is only enforceable if the string the tests read is the string
 * this module executes, so the statement is a module-level constant and the suite
 * asserts on exactly that constant. Every runtime value is a bind parameter; no
 * caller value is ever interpolated.
 *
 * ## What is NOT here
 *
 * The mail-configuration gate, the per-row authorization gates and the send.
 * Those are the activity's (packages/temporal/.../drain-deferred-notifications.ts):
 * this package must not know that mail exists, and @repo/database must not depend
 * on the worker.
 */

/** Rows examined per page. Bounded work: longer means wedged. */
export const PUBLISHING_DRAIN_BATCH_SIZE = 100;

/**
 * Pages per run. 100 x 2 = 200 rows per run, 4,800 per day at the hourly cadence.
 *
 * DERIVED FROM THE WORKFLOW'S REMAINING TIME BUDGET, NOT COPIED FROM THE PARENT
 * DESIGN'S 100/20 -- and the difference is a correction rather than a preference.
 * That document specifies, for ONE workflow, a 45-minute execution timeout, two
 * minutes per batch, three attempts and a 20-batch budget. Twenty batches at two
 * minutes with three attempts is 120 minutes against a 45-minute bound, and the
 * two passes that ship today have already spent 30 minutes 12 seconds of it
 * (two activities x 5 minutes x 3 attempts, plus 2 s + 4 s of backoff each). The
 * four numbers have never been reconcilable; nothing surfaced it because nothing
 * had ever run this pass.
 *
 * What is left is 14 minutes 48 seconds, and the drain's proxy takes 3 minutes x
 * 3 attempts = 9 minutes 6 seconds of it, leaving 5 minutes 42 seconds of margin.
 * A healthy full run must sit at least 3x inside the 3-minute bound, which is
 * what sets this number: a page is 100 rows, each costing one claim transaction,
 * three authorization reads and one provider call, and the provider call is the
 * only term that is not local.
 *
 * MEASURED, WITH THE UNMEASURED TERM NAMED. On postgres:16 (16.14) over a local
 * socket, with the provider stubbed at zero latency, a full run of this budget --
 * 200 rows -- completes in UNDER 5.3 seconds INCLUDING the fixture that seeds 201
 * rows in the same case, so 5.3 s is an upper bound on the drain's own local cost
 * and the true figure is lower. Against a 180-second activity bound that is more
 * than 30x.
 *
 * THE PROVIDER LATENCY IS THE TERM THAT DECIDES, and it cannot be measured here.
 * At 250 ms per send, 200 rows is ~50 s and the run sits ~3.3x inside the bound,
 * which satisfies the rule. At 500 ms it is ~100 s and 1.7x, which does NOT --
 * and that is the trigger to cut this number rather than to raise the timeout,
 * because the timeout's ceiling is the schedule's and the schedule is create-only.
 * An operator seeing `moreWorkRemains` stay true across consecutive ticks is
 * seeing the same thing from the other side.
 *
 * WHAT THE CUT COSTS, said plainly: 200 per run is 67,200 across the 14-day
 * expiry window, still far above any plausible backlog of email-only recipients,
 * and the sweep CONVERGES across ticks rather than losing anything -- the cursor
 * is ephemeral, every run re-walks from the head of the order, and the
 * oldest-deadline-first rule means the rows nearest their deadline are always
 * served first. A backlog this cannot keep up with is REPORTED through
 * `moreWorkRemains`, not inferred.
 */
export const PUBLISHING_DRAIN_MAX_BATCHES = 2;

/**
 * The cursor: `("expiresAt", "id")` of the last row the previous page returned.
 *
 * BOTH COMPONENTS ARE IMMUTABLE FOR THE LIFE OF A ROW, which is what makes a
 * keyset cursor valid here at all -- it stays correct when a claimed row changes
 * status and drops out of the page predicate, which is what happens to every row
 * a run succeeds on. `id` breaks ties so the order is total and the cursor can
 * never stall on a duplicate `expiresAt`.
 */
export interface DrainCursor {
	expiresAt: Date;
	id: string;
}

/**
 * The start of the order, and the reason it is a value rather than a second
 * statement.
 *
 * A `NULL`-or-cursor statement would need either two SQL strings or a
 * `COALESCE`, and both cost a guard: two strings means the suite pins one and the
 * executor runs the other on the first page of every run. One statement with a
 * sentinel below every real key keeps the page the tests read identical to the
 * page production runs, on page one and on page two alike.
 *
 * THE EPOCH IS BELOW EVERY REACHABLE VALUE, not merely below the ones seen so
 * far: `expiresAt` on a deferral is stamped at creation plus the deferral window,
 * so it is always in the future relative to a row that exists at all, and the
 * ledger's oldest row postdates the table's own migration. The empty string is
 * below every cuid. A case asserts the very first row of a seeded set is
 * returned, so the claim is tested rather than argued.
 */
export const PUBLISHING_DRAIN_CURSOR_START: DrainCursor = {
	expiresAt: new Date(0),
	id: "",
};

/**
 * One page of deferred obligations, oldest deadline first.
 *
 * ORDER BY URGENCY, NEVER BY RECENCY, and this is a fairness rule rather than an
 * implementation detail. `ORDER BY "id"` looks equivalent -- for a cuid it is
 * approximately creation order -- and is the starvation bug: a run at its page
 * ceiling would process newer rows repeatedly while the oldest sit behind the cap
 * and reach EXPIRED with the mail key already restored. The mechanism built to
 * prevent loss would then lose exactly the obligations that had waited longest,
 * and it would only appear after an outage long enough to exceed the cap.
 *
 * MEASURED on postgres:16 (16.14 -- the CI image), with both shipped partial
 * indexes present:
 *
 *   Limit  Buffers: shared hit=<= BATCH_SIZE + a small index descent>
 *     ->  Index Scan using publishing_notification_delivery_deferred_drain_idx
 *           Index Cond: (ROW("expiresAt", id) > ROW($1, $2))
 *
 * THE BOUND IS THE PAGE, AND IT HOLDS AT EVERY BACKLOG SIZE. That is the bar the
 * parent design sets for shipping this at all, and it is what decided against
 * widening the sweep's own expiry statement with an `OR` to carry the at-bound
 * arm -- which took THAT statement from 2 buffers constant to 377 at 30,000 rows
 * and rising with the population.
 *
 * TWO CORRECTIONS TO EARLIER DRAFTS OF THIS COMMENT, both recorded rather than
 * quietly replaced, because each is a way a measurement can flatter itself:
 *
 *   `Index Scan`, NOT `Index Only Scan`. The three-buffer reading came from a
 *   probe selecting `"id"` alone, which the index covers. The real statement
 *   projects the tenant tuple and the cycle, none of which is in the index key,
 *   so it visits the heap once per row. A MEASUREMENT TAKEN ON A SIMPLIFIED
 *   STATEMENT IS NOT A MEASUREMENT OF THE STATEMENT.
 *
 *   The heap visits are bounded by the PAGE, not fixed at a number. An earlier
 *   draft wrote "seven buffers at both sizes" from a fixture whose rows were
 *   inserted in expiry order, so the first hundred shared a handful of heap
 *   pages. Interleave two populations -- which is what a real ledger does, since
 *   deferrals arrive from different cycles at different times -- and those
 *   hundred rows sit on up to a hundred different pages. The number moves; the
 *   BOUND does not, and the bound is what the design needs. Asserting the number
 *   would have pinned an artefact of the fixture's physical order.
 *
 * Making the page index-only would take a covering index and a migration, to
 * save at most one buffer per row of one page per tick.
 *
 * The casts are not decoration: without them PostgreSQL cannot infer the ROW
 * constructor's types from two untyped parameters, and the statement fails to
 * prepare rather than planning badly.
 */

// NO CHANNEL TERM IN THIS FILE'S SCANNING STATEMENTS, and that is licensed
// rather than overlooked -- the same licence PUBLISHING_RECLAIM_STATEMENTS
// records, and it carries the same obligation, which until now was written down
// only there and in a JSON entry that has since been deleted.
//
// publishing_notification_delivery_leased_channel confines SENDING, DEFERRED and
// EXPIRED to the EMAIL channel, so `status = 'DEFERRED'` already means "an email
// obligation" and asking again would only cost.
//
// NO COUNT HERE ON PURPOSE. The header of 20260818120000 asserted "three of the
// four readers select by status alone -- only the drain page names a channel",
// and BOTH halves were wrong: the drain page names no channel, and the readers
// are not four. A tally in a comment is a claim that rots the next time a
// statement is added, and one already had. What is stable is the shape: the two
// statements that CHOOSE ROWS by walking the ledger -- the page below and its
// LIMIT-1 remaining probe -- select on status alone, as do the row-keyed
// transitions that follow them. The single statement here that names a channel
// is recordPublishingDeferredEmailFailure, and there it is not a safety term
// either. Its WHERE is five terms, and they split cleanly in two: the unique-key
// triple (cycleId, recipientUserId, channel), which ADDRESSES exactly one row
// because that triple is the table's unique index; and claimToken plus
// status = 'SENDING', which are the LEASE FENCE -- only the holder of the current
// claim may move the row. Channel appears because it is part of the row's
// identity, not because the statement is asking what the row is for.
//
// THE OBLIGATION THAT CREATES: a slice that widens that constraint for a second
// leased channel MUST come back here, and this file is the worse of the two
// places to forget. The reclaim statements would mis-sweep the new channel's
// rows; THESE would page them, claim them, increment their attempt count and
// hand them to the send path -- mail delivered to a recipient on a channel the
// row says is not email. Nothing in any candidate SELECT ever asked what the row
// is for.
//
// AND THE WIDENING IS A DROP-AND-RE-ADD, not a VALIDATE. The constraint was
// validated against every existing row by
// 20260820120000_validate_publishing_notification_delivery_leased_channel; a
// slice that admits a second channel replaces the predicate rather than
// extending it, and the replacement is `NOT VALID` again with its own entry in
// prisma/pending-constraint-validations.json. That instruction previously lived
// in that entry's `validatesIn` field, which the validating slice deleted -- so
// it is restated here, beside the statements that depend on it, where deleting
// it would take deleting the code it guards.
export const PUBLISHING_DRAIN_PAGE_SQL = `SELECT "id", "cycleId", "projectId", "organizationId", "userId",
       "recipientUserId", "expiresAt", "attemptCount"
  FROM "publishing_notification_delivery"
 WHERE "status" = 'DEFERRED'
   AND ("expiresAt", "id") > ($1::timestamp, $2::text)
 ORDER BY "expiresAt" ASC, "id" ASC
 LIMIT ${PUBLISHING_DRAIN_BATCH_SIZE}`;

/**
 * The same predicate, `LIMIT 1`, asked once per run and only when the run spent
 * its whole page budget.
 *
 * Spending the budget does NOT mean a backlog exists. A run whose last page was
 * short and a run whose backlog was exactly the budget both end with
 * `batches === MAX` and nothing left to do. Reading "more work remains" out of
 * that is an inference and it is wrong at both boundaries; this replaces the
 * inference with a fact, at the cost of one index-reaching `LIMIT 1`.
 *
 * ASKED FROM THE FINAL CURSOR, not from the start of the order: the question is
 * whether anything is left BEHIND this run, and the rows ahead of the cursor are
 * the ones it already handled.
 */
export const PUBLISHING_DRAIN_REMAINING_SQL = `SELECT 1
  FROM "publishing_notification_delivery"
 WHERE "status" = 'DEFERRED'
   AND ("expiresAt", "id") > ($1::timestamp, $2::text)
 LIMIT 1`;

/**
 * One deferred obligation, as the page returns it.
 *
 * The tenant tuple rides along because the drain's first gate re-asserts it and a
 * second read would be a second snapshot. `attemptCount` rides along for the
 * telemetry rather than for a decision -- the decision is inside the claim, which
 * is the whole of the atomicity requirement.
 */
export interface DeferredEmailRow {
	id: string;
	cycleId: string;
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	recipientUserId: string;
	expiresAt: Date;
	attemptCount: number;
}

export async function readDeferredPublishingEmailPage(
	cursor: DrainCursor,
	client: Prisma.TransactionClient = db,
): Promise<DeferredEmailRow[]> {
	return (await client.$queryRawUnsafe(
		PUBLISHING_DRAIN_PAGE_SQL,
		cursor.expiresAt,
		cursor.id,
	)) as DeferredEmailRow[];
}

export async function deferredPublishingEmailWorkRemains(
	cursor: DrainCursor,
	client: Prisma.TransactionClient = db,
): Promise<boolean> {
	const rest = (await client.$queryRawUnsafe(
		PUBLISHING_DRAIN_REMAINING_SQL,
		cursor.expiresAt,
		cursor.id,
	)) as unknown[];
	return rest.length > 0;
}

/**
 * Why a deferred obligation was terminalized without being sent.
 *
 * A CLOSED SET, because later slices bind to these strings and `reason` is free
 * text at the schema level -- no CHECK constrains it, so these constants ARE the
 * enforcement, and a typo in one is invisible to the type system. Every case
 * asserts the value it wrote.
 *
 * THE AT-BOUND DISCHARGE IS DELIBERATELY NOT HERE. It reuses
 * PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND, imported above: it is the same fact
 * about the same column, written by a second writer. Two constants carrying one
 * free-text value is a divergence nothing would catch.
 */
export const PUBLISHING_DEFERRED_SKIP_TENANT_CHANGED =
	"RECONCILE_TENANT_CHANGED";
export const PUBLISHING_DEFERRED_SKIP_NOTIFICATIONS_OFF =
	"RECONCILE_NOTIFICATIONS_DISABLED";
export const PUBLISHING_DEFERRED_SKIP_UNAUTHORIZED =
	"RECONCILE_RECIPIENT_UNAUTHORIZED";
/**
 * DELIBERATELY THE SAME STRING the primary path already writes for this
 * situation (`PublishingDeliverySkipReason`'s `NO_EMAIL_ADDRESS`), and not a
 * `RECONCILE_`-prefixed sibling.
 *
 * The other three reasons carry the prefix because they name a decision only the
 * reconciler can take -- it is the only writer that re-reads a tenant, a kill
 * switch or a permission days after the obligation was recorded, so an operator
 * grouping by `reason` wants those separable from anything the in-band path
 * wrote. This one is the same FACT about the same recipient, discovered by a
 * different reader: the account has no address. Two spellings of it would split
 * one population across two rows of a report for no reason anybody could act on.
 */
export const PUBLISHING_DEFERRED_SKIP_NO_ADDRESS = "NO_EMAIL_ADDRESS";

export type PublishingDeferredSkipReason =
	| typeof PUBLISHING_DEFERRED_SKIP_TENANT_CHANGED
	| typeof PUBLISHING_DEFERRED_SKIP_NOTIFICATIONS_OFF
	| typeof PUBLISHING_DEFERRED_SKIP_UNAUTHORIZED
	| typeof PUBLISHING_DEFERRED_SKIP_NO_ADDRESS;

/**
 * A verdict rather than a boolean, because the four outcomes ask the caller for
 * four different things:
 *
 *   CLAIMED       this run owns the row for one lease. Send. Carries the row's
 *                 PREVIOUS `lastAttemptAt`, read under the claim's own statement
 *                 and immediately before it was overwritten.
 *   AT_BOUND      the row was still DEFERRED and out of attempts, and this call
 *                 DISCHARGED it to FAILED. Nothing further is owed.
 *   HELD          another live attempt owns it. Not an error and NOT terminal --
 *                 the obligation is still owed and must stay counted as such.
 *   NOT_CLAIMABLE delivered, cancelled, expired, or no longer DEFERRED. Pass 1
 *                 owns whatever comes next; do not act.
 */
export type DeferredEmailClaimResult =
	| {
			outcome: "CLAIMED";
			claimToken: string;
			/** The row's `lastAttemptAt` BEFORE this claim overwrote it; null on a first attempt. */
			previousAttemptAt: Date | null;
	  }
	| { outcome: "AT_BOUND" }
	| { outcome: "HELD" }
	| { outcome: "NOT_CLAIMABLE" };

/**
 * Take ONE deferred obligation, by id, under a lease.
 *
 * NOT `claimPublishingEmailDelivery`, and the difference is not incidental. That
 * function is a CREATING path: it is keyed on (cycleId, recipientUserId) and runs
 * the delivery module's full creation fence, including the cycle's TERMINALITY.
 * A cycle that deferred sits at MAIL_NOT_CONFIGURED -- the design deliberately
 * does not widen that predicate, because widening it would make terminal
 * reversible for every writer of that column -- so the creation fence would
 * refuse EVERY deferred send as ALREADY_TERMINAL. The drain never creates: the
 * row exists and the page just handed us its id.
 *
 * THE BOUND TEST AND THE INCREMENT ARE ONE STATEMENT, which is the whole of the
 * atomicity requirement. A pass that read `attemptCount`, decided, and then
 * updated would double-count under two concurrent sweeps or one retried one,
 * burning the bound at twice the rate.
 *
 * THE CLAIM PREDICATE IS IMPORTED, NEVER RESTATED, so delivery, status, expiry,
 * lease and attempt count cannot drift into five separate answers. `status =
 * 'DEFERRED'` is added on top as a LITERAL -- narrowing it, never replacing it --
 * which is also what keeps the drain index reachable.
 *
 * THE IMPORTED PREDICATE CARRIES `expiresAt IS NULL OR ...` AND THAT DISJUNCT IS
 * UNREACHABLE HERE, which is worth stating because the parent design is emphatic
 * that this claim must not have one: a DEFERRED row with a null expiry would be
 * claimed forever, never increment and never expire. The composition removes it.
 * `publishing_notification_delivery_deferred_shape` -- CHECK ("status" <>
 * 'DEFERRED' OR "expiresAt" IS NOT NULL), validated -- means the literal above
 * IMPLIES a non-null expiry, so the design asks for a state that cannot exist and
 * the constraint is what makes it not exist. A case drives a hand-written UPDATE
 * to prove the constraint rather than the application path.
 *
 * `claimedAt` and `lastAttemptAt` are written from the injectable application
 * clock; only the DECISION reads the database clock, inside the imported
 * fragment. That asymmetry is deliberate: a lease is a margin backed by the
 * provider's idempotency key and the tests must be able to move time, while an
 * expiry is a deadline whose wrong answer is mail sent after it.
 *
 * THE PREVIOUS `lastAttemptAt` COMES FROM A CTE, not from a read taken before
 * the call. A read before the claim is a snapshot with no bound on its age -- a
 * timed-out activity keeps running -- and the CTE's SELECT shares the UPDATE's
 * snapshot, so it observes the value the UPDATE is about to overwrite. Reading it
 * here makes the value and the ownership one decision, exactly as the primary
 * path's claim already does for the same reason.
 */
export async function claimDeferredPublishingEmailDelivery(input: {
	id: string;
	now?: Date;
}): Promise<DeferredEmailClaimResult> {
	const now = input.now ?? new Date();
	const leaseCutoff = new Date(now.getTime() - PUBLISHING_EMAIL_LEASE_MS);
	const claimToken = randomUUID();

	const claimed = (await db.$queryRawUnsafe(
		`WITH prev AS (
		   SELECT "id", "lastAttemptAt"
		     FROM "publishing_notification_delivery"
		    WHERE "id" = $1
		 )
		 UPDATE "publishing_notification_delivery" d
		    SET "status" = 'SENDING', "claimedAt" = $2, "claimToken" = $3,
		        "lastAttemptAt" = $2, "attemptCount" = d."attemptCount" + 1,
		        "reason" = NULL, "errorMessage" = NULL
		   FROM prev
		  WHERE d."id" = prev."id"
		    AND d."status" = 'DEFERRED'
		    AND ${publishingEmailClaimableSql({ leaseCutoffParam: "$4" })}
		  RETURNING prev."lastAttemptAt" AS "lastAttemptAt"`,
		input.id,
		now,
		claimToken,
		leaseCutoff,
	)) as Array<{ lastAttemptAt: Date | null }>;
	if (claimed.length > 0) {
		return {
			outcome: "CLAIMED",
			claimToken,
			previousAttemptAt: claimed[0].lastAttemptAt,
		};
	}

	// THE DISCHARGE IS THE CLASSIFICATION. Rather than re-reading the row and
	// interpreting why the claim refused, attempt the one transition a refusal
	// might owe: the statement is SELF-FENCING, so it affects zero rows unless the
	// row really is still DEFERRED and really is at the bound.
	//
	// This is the SECOND writer of RECONCILE_ATTEMPT_BOUND. Pass 1 writes it for a
	// dead-leased SENDING row; this writes it for the DEFERRED one, which is the
	// half that had no home until the claim that produces those rows existed.
	//
	// THE EXPIRY TERM IS LOAD-BEARING and its absence is the tempting version.
	// Expiry takes precedence over the attempt bound -- that is the arm order pass
	// 1 enforces -- and the argument for omitting the term is "pass 1 has already
	// taken every expired row". PASS 1 HAS A BATCH CEILING. A run whose expiry
	// statement spent its whole budget leaves expired DEFERRED rows behind; this
	// page reaches one that is also at the bound; and without this term the row
	// commits as FAILED where pass 1 would commit EXPIRED -- the same clock, the
	// same run, a straight precedence inversion rather than the accepted
	// two-clock divergence. With it, such a row is neither claimed nor discharged
	// and the next tick's expiry statement takes it.
	//
	// clock_timestamp() rather than the caller's `now`: a predicate deciding
	// terminality reads its time in the statement that decides.
	const discharged = (await db.$queryRawUnsafe(
		`UPDATE "publishing_notification_delivery"
		    SET "status" = 'FAILED',
		        "reason" = '${PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND}',
		        "claimedAt" = NULL, "claimToken" = NULL
		  WHERE "id" = $1
		    AND "status" = 'DEFERRED'
		    AND "attemptCount" >= ${PUBLISHING_DELIVERY_ATTEMPT_BOUND}
		    AND "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
		  RETURNING "id"`,
		input.id,
	)) as Array<{ id: string }>;
	if (discharged.length > 0) {
		return { outcome: "AT_BOUND" };
	}

	// STILL OWED versus NOT OWED, told apart by the SAME predicate minus the one
	// term that is about who holds the row right now -- the move the primary
	// path's claim already makes for the same reason. HELD says "still owed", and
	// an expired or attempt-exhausted obligation is not.
	//
	// NO `status = 'DEFERRED'` LITERAL HERE, and its absence is the whole
	// correctness of this branch rather than an inconsistency with the two
	// statements above. Those two ACT on a row and must narrow to the lifecycle
	// they own; this one only ASKS whether the obligation is still owed by
	// anybody. The row that reaches it after a lost race is SENDING -- the winner
	// just moved it -- so narrowing to DEFERRED would find nothing and report
	// NOT_CLAIMABLE for a row a live attempt is holding, telling the drain the
	// obligation was discharged when it is merely taken. Caught by the concurrent
	// case, which is the only shape that produces it.
	//
	// A VERDICT, not a guarantee: it runs only after the update has already
	// refused, and its job is to give the caller NOT_CLAIMABLE rather than HELD.
	// Two clock_timestamp() reads rather than one, and the second is strictly
	// later -- the statements are not simultaneous even inside one transaction --
	// so a row that expired in the gap answers NOT_CLAIMABLE, which is the honest
	// direction.
	const stillOwed = (await db.$queryRawUnsafe(
		`SELECT "id" FROM "publishing_notification_delivery"
		  WHERE "id" = $1
		    AND ${publishingEmailClaimableSql({})}
		  LIMIT 1`,
		input.id,
	)) as Array<{ id: string }>;
	return stillOwed.length > 0
		? { outcome: "HELD" }
		: { outcome: "NOT_CLAIMABLE" };
}

/**
 * Record a KNOWN send failure on a row claimed out of the DEFERRAL lifecycle, and
 * release the claim.
 *
 * NOT `recordPublishingEmailFailure`, and the difference is a stranding bug
 * rather than a matter of style. That function unconditionally writes FAILED,
 * which is right for the primary path -- the in-workflow retry re-claims a FAILED
 * row seconds later, because FAILED is in the claimable set. There is no
 * in-workflow retry here, and a FAILED row carrying an `expiresAt` is invisible
 * to the drain (whose page predicate is status = 'DEFERRED'), to the sweep's pass
 * 1 (whose two statements are DEFERRED and SENDING), and to everything else,
 * because nothing else walks this table by status. It would sit in a state with
 * no route out, which is the leak the lifecycle's three-question audit exists to
 * prevent, reintroduced one layer down.
 *
 * ONE STATEMENT WITH A CASE, not two statements racing two clocks -- the same
 * shape and the same reason as the sweep's SENDING statement: the choice between
 * two outcomes is one decision taken after the row is locked.
 *
 * THE CASE READS THE POST-INCREMENT COUNT, and saying so is what stops an
 * off-by-one. The claim increments inside its own statement, so a row that
 * entered this attempt at four reads five here, and testing `>= BOUND` against
 * that value is what makes the fifth failure terminal on the fifth attempt rather
 * than on the sixth.
 *
 * `expiresAt` IS PRESERVED, and that is what keeps the keyset cursor valid: the
 * pair ("expiresAt","id") is immutable for the life of a row precisely so a row
 * that leaves and re-enters the DEFERRED set keeps its place in the order.
 *
 * `lastAttemptAt` IS PRESERVED for the reason the primary recorder already
 * records: clearing it makes the row read as never-attempted, and every age check
 * downstream then re-sends past the provider's dedupe window believing it is the
 * first try.
 *
 * Fenced on the token, and scoped by the unique triple rather than by id: that
 * triple IS publishing_notification_delivery_cycle_recipient_channel_key and
 * `claimToken` has no index at all, so the scoping is what keeps this an index
 * lookup instead of a sequential scan taking row locks across the table.
 */
export async function recordPublishingDeferredEmailFailure(input: {
	cycleId: string;
	recipientUserId: string;
	claimToken: string;
	reason: PublishingEmailFailureReason;
	errorMessage?: string;
}): Promise<"RETURNED" | "FAILED_AT_BOUND" | "LOST"> {
	if (!input.claimToken) {
		throw new Error(
			"recordPublishingDeferredEmailFailure: a claimToken is required — an absent one would widen the fence rather than match nothing",
		);
	}
	const moved = (await db.$queryRawUnsafe(
		`UPDATE "publishing_notification_delivery"
		    SET "status" = CASE WHEN "attemptCount" >= ${PUBLISHING_DELIVERY_ATTEMPT_BOUND}
		                        THEN 'FAILED' ELSE 'DEFERRED' END,
		        "reason" = $4,
		        "errorMessage" = $5,
		        "claimedAt" = NULL, "claimToken" = NULL
		  WHERE "cycleId" = $1
		    AND "recipientUserId" = $2
		    AND "channel" = 'EMAIL'
		    AND "claimToken" = $3
		    AND "status" = 'SENDING'
		  RETURNING "status"`,
		input.cycleId,
		input.recipientUserId,
		input.claimToken,
		input.reason,
		// `|| null`, not `?? null`. An empty provider message is not nullish, so
		// `??` would store "" while an absent message stores null — two
		// representations of nothing in a column an operator reads.
		input.errorMessage?.slice(0, 1000) || null,
	)) as Array<{ status: string }>;
	if (moved.length === 0) {
		// LOST conflates a newer attempt holding a different token, a cancelled row
		// whose token was released, and a row already confirmed SENT. All three
		// mean the same thing to the caller: this attempt does not own the row, so
		// it must record nothing and stop acting on this recipient.
		return "LOST";
	}
	return moved[0].status === "FAILED" ? "FAILED_AT_BOUND" : "RETURNED";
}

/**
 * Terminalize ONE deferred obligation that a pre-send gate refused.
 *
 * NOT `recordPublishingDeliverySkip`, and the difference is not efficiency. That
 * function is a CREATING path: it upserts, and it runs the full creation fence
 * including a FOR UPDATE on the project row -- a per-row transaction and lock
 * bought for a row that already exists and whose tenancy the drain's first gate
 * has just asserted. Worse, its terminalizing update is fenced on `deliveredAt IS
 * NULL` plus `status <> 'SKIPPED'`, a DENY-LIST OF ONE -- the exact shape the
 * delivery module's own claim predicate was rewritten to remove. That list admits
 * SENDING: if anything claimed the row between the gate returning OK and this
 * write, the refusal would terminalize a row A LIVE ATTEMPT HOLDS and CLEAR ITS
 * LEASE, after which that attempt's confirmation fails for a message the provider
 * had already accepted.
 *
 * An ALLOW-LIST OF ONE instead, self-fencing exactly like the at-bound discharge,
 * and it RETURNS whether it actually terminalized -- so a refusal that lost the
 * row is counted rather than assumed.
 *
 * The lease is cleared with the status for the reason every terminalizing writer
 * here clears it: a row terminalized WITHOUT DELIVERING must never carry a claim,
 * or the sweep is invited to decide re-claimability from a lease on a terminal
 * row. A no-op on a DEFERRED row, which holds no lease by definition -- kept
 * because the invariant belongs to the write, not to today's callers.
 */
export async function skipDeferredPublishingEmailDelivery(input: {
	id: string;
	reason: PublishingDeferredSkipReason;
}): Promise<"SKIPPED" | "LOST"> {
	const moved = (await db.$queryRawUnsafe(
		`UPDATE "publishing_notification_delivery"
		    SET "status" = 'SKIPPED', "reason" = $2,
		        "claimedAt" = NULL, "claimToken" = NULL
		  WHERE "id" = $1
		    AND "status" = 'DEFERRED'
		  RETURNING "id"`,
		input.id,
		input.reason,
	)) as Array<{ id: string }>;
	return moved.length > 0 ? "SKIPPED" : "LOST";
}
