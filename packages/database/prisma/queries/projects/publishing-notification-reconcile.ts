import { db, type Prisma } from "../../client";
import {
	PUBLISHING_DELIVERY_ATTEMPT_BOUND,
	PUBLISHING_EMAIL_LEASE_MS,
} from "./publishing-notification-delivery";
import { writeCycleNotificationOutcome } from "./publishing-notification-outcome";

/**
 * Publishing Suite 1C-2d-2a — the reconciliation sweep's CYCLE half. Fizzy #2213.
 *
 * ## What is here, and what is deliberately not
 *
 * The cycle-grain work: the stale-PENDING candidate page and its bounded
 * existence probe, the null-clock enrolment statement and its bounded residual,
 * their bounds, and the two batched executors that drive them. Nothing ABOVE the
 * ledger header below reads or writes publishing_notification_delivery.
 *
 * The LEDGER-grain transitions arrived in 1C-2d-2b-1 and live in the second half
 * of this file, as that slice said they would: same package, same reason for
 * being frozen strings, same test file, rather than a second module. What is
 * remaining transition there, DEFERRED-at-the-attempt-bound, did NOT land here:
 * 1C-2d-2b-2 measured the cost of adding it and put it in the drain instead, at
 * the moment the claim refuses. See the note above PUBLISHING_RECLAIM_STATEMENTS.
 *
 * ## Why the SQL is a frozen string and not a Prisma query
 *
 * THE SWEEP MUST EMIT THE CYCLE OUTCOME AS A LITERAL, NEVER AS A BIND PARAMETER.
 * A partial index is usable only where the query's predicate provably IMPLIES
 * the index predicate, and a generic plan -- the one PostgreSQL builds with no
 * parameter values in hand -- has nothing with which to prove
 * "notificationOutcome" = $1 implies = 'PENDING'. Both partial indexes this
 * slice ships (20260815120380) leave the planner's search space at once, and
 * every pass degrades to a sequential scan of the whole cycle table. The same
 * requirement is stated for the ledger's own indexes at
 * 20260815120200_..._deferral_indexes/migration.sql:117.
 *
 * That requirement is only enforceable if the string the tests read is the
 * string this module executes. A Prisma `updateMany` cannot be EXPLAINed, and a
 * tagged-template `$executeRaw` cannot be handed to a test without retyping it
 * -- at which point the test pins a copy and proves nothing. So every statement
 * is a module-level constant string and the suite asserts on exactly these
 * constants.
 *
 * The strings are assembled ONCE, at module load, from module constants and from
 * nothing else. No caller value is ever interpolated: every runtime value is a
 * bind parameter. That is what makes `$executeRawUnsafe` safe here -- and it is
 * the only place in prisma/queries/** that uses it, so the reason is spelled out
 * rather than assumed.
 *
 * ## Why `= ANY (ARRAY(SELECT ... LIMIT n))` (Decision 19)
 *
 * Measured on postgres:16 (16.14 -- the CI image): the more obvious
 * `WHERE "id" IN (SELECT ... LIMIT n)` plans as a `Hash Semi Join` whose OUTER
 * side is a sequential scan of the whole table. `= ANY (ARRAY(...))` plans the
 * inner page on the partial index and the outer update through an index.
 *
 * ## Why the predicates are repeated in the outer WHERE
 *
 * The write is CONDITIONAL, never a read followed by a write. Under READ
 * COMMITTED an UPDATE re-evaluates its WHERE against the newer version of a row
 * a concurrent transaction changed, so a cycle an activation writer moved
 * between the InitPlan and the update is skipped rather than clobbered.
 * Removing the repetition does not change today's behaviour and does change
 * tomorrow's.
 */

/** Cycles examined per statement. */
export const PUBLISHING_ABANDON_BATCH_SIZE = 100;

/**
 * Statements per run. 100 x 20 = 2,000 cycles per run, 48,000 per day at the
 * hourly cadence.
 */
export const PUBLISHING_ABANDON_MAX_BATCHES = 20;

/**
 * Candidates for ABANDONED: cycles still PENDING past the point where the
 * suggestion step provably cannot still be running.
 *
 * THE OUTCOME IS A LITERAL BECAUSE THE INDEX IS PARTIAL ON IT, and here that is
 * the whole bound rather than a stylistic echo of the ledger's rule. A partial
 * index is reachable only where the query predicate provably IMPLIES the index
 * predicate, and no generic plan can prove "notificationOutcome" = $1 implies
 * = 'PENDING'. Turn this literal into a bind parameter and the statement leaves
 * publishing_suggestion_cycle_pending_stale_idx behind and reads the whole
 * table.
 *
 * MEASURED on postgres:16 (16.14 -- the CI image), against 200,000 cycles of
 * which 200 are PENDING, 150 of those stale by the activation clock and 50
 * late-activated, 30 MB of heap, seeded and thrown away inside one rolled-back
 * transaction, with the index this slice's 20260815120380 migration ships:
 *
 *   Limit  Buffers: shared hit=4
 *     ->  Index Scan using publishing_suggestion_cycle_pending_stale_idx
 *           Index Cond: ("notificationOutcomeAt" < ((now() AT TIME ZONE 'UTC') - '02:00:00'::interval))
 *
 * BUFFERS, NOT MILLISECONDS, AND THE DISTINCTION IS THE POINT. Two independent
 * sessions on postgres:16 (16.14) put a full 100-row page at 2-5 buffers and
 * the identical statement without the index at ~3,850. The timings did not
 * survive the same treatment: this comment once carried a floor of "0.03 ms"
 * and the second session measured 0.024 ms, BELOW it. A buffer count is a
 * property of the plan; a millisecond is a property of the machine and the
 * moment. So the claim kept here is the one that reproduced cleanly in both:
 * SINGLE-DIGIT BUFFERS WITH THE INDEX, THOUSANDS WITHOUT, on the same
 * statement and the same fixture.
 *
 * THE Index Cond IS THE LITERAL-VS-BIND RULE PAYING OUT, VISIBLY. It carries
 * ONLY the timestamp comparison. Both other terms -- the outcome equality and
 * `IS NOT NULL` -- are IMPLIED by the index predicate and dropped by the
 * planner, which is precisely what it cannot do for `= $1`. (An earlier draft
 * of this comment printed `IS NOT NULL` inside the Index Cond. No plan has
 * produced that.)
 *
 * Negative control, same fixture, same transaction: drop both indexes and the
 * statement returns to `Parallel Seq Scan` under a `Gather Merge` -- ~3,850
 * buffers, ~66,600 rows discarded by the filter in each of three workers.
 *
 * THE BOUND IS THE INDEX, NOT THE LIMIT -- LIMIT caps rows RETURNED, never rows
 * READ. Measured on that same fixture: with the index, a run that finds nothing
 * stale costs 2 buffers, because it stops at the first key past the bound;
 * without it, that same run still pays ~3,850, because it cannot stop early.
 * FINDING NOTHING COSTS WHAT FINDING A FULL PAGE COSTS ONCE THE INDEX IS GONE,
 * and that is the claim. An earlier draft went further and called the empty run
 * "the MOST expensive of the four" -- it is not. In both sessions the two
 * index-less runs tied at 3,847 buffers in the scan node, and the empty one was
 * the FASTER of the pair in each (6.34 vs 6.48 ms; 6.81 vs 7.10 ms). The
 * superlative was inside run-to-run noise, which is exactly what the paragraph
 * above says not to write down.
 *
 * `notificationOutcomeAt` IS THE ANCHOR — an EXPLICIT column, and neither
 * `createdAt` nor `updatedAt`.
 *
 * NOT createdAt. The bound is the SUGGESTION WORKFLOW's execution timeout — the
 * point past which the generation step provably cannot still be running — so
 * the clock has to start when the notification lifecycle was ACTIVATED, not
 * when the row was inserted. Those are not the same instant: dispatch creates
 * the cycle BEFORE client.workflow.start (dispatch-suggestion.ts:353-364, the
 * createOrGetPublishingCycle call, then :393-408, the client.workflow.start
 * call), a start failure re-throws so Temporal retries the whole activity
 * (:415-418, the catch's final `throw err`), and activation to PENDING happens
 * later still, inside the transaction that sets READY
 * (publishing-suite.ts:369-379, :461, :467). A
 * delayed start therefore produces a freshly-activated cycle whose createdAt is
 * ALREADY past the bound, and a sweep keyed on it writes ABANDONED over a LIVE
 * attempt. The shared CAS arbitrates that write race; it does not establish
 * staleness. And ABANDONED is terminal, so the live attempt's own outcome write
 * is then refused and the false alert is permanent.
 *
 * NOT updatedAt either, and this is the reversal a third review round forced.
 * updatedAt is @updatedAt (schema.prisma:6040), so it is stamped by ANY writer:
 * it is the activation instant only while an INVENTORY of every writer of this
 * model stays complete and correctly fenced. An inventory goes stale, and the
 * source-scanning guard defending it was shown to pass on writers it could not
 * see. A column nothing else writes needs no inventory.
 *
 * A NULL notificationOutcomeAt is deliberately NOT swept BY THIS STATEMENT. It
 * means the cycle was activated by a build predating the column, which the
 * migration's backfill cannot reach because the row did not exist yet. The
 * CREATION window is one rolling deploy wide; the missed alert would not be, so
 * the run's FIRST pass enrols such rows (PUBLISHING_NULL_CLOCK_ENROL_SQL below)
 * and a LATER tick sweeps them -- not this one. Enrolment writes a floor at
 * least as late as the moment it ran, so a just-enrolled row cannot be stale by
 * the time this statement reads it; that is the cost of the floor and it is the
 * cheap side of the trade, because the other direction terminalizes live work
 * irreversibly. What is left after that pass is REPORTED, not left for a runbook
 * query to find.
 *
 * COALESCE-ing to updatedAt here was rejected and the difference is not
 * cosmetic: COALESCE is a STANDING read of updatedAt on every sweep forever, so
 * any future writer of the cycle row moves this clock. Enrolment WRITES ONCE
 * into the explicit column, and afterwards nothing else can move it.
 *
 * Oldest first, so a backlog larger than one run's budget drains in age order
 * rather than in whatever order the scan returns.
 */
export const PUBLISHING_STALE_PENDING_CYCLE_SQL = `SELECT "id", "projectId", "notificationOutcomeVersion"
  FROM "publishing_suggestion_cycle"
 WHERE "notificationOutcome" = 'PENDING'
   AND "notificationOutcomeAt" IS NOT NULL
   AND "notificationOutcomeAt" < (now() AT TIME ZONE 'UTC') - ($1::bigint * interval '1 millisecond')
 ORDER BY "notificationOutcomeAt" ASC
 LIMIT ${PUBLISHING_ABANDON_BATCH_SIZE}`;

/**
 * The same candidate predicate, `LIMIT 1`. Asked ONCE per run, and skipped on
 * exactly one exit: a short final page every candidate of which was actually
 * taken. So "a backlog is growing" stops being an inference from
 * `batches === MAX`, which is also what a short final page and an exactly-full
 * backlog produce.
 */
export const PUBLISHING_STALE_PENDING_CYCLE_REMAINING_SQL = `SELECT 1
  FROM "publishing_suggestion_cycle"
 WHERE "notificationOutcome" = 'PENDING'
   AND "notificationOutcomeAt" IS NOT NULL
   AND "notificationOutcomeAt" < (now() AT TIME ZONE 'UTC') - ($1::bigint * interval '1 millisecond')
 LIMIT 1`;

export interface AbandonStaleCyclesResult {
	scanned: number;
	abandoned: number;
	/** Candidates whose compare-and-swap lost to another writer. */
	lost: number;
	batches: number;
	/** The run spent its whole batch budget. Says nothing about the backlog. */
	usedBatchBudget: boolean;
	/**
	 * A stale candidate was still there when the loop stopped — measured by a
	 * bounded `LIMIT 1` probe, not inferred from `batches`. The cycle executor
	 * gets the same correction as the ledger one because it is the same defect:
	 * `batches === MAX` is reached by a short final page and by an exactly-full
	 * backlog as well as by a real one.
	 *
	 * ASKED ON EVERY EXIT THAT CAN LEAVE WORK BEHIND, which is not what either
	 * of the first two drafts did. The first probed only when the batch budget
	 * ran out, so the CONTENTION exit — a FULL page every one of whose
	 * compare-and-swaps lost — returned `false` while a full page of stale
	 * candidates provably remained. The second added that exit and left the
	 * SHORT-PAGE one answering `false` unconditionally, justified by "the page
	 * was just drained" — a sentence the code never tested. A short page some
	 * or all of whose swaps LOST is not drained, and the run then reported no
	 * work left with every one of those rows still stale, still PENDING and
	 * still selectable.
	 *
	 * SO THE ONE EXIT THAT ANSWERS WITHOUT ASKING NOW TESTS ITS OWN REASON:
	 * `wonThisBatch === candidates.length`, the page actually drained. A
	 * genuinely drained short page — including the empty page an idle run
	 * reads, which is the overwhelmingly common case — still pays nothing.
	 * Every other exit asks rather than assumes: another writer can terminalize
	 * the contended page between the last swap and the probe, and `false` is
	 * then the honest answer.
	 *
	 * WHY THIS WAS FIXED WHILE NOTHING COULD REACH IT. At this commit the only
	 * writer of `notificationOutcomeVersion` is `writeCycleNotificationOutcome`,
	 * whose `outcome` parameter type excludes `PENDING` and `NOT_APPLICABLE` —
	 * so every version bump also moves the row off `PENDING`, and no production
	 * caller can produce a lost swap on a page that is still selectable. That
	 * argument is an INVENTORY OF WRITERS, and this module rejects exactly that
	 * style of reasoning three screens above, for `updatedAt`: an inventory goes
	 * stale. 1C-2d-2b appends writers to this same module, and the first one
	 * that bumps a version without terminalizing the row — a lease, an attempt
	 * counter, a retry stamp — makes this branch reachable, silently.
	 *
	 * ASKING ON AN UNDRAINED SHORT PAGE COSTS THE SAME PROBE THE OTHER EXITS
	 * PAY, and it reaches the same partial index — nothing about which exit
	 * asked changes what the probe reads. Measured on postgres:16 (16.14)
	 * against 200,000 cycles of which 200 PENDING and 150 stale:
	 * `Index Only Scan using publishing_suggestion_cycle_pending_stale_idx`,
	 * Index Cond on the timestamp comparison alone, single-digit buffers.
	 */
	moreWorkRemains: boolean;
}

/**
 * Terminalize stale PENDING cycles to ABANDONED (parent §9.7 rule 3).
 *
 * Writes through writeCycleNotificationOutcome — the SHARED transition writer —
 * rather than issuing its own UPDATE. That writer carries both guards this
 * column's design requires: the terminality predicate, so a late attempt cannot
 * downgrade a terminal answer, and the version compare-and-swap, so two writers
 * racing on a PENDING cycle cannot both win. The sweep is one of the five
 * writers that column enumerates; a sixth hand-written UPDATE would be a guard
 * keyed to nobody.
 *
 * The read-then-CAS is not a read-then-write hazard: the CAS IS the fence. A
 * candidate whose version moved between the select and the write simply loses,
 * and losing is the correct outcome — something else answered first.
 *
 * Paging needs no cursor: a won swap leaves PENDING, so the next page's own
 * predicate excludes it. The no-progress break is what bounds the case where
 * every candidate loses — without it the same page would be re-read until the
 * batch ceiling. THAT BREAK IS ALSO AN EXIT WITH WORK LEFT, so it asks the
 * residual probe exactly as the ceiling does — and so does a short page that
 * was not fully taken; see `moreWorkRemains`.
 */
export async function abandonStalePublishingCycleOutcomes(
	// The BOUND in milliseconds, never a cutoff Date. The cutoff is computed by
	// the database inside the deciding statement (Decision 33); a Date parameter
	// is what made the activity's own new Date() load-bearing.
	input: { staleAfterMs: number; onBatch?: () => void },
	client: Prisma.TransactionClient = db,
): Promise<AbandonStaleCyclesResult> {
	let scanned = 0;
	let abandoned = 0;
	let lost = 0;
	let batches = 0;
	// THE ONE EXIT THAT MAY ANSWER WITHOUT ASKING, recorded rather than
	// re-derived: a short final page every candidate of which was actually
	// taken. No other field reconstructs it — `batches` cannot tell a short
	// page from the ceiling, and `scanned`/`abandoned` cannot tell a DRAINED
	// short page from a contended one.
	let drainedShortPage = false;

	while (batches < PUBLISHING_ABANDON_MAX_BATCHES) {
		const candidates = (await client.$queryRawUnsafe(
			PUBLISHING_STALE_PENDING_CYCLE_SQL,
			input.staleAfterMs,
		)) as Array<{
			id: string;
			projectId: string;
			notificationOutcomeVersion: number;
		}>;
		batches += 1;
		scanned += candidates.length;

		let wonThisBatch = 0;
		for (const candidate of candidates) {
			const won = await writeCycleNotificationOutcome(
				{
					cycleId: candidate.id,
					projectId: candidate.projectId,
					outcome: "ABANDONED",
					observedVersion: candidate.notificationOutcomeVersion,
				},
				client,
			);
			if (won) {
				wonThisBatch += 1;
			} else {
				lost += 1;
			}
		}
		abandoned += wonThisBatch;
		input.onBatch?.();

		if (candidates.length < PUBLISHING_ABANDON_BATCH_SIZE) {
			// DRAINED is `every candidate on this page was taken`, never merely
			// `the page was short`. A short page one of whose swaps LOST leaves
			// that row stale, PENDING and selectable, so this exit is only
			// allowed to skip the probe when it has nothing left behind. The
			// empty page an idle run reads satisfies it trivially — 0 === 0 —
			// which is the case the exception exists for.
			drainedShortPage = wonThisBatch === candidates.length;
			break;
		}
		// Every candidate lost its swap: the page will be identical next time,
		// so spending the rest of the budget on it buys nothing.
		if (wonThisBatch === 0) {
			break;
		}
	}

	// UNCHANGED MEANING: the batch budget ran out. It is not widened to cover
	// the other two exits, because an operator reading it is asking whether to
	// raise the ceiling, and neither of them says anything about the ceiling.
	const usedBatchBudget = batches === PUBLISHING_ABANDON_MAX_BATCHES;
	// Every exit asks except the one that provably has nothing to find.
	const moreWorkRemains = drainedShortPage
		? false
		: (
				(await client.$queryRawUnsafe(
					PUBLISHING_STALE_PENDING_CYCLE_REMAINING_SQL,
					input.staleAfterMs,
				)) as unknown[]
			).length > 0;

	return {
		scanned,
		abandoned,
		lost,
		batches,
		usedBatchBudget,
		moreWorkRemains,
	};
}

/**
 * Adopt PENDING cycles that carry NO activation clock.
 *
 * WHY THIS EXISTS. The column ships with a migration that backfills every
 * PENDING row existing at that moment. A worker still running the PREVIOUS
 * build then activates a cycle without stamping it, so rows with a null clock
 * keep appearing until the last old worker restarts. The creation window is
 * bounded by the deploy; the consequence is not, because a sweep that ignores a
 * null clock ignores it forever. A genuinely stuck cycle would stay invisible
 * during a deploy — one of the likeliest times for a workflow to be interrupted.
 *
 * WHY THE FLOOR, AND WHY IT IS NOT SIMPLY `updatedAt` (Decision 33). @updatedAt
 * is a CLIENT-side behaviour, so a worker whose clock trails this one stamps a
 * value BELOW the true activation instant -- and the abandon pass would then
 * terminalize a LIVE cycle. Measured: a cycle activated one second ago by a
 * worker three hours behind enrolled with a three-hour-old clock and matched the
 * staleness predicate on the same tick.
 *
 * GREATEST("updatedAt", this statement's own database clock) makes the enrolled
 * value never EARLIER than the moment the sweep first saw the row, and GREATEST
 * rather than the clock alone so a worker whose clock runs AHEAD keeps its later
 * value. Conservative in BOTH skew directions: the alert is DELAYED, never
 * manufactured, and that is the only acceptable direction because ABANDONED is
 * terminal.
 *
 * THE COST, SAID PLAINLY: a genuinely stuck null-clock cycle is adopted on this
 * tick and swept on a LATER one, a staleness bound afterwards. The earlier draft
 * claimed same-tick convergence; that claim rested on updatedAt being an upper
 * bound, which is exactly what fails here.
 *
 * WHY NOT COALESCE IN THE SWEEP'S PREDICATE. That is a standing read of
 * updatedAt on every run for every null-clock row, so any future writer of the
 * cycle row moves the clock the sweep reads — the exact implicit coupling the
 * explicit column exists to remove. This writes ONCE; afterwards the row's clock
 * is explicit and immutable.
 *
 * RAW SQL, SO IT DOES NOT MOVE `updatedAt` ITSELF. @updatedAt is a client-side
 * behaviour of the Prisma query engine, not a database default. The value being
 * read therefore stays put, and re-running the pass over an already-enrolled
 * population is a no-op — which is what makes it safe to run hourly forever
 * rather than once after a deploy. It is also what lets the floor be a DATABASE
 * clock at all: a Prisma updateMany cannot express a clock in a SET clause.
 *
 * `clock_timestamp()` AND `FOR UPDATE SKIP LOCKED` ARE ONE FIX, NOT TWO
 * (Decision 33, clauses 1 and 4). The floor is a VALUE WRITTEN, so it reads the
 * volatile clock rather than transaction-start `now()`. That alone is not
 * enough, and the measurement is the reason this comment exists: PostgreSQL
 * PROJECTS an UPDATE's new tuple BEFORE it takes the row lock, so a volatile
 * clock in a SET clause does not observe a lock wait either -- measured, a value
 * written one millisecond after statement start while the statement then blocked
 * for seven seconds. A cycle row can be held by any open transaction (the
 * activation writer runs inside the transaction that sets READY), and NOTHING on
 * the application side bounds that wait: an activity timeout cancels the
 * ATTEMPT, not a SQL statement already executing. A backdated floor is then read
 * as stale by the abandon pass in the SAME still-running activity, and ABANDONED
 * is irreversible.
 *
 * SKIP LOCKED removes the wait rather than shortening it. A row another
 * transaction is holding is a row somebody is actively writing; it is skipped,
 * it stays in the bounded residual this pass already reports, and the next tick
 * adopts it with a fresh floor. And because row locks are per TRANSACTION, the
 * outer UPDATE re-locking a row this statement's own subquery already locked
 * waits for nobody -- so the whole statement is wait-free, not just the
 * subquery.
 *
 * THE COST, MEASURED: the candidate page stops being an Index Only Scan and
 * becomes LockRows -> Index Scan over the same partial index, ~200 buffers for a
 * 100-row page. Bounded by the PAGE, not by the population, with no Sort.
 *
 * THAT LAST SENTENCE IS NOT BOUGHT BY THE PARTIAL INDEX ALONE, and an earlier
 * draft of it said it was. The index makes the ordered walk AVAILABLE; the
 * planner takes it only because migration 20260815120380 also narrows the stale
 * index with `notificationOutcomeAt IS NOT NULL` (so it cannot compete for this
 * predicate) and ships an (mcv) extended statistics object on
 * ("notificationOutcome","notificationOutcomeAt") (so the correlated pair is not
 * estimated as independent). Without the statistics object, measured on 600,000
 * cycles with 5,000 null-clock PENDING interleaved through them, this page is a
 * Bitmap Heap Scan over actual rows=5000 with a top-N Sort on top: 5,131 buffers
 * to return 100. Read that migration's comments before changing either.
 *
 * BOUNDED BY THE SAME CEILING AS EVERY OTHER PASS. 100 x 20 = 2,000 cycles per
 * run.
 */
export const PUBLISHING_NULL_CLOCK_ENROL_SQL = `UPDATE "publishing_suggestion_cycle"
   SET "notificationOutcomeAt" = GREATEST("updatedAt", (clock_timestamp() AT TIME ZONE 'UTC'))
 WHERE "id" = ANY (ARRAY(
         SELECT "id"
           FROM "publishing_suggestion_cycle"
          WHERE "notificationOutcome" = 'PENDING'
            AND "notificationOutcomeAt" IS NULL
          ORDER BY "updatedAt" ASC, "id" ASC
          LIMIT ${PUBLISHING_ABANDON_BATCH_SIZE}
          FOR UPDATE SKIP LOCKED
       ))
   AND "notificationOutcome" = 'PENDING'
   AND "notificationOutcomeAt" IS NULL
 RETURNING "id"`;

/**
 * What is LEFT after the pass — the signal, not a diagnostic somebody has to
 * remember to run.
 *
 * BOUNDED: a count over a `LIMIT`-ed subquery, capped one above the run's own
 * ceiling. Exact below the cap and honestly marked at it. An unbounded
 * `count(*)` on a live table is what the rest of this module forbids, and a
 * signal that needs one is not a signal worth having.
 */
export const PUBLISHING_NULL_CLOCK_RESIDUAL_CAP =
	PUBLISHING_ABANDON_BATCH_SIZE * PUBLISHING_ABANDON_MAX_BATCHES + 1;

export const PUBLISHING_NULL_CLOCK_RESIDUAL_SQL = `SELECT count(*)::int AS n FROM (
  SELECT 1 FROM "publishing_suggestion_cycle"
   WHERE "notificationOutcome" = 'PENDING'
     AND "notificationOutcomeAt" IS NULL
   LIMIT $1) s`;

export interface NullClockEnrolmentResult {
	enrolled: number;
	batches: number;
	usedBatchBudget: boolean;
	residual: number;
	/** The residual hit its cap, so the real number is at least that. */
	residualCapped: boolean;
}

export async function enrolNullClockPendingCycles(
	input: { onBatch?: () => void } = {},
	client: Prisma.TransactionClient = db,
): Promise<NullClockEnrolmentResult> {
	let enrolled = 0;
	let batches = 0;

	while (batches < PUBLISHING_ABANDON_MAX_BATCHES) {
		const moved = (await client.$queryRawUnsafe(
			PUBLISHING_NULL_CLOCK_ENROL_SQL,
		)) as Array<{ id: string }>;
		batches += 1;
		enrolled += moved.length;
		input.onBatch?.();
		// A SHORT PAGE NOW MEANS "fewer than a page of UNLOCKED candidates",
		// not "fewer than a page of candidates" — SKIP LOCKED can shorten it.
		// Breaking is still right: a locked row is one another transaction is
		// writing, and re-reading the same page to skip it again buys nothing.
		// It stays in the residual below, which counts locked rows too, so the
		// run reports it rather than losing it.
		if (moved.length < PUBLISHING_ABANDON_BATCH_SIZE) {
			break;
		}
	}

	const [{ n }] = (await client.$queryRawUnsafe(
		PUBLISHING_NULL_CLOCK_RESIDUAL_SQL,
		PUBLISHING_NULL_CLOCK_RESIDUAL_CAP,
	)) as Array<{ n: number }>;

	return {
		enrolled,
		batches,
		usedBatchBudget: batches === PUBLISHING_ABANDON_MAX_BATCHES,
		residual: n,
		residualCapped: n >= PUBLISHING_NULL_CLOCK_RESIDUAL_CAP,
	};
}

/**
 * Publishing Suite 1C-2d-2b-1 — the reconciliation sweep's LEDGER half, pass 1,
 * "terminalize and reclaim" (parent §9.9). Fizzy #2213.
 *
 * Everything above this line is the CYCLE grain and everything below is the
 * LEDGER grain. They share a module deliberately: same package, same reason for
 * being frozen strings, same test file. The three sections of the header above —
 * why the SQL is a frozen string, why `= ANY (ARRAY(…))`, why the predicates are
 * repeated in the outer WHERE — apply here unchanged and are not restated. What
 * follows is what is true of the ledger half alone.
 *
 * ## Why the SENDING side is ONE statement with a CASE
 *
 * Splitting it by `expiresAt <= now` versus `expiresAt > now` gives two
 * predicates that are disjoint only RELATIVE TO ONE CLOCK — and two overlapping
 * executions do not share one. Each captures its own `now` (a manual run beside
 * the scheduled one; a timed-out Temporal attempt still running beside its
 * retry), so a row whose expiry falls between the two clocks is matched by a
 * different statement in each, and the outer status fence then PRESERVES
 * whichever arbitrary answer won the row lock rather than correcting it.
 *
 * Merging them makes the two remaining statements disjoint on `status` alone —
 * DEFERRED against SENDING — which no clock can move, and makes the choice
 * between the three SENDING outcomes ONE decision taken after the row is locked.
 *
 * ## PRECEDENCE: EXPIRY WINS OVER THE ATTEMPT BOUND
 *
 * A dead-leased row that is BOTH past its expiresAt AND at the attempt bound is
 * EXPIRED, never FAILED. Expiry is a fact about the OBLIGATION — the recipient no
 * longer benefits from this mail — and the bound is a fact about the MECHANISM,
 * that we stopped trying. When both are true the obligation's own deadline is the
 * stronger fact and the one an operator acting on EXPIRED reads correctly.
 *
 * THE ARM ORDER IS THE WHOLE OF IT, and it is now load-bearing in a way it was
 * not in 1C-2d-2a. That slice shipped two exhaustive complementary arms, where
 * both orders were behaviourally identical and only a text guard could see the
 * difference. This slice adds a third arm, so a row matched by two arms exists
 * and the order decides what it becomes. Both a text guard and a behavioural case
 * hold it; swapping the arms turns exactly one behavioural case red.
 *
 * THE DEFERRED-AT-BOUND DISCHARGE IS DELIBERATELY NOT A THIRD STATEMENT HERE, and
 * 1C-2d-2b-2 settled that by measurement rather than by the plan's expectation.
 * The at-bound arm cannot be its own DEFERRED statement — two statements split on
 * `expiresAt <= now` versus `> now` are disjoint only relative to ONE clock, which
 * is the shape this header rejects three paragraphs above — so the only way to add
 * it is to widen EXPIRE_DEFERRED's candidate predicate with an `OR`. Measured on
 * postgres:16 (16.14) with both shipped partial indexes present, on the run that
 * finds NOTHING, which is every hour of every ordinary day:
 *
 *   expiry alone            2 buffers at 3,000 rows,   2 at 30,000
 *   expiry OR at-bound     44 buffers at 3,000 rows, 377 at 30,000
 *
 * The `OR` takes a statement that is constant in the backlog and makes it linear
 * in it. And the damage hides where a test would not look: against a large
 * MATCHING backlog the same form plans as an index scan with the `OR` as a filter
 * and stops at the LIMIT — 4 buffers, indistinguishable from healthy.
 *
 * So the discharge lives in the drain, at the moment the claim refuses, where the
 * row is already in hand and the page has already been paid for. That is also
 * what the rule about shipping a discharge with the mechanism that CREATES its
 * rows asks for literally: the only thing that increments `attemptCount` is that
 * claim.
 */

/** Rows moved per statement. Bounded work: longer means wedged. */
export const PUBLISHING_RECLAIM_BATCH_SIZE = 100;

/**
 * Batches per statement per run. 2 statements x 100 x 20 = 4,000 row-updates per
 * run, 96,000 per day at the hourly cadence. A backlog larger than that takes
 * more than one run to clear, which is the intended shape: every batch commits
 * independently, so ticks converge and a killed activity loses no completed work.
 *
 * A PER-STATEMENT ceiling is safe only because the two statements are DISJOINT ON
 * status (see PUBLISHING_RECLAIM_STATEMENTS). Rows an exhausted statement did not
 * reach are rows the other statement cannot reach, so a backlog above the ceiling
 * delays work rather than redirecting it into the wrong terminal state.
 */
export const PUBLISHING_RECLAIM_MAX_BATCHES = 20;

/**
 * What `reason` records about a row this sweep terminalized or returned.
 *
 * Without these, an EXPIRED row written by the sweep is indistinguishable from
 * one written by any other path, and there is nothing durable to read back for
 * any of the four transitions. `reason` is free text at the schema level
 * (schema.prisma, `reason String?`, no CHECK), so these constants are the
 * enforcement — which is also why a typo in one of them is invisible to the type
 * system and every case asserts the value it wrote.
 *
 * RECONCILE_ATTEMPT_BOUND has TWO writers across the two slices of 1C-2d-2b and
 * only one of them is here: the SENDING at-bound arm below. The DEFERRED one is
 * in `publishing-notification-drain.ts`, riding on the claim's refusal, and it
 * IMPORTS this constant rather than declaring a second one carrying the same
 * string — two constants for one free-text value is a divergence nothing would
 * catch.
 */
export const PUBLISHING_RECLAIM_REASON_EXPIRED = "RECONCILE_EXPIRED";
export const PUBLISHING_RECLAIM_REASON_LEASE_RECLAIMED =
	"RECONCILE_LEASE_RECLAIMED";
export const PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND =
	"RECONCILE_ATTEMPT_BOUND";

/**
 * The four OUTCOMES. Not the same list as the two STATEMENTS below: the SENDING
 * statement carries three of them and decides between them per row.
 *
 * A FIFTH WAS EXPECTED HERE AND DID NOT ARRIVE. 1C-2d-2b-2 was planned to add
 * FAIL_DEFERRED_AT_BOUND; the measurement above moved that transition to the
 * drain, so this set and its statements are unchanged. The executor's tally stays
 * an exhaustive switch with a thrown default: a member added without its case is
 * a compile error rather than a count that is quietly wrong.
 */
export type ReclaimTransitionKey =
	| "EXPIRE_DEFERRED"
	| "EXPIRE_SENDING"
	| "FAIL_SENDING_AT_BOUND"
	| "RECLAIM_SENDING_LEASE";

/** The two STATEMENTS. */
export type ReclaimStatementKey = "EXPIRE_DEFERRED" | "RECONCILE_SENDING";

/**
 * The two clocks a pass reads, taken ONCE per run.
 *
 * `leaseCutoff` is derived from `now` and PUBLISHING_EMAIL_LEASE_MS rather than
 * computed in SQL, for the reason that constant's own doc-comment gives: the
 * comparison is between two APPLICATION clocks, and the tests need an injectable
 * `now`.
 *
 * Two overlapping executions therefore hold two clocks, and nothing here pretends
 * otherwise. What the merged SENDING statement removes is not the skew; it is the
 * skew's ability to produce a WRONG TERMINAL STATE. See the header above.
 */
export interface ReclaimClock {
	now: Date;
	leaseCutoff: Date;
}

export interface ReclaimStatement {
	readonly key: ReclaimStatementKey;
	readonly sql: string;
	/**
	 * The CANDIDATE PREDICATE ALONE, `LIMIT 1`. Not a count and not a second copy
	 * of the statement: it is the same `WHERE` the batch selects on, asked the one
	 * question the executor cannot answer for itself — is there a candidate left
	 * after the last permitted batch?
	 *
	 * Spending the whole batch budget does NOT mean a backlog exists. A run whose
	 * twentieth page was short, and a run whose backlog was exactly 2,000 rows,
	 * both end with `runs === MAX` and nothing left to do. Reading "more work
	 * remains" out of that is an inference, and it is wrong at both boundaries.
	 * This probe replaces the inference with a fact, at the cost of ONE
	 * index-reaching `LIMIT 1` per exhausted statement per run, and only when the
	 * budget was actually spent.
	 */
	readonly remainingSql: string;
	readonly params: (clock: ReclaimClock) => unknown[];
	/**
	 * The probe's OWN parameters, stated separately and REQUIRED rather than
	 * defaulted to `params`.
	 *
	 * The two statements do not have the same arity. `sql` for RECONCILE_SENDING
	 * binds the lease cutoff AND the clock, because its CASE classifies against
	 * the expiry; the probe asks only whether a CANDIDATE is left, and the
	 * candidate predicate never mentions the expiry instant. Reusing `params`
	 * there hands Postgres two binds for one placeholder, which is not a type
	 * error and not a slow query -- it is `08P01 bind message supplies 2
	 * parameters, but prepared statement "" requires 1`, thrown at runtime.
	 *
	 * MEASURED, AND THE FAILURE MODE IS WHY THIS FIELD IS NOT OPTIONAL: the probe
	 * runs only when a statement spends its whole batch budget, so the throw
	 * arrives exactly when the ledger is overloaded -- the one condition the probe
	 * exists to report -- and the sweep then fails on every tick until the backlog
	 * drains below the ceiling without it. A field defaulting to `params` would
	 * reproduce this for the next statement whose probe is narrower than its
	 * update; a required field makes the author state both, and the arity guard in
	 * the suite checks the answer.
	 */
	readonly remainingParams: (clock: ReclaimClock) => unknown[];
}

export function reclaimClockFrom(now: Date): ReclaimClock {
	return {
		now,
		leaseCutoff: new Date(now.getTime() - PUBLISHING_EMAIL_LEASE_MS),
	};
}

const RECLAIM_LIMIT = PUBLISHING_RECLAIM_BATCH_SIZE;
const RECLAIM_BOUND = PUBLISHING_DELIVERY_ATTEMPT_BOUND;

/**
 * Pass 1's two statements. THEY ARE DISJOINT ON `status` ALONE — DEFERRED against
 * SENDING — and that is the invariant this array exists to carry. It is a
 * CLOCK-INDEPENDENT partition, which the earlier three-statement design's
 * `expiresAt <= now` / `expiresAt > now` split was not. The array order is
 * documentation, not semantics.
 *
 *   EXPIRE_DEFERRED    DEFERRED, expiresAt <= now                     -> EXPIRED
 *   RECONCILE_SENDING  SENDING, dead lease, expiresAt NOT NULL:
 *                        expiresAt <= now                             -> EXPIRED
 *                        attemptCount >= bound                        -> FAILED
 *                        otherwise                                    -> DEFERRED
 *
 * Every runtime value is a bind parameter and every STATUS is a literal, so both
 * shipped partial indexes stay reachable. Both statements RETURN "status", so the
 * executor can tally four outcomes out of two statements without a second query.
 *
 * WHAT THE CANDIDATE PREDICATE EXCLUDES, AND WHY IT IS LOAD-BEARING:
 *
 *   "expiresAt" IS NOT NULL       keeps the primary path's crashed-send residue
 *                                 out (parent §9.9's stated boundary). Delete it
 *                                 and the CASE's ELSE arm writes DEFERRED with a
 *                                 null expiry, which the shipped deferred_shape
 *                                 CHECK rejects outright — measured, not argued.
 *
 * 1C-2d-2a ALSO CARRIED `("expiresAt" <= $2 OR "attemptCount" < BOUND)` AND THIS
 * SLICE DELETES IT. It existed to keep a row at the bound and still inside its
 * expiry OUT of a slice that had no arm to discharge it with. This slice has the
 * arm, so the exclusion would now be the thing preventing the discharge. Deleting
 * it is a WIDENING of the candidate set, which is why it is called out here
 * rather than left to be noticed in a diff: every case that asserted such a row
 * is left alone had to be re-decided when it went.
 */
export const PUBLISHING_RECLAIM_STATEMENTS: readonly ReclaimStatement[] = [
	{
		key: "EXPIRE_DEFERRED",
		// NO CHANNEL TERM IN EITHER STATEMENT BELOW, and that is licensed rather
		// than overlooked. publishing_notification_delivery_leased_channel confines
		// SENDING, DEFERRED and EXPIRED to the EMAIL channel, so `status =
		// 'DEFERRED'` already means "an email obligation" and asking again would
		// only cost: neither shipped partial index has `channel` in its predicate,
		// so the term would be a filter to re-measure rather than a narrowing to
		// exploit, on statements whose plans are pinned.
		//
		// THE OBLIGATION THAT CREATES: a slice that widens that constraint for a
		// second channel MUST come back here. These statements would otherwise
		// reclaim the new channel's rows on email's lease window, email's attempt
		// bound and email's 14-day expiry — silently, because nothing in the
		// candidate SELECT ever asked what the row is for.
		sql: `UPDATE "publishing_notification_delivery"
   SET "status" = 'EXPIRED',
       "claimedAt" = NULL,
       "claimToken" = NULL,
       "reason" = '${PUBLISHING_RECLAIM_REASON_EXPIRED}'
 WHERE "id" = ANY (ARRAY(
         SELECT "id"
           FROM "publishing_notification_delivery"
          WHERE "status" = 'DEFERRED'
            AND "expiresAt" <= $1
          ORDER BY "expiresAt" ASC, "id" ASC
          LIMIT ${RECLAIM_LIMIT}
       ))
   AND "status" = 'DEFERRED'
   AND "expiresAt" <= $1
 RETURNING "status"`,
		remainingSql: `SELECT 1
   FROM "publishing_notification_delivery"
  WHERE "status" = 'DEFERRED'
    AND "expiresAt" <= $1
  LIMIT 1`,
		params: (clock) => [clock.now],
		remainingParams: (clock) => [clock.now],
	},
	{
		key: "RECONCILE_SENDING",
		// ONE atomic classification, after the row lock. THE EXPIRY ARM IS FIRST
		// and the at-bound arm is SECOND: a row that is both past its deadline and
		// out of attempts is EXPIRED, because the obligation's own deadline is the
		// stronger fact. Swapping them is not a style change; it changes what that
		// row becomes, and a behavioural case says so.
		//
		// The lease is cleared on ALL THREE arms, unconditionally rather than
		// inside a CASE. An earlier draft of the merge kept it on the EXPIRED arm
		// as provenance, which was wrong twice over: EXPIRE_DEFERRED clears it, so
		// the two terminal paths would have disagreed about the same column, and
		// 1C-2c's shipped case asserting that a terminalized row releases its lease
		// would have gone red. A red shipped case is a regression, never a stale
		// test.
		sql: `UPDATE "publishing_notification_delivery"
   SET "status" = CASE WHEN "expiresAt" <= $2 THEN 'EXPIRED'
                       WHEN "attemptCount" >= ${RECLAIM_BOUND} THEN 'FAILED'
                       ELSE 'DEFERRED' END,
       "claimedAt" = NULL,
       "claimToken" = NULL,
       "reason" = CASE WHEN "expiresAt" <= $2
                       THEN '${PUBLISHING_RECLAIM_REASON_EXPIRED}'
                       WHEN "attemptCount" >= ${RECLAIM_BOUND}
                       THEN '${PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND}'
                       ELSE '${PUBLISHING_RECLAIM_REASON_LEASE_RECLAIMED}' END
 WHERE "id" = ANY (ARRAY(
         SELECT "id"
           FROM "publishing_notification_delivery"
          WHERE "status" = 'SENDING'
            AND "claimedAt" < $1
            AND "expiresAt" IS NOT NULL
          ORDER BY "claimedAt" ASC
          LIMIT ${RECLAIM_LIMIT}
       ))
   AND "status" = 'SENDING'
   AND "claimedAt" < $1
   AND "expiresAt" IS NOT NULL
 RETURNING "status"`,
		remainingSql: `SELECT 1
   FROM "publishing_notification_delivery"
  WHERE "status" = 'SENDING'
    AND "claimedAt" < $1
    AND "expiresAt" IS NOT NULL
  LIMIT 1`,
		params: (clock) => [clock.leaseCutoff, clock.now],
		// ONE parameter, not two. The candidate predicate is `status` + a dead
		// lease + a non-null expiry; the expiry INSTANT belongs to the CASE, which
		// this probe does not run.
		remainingParams: (clock) => [clock.leaseCutoff],
	},
];

export interface ReclaimPublishingDeliveryStatesResult {
	/** Keyed by OUTCOME — four keys out of two statements. */
	counts: Record<ReclaimTransitionKey, number>;
	/** Keyed by STATEMENT. */
	batches: Record<ReclaimStatementKey, number>;
	/**
	 * Statements that spent their whole batch budget. That is ALL this field
	 * claims, and the name says so: it is a fact about the RUN, not about the
	 * backlog. An earlier draft called it `hitBatchCeiling` and the runbook read it
	 * as "more work remains", which is false at two boundaries the executor cannot
	 * tell apart from the inside.
	 */
	usedBatchBudget: ReclaimStatementKey[];
	/**
	 * Statements with at least one candidate LEFT after the last permitted batch —
	 * measured by `remainingSql`, never inferred from the batch count. This is the
	 * field an operator should alert on.
	 */
	moreWorkRemains: ReclaimStatementKey[];
}

/**
 * Run pass 1 once: every statement, in bounded batches.
 *
 * "In order" is deliberately NOT part of the contract — the two statements are
 * disjoint on status, so the pass reaches the same fixed point in any order, and
 * a test runs it both ways to keep that true.
 *
 * NOR is "in isolation". Two executions can overlap, each with its own `now`. The
 * outer WHERE re-assertion is what makes the loser write nothing rather than
 * clobber; what makes the result CORRECT rather than merely stable is that each
 * row is classified once, under its own lock, with expiry taking precedence. An
 * interleaving can still cost one tick — see the transient below.
 *
 * THE TRANSIENT IS PART OF THE CONTRACT, NOT AN ARTEFACT. When the earlier clock
 * wins the row lock, the row commits as DEFERRED with an expiry ALREADY PAST, and
 * the next tick's EXPIRE_DEFERRED takes it to EXPIRED. It is observable, a test
 * pins it BEFORE any cleanup tick, and it is exactly why
 * claimPublishingEmailDelivery refuses an overdue DEFERRED row.
 *
 * NOT wrapped in a transaction. A transaction spanning up to 4,000 row-updates on
 * a live ledger holds row locks for the whole run, which is the lock behaviour
 * parent §5 warns about arrived at from the other direction. Independent commits
 * also make Temporal's retry a convergence mechanism rather than a repeated-work
 * one: a killed activity keeps every committed batch, and every state it can
 * leave behind is a state the next run's predicates match.
 *
 * `onBatch` exists so the caller can heartbeat without this package importing
 * anything from @temporalio — @repo/database must not depend on the worker.
 */
export async function reclaimPublishingDeliveryStates(
	input: { now?: Date; onBatch?: () => void } = {},
	client: Prisma.TransactionClient = db,
): Promise<ReclaimPublishingDeliveryStatesResult> {
	const clock = reclaimClockFrom(input.now ?? new Date());
	const counts: Record<ReclaimTransitionKey, number> = {
		EXPIRE_DEFERRED: 0,
		EXPIRE_SENDING: 0,
		FAIL_SENDING_AT_BOUND: 0,
		RECLAIM_SENDING_LEASE: 0,
	};
	const batches = {} as Record<ReclaimStatementKey, number>;
	const usedBatchBudget: ReclaimStatementKey[] = [];
	const moreWorkRemains: ReclaimStatementKey[] = [];

	for (const statement of PUBLISHING_RECLAIM_STATEMENTS) {
		let runs = 0;
		while (runs < PUBLISHING_RECLAIM_MAX_BATCHES) {
			// $queryRawUnsafe, not $executeRawUnsafe: the statements RETURN
			// "status", which is how four outcomes are tallied out of two
			// statements. The rows are one short string each, capped at the batch
			// size.
			const moved = (await client.$queryRawUnsafe(
				statement.sql,
				...statement.params(clock),
			)) as Array<{ status: string }>;
			runs += 1;
			for (const row of moved) {
				counts[reclaimOutcomeOf(statement.key, row.status)] += 1;
			}
			input.onBatch?.();
			// A short page means the predicate is exhausted. Breaking on
			// `moved.length === 0` alone would spend the whole budget on a backlog
			// that is one row short of a full page every time.
			if (moved.length < PUBLISHING_RECLAIM_BATCH_SIZE) {
				break;
			}
		}
		if (runs === PUBLISHING_RECLAIM_MAX_BATCHES) {
			usedBatchBudget.push(statement.key);
			// ONE bounded probe, and only for a statement that actually spent its
			// budget. `runs === MAX` is reached by three different runs and only one
			// of them has a backlog: nineteen full pages plus a short twentieth,
			// exactly twenty full pages with nothing behind them, and twenty full
			// pages with more waiting. Asking is cheap; the alternative is an
			// operational alert that fires on ordinary workloads sitting on the
			// boundary.
			const rest = (await client.$queryRawUnsafe(
				statement.remainingSql,
				...statement.remainingParams(clock),
			)) as unknown[];
			if (rest.length > 0) {
				moreWorkRemains.push(statement.key);
			}
		}
		batches[statement.key] = runs;
	}

	return { counts, batches, usedBatchBudget, moreWorkRemains };
}

/**
 * Which OUTCOME a returned row represents — the four-way tally two statements
 * cannot report on their own.
 *
 * EXHAUSTIVE OVER THE WRITTEN STATUS, WITH A THROW, and that is the point rather
 * than defensiveness. The earlier two-arm form read `row.status === "EXPIRED"`
 * with an `else`, and an `else` silently absorbs whatever arm a later slice adds:
 * a DEFERRED-at-bound discharge added here would have been counted as a lease
 * reclaim, with every test still green because no test can assert a count that is
 * wrong by construction. That transition ended up in the drain instead, so the
 * hazard is unrealised — and the throw stays, because the next arm anyone adds
 * faces it again. A thrown default makes that a loud failure in the one
 * run that produces the new status.
 */
function reclaimOutcomeOf(
	statement: ReclaimStatementKey,
	status: string,
): ReclaimTransitionKey {
	if (statement === "EXPIRE_DEFERRED") {
		return "EXPIRE_DEFERRED";
	}
	switch (status) {
		case "EXPIRED":
			return "EXPIRE_SENDING";
		case "FAILED":
			return "FAIL_SENDING_AT_BOUND";
		case "DEFERRED":
			return "RECLAIM_SENDING_LEASE";
		default:
			throw new Error(
				`RECONCILE_SENDING returned an unclassified status: ${status}`,
			);
	}
}
