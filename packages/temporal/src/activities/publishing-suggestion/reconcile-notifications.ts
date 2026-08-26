/**
 * Publishing Suite 1C-2d — the reconciliation sweep's activities. Fizzy #2213.
 *
 * THREE activities now. 1C-2d-2a shipped `abandonStalePublishingCycles`;
 * 1C-2d-2b-1 appended `reclaimPublishingNotificationStates` here rather than
 * opening a second module, because the two operate on different tables at
 * different grains — ledger rows versus cycles — and either can fail without the
 * other needing to, which is why they stay separate activities rather than
 * becoming one.
 *
 * The third, `drainDeferredPublishingNotifications`, is in its OWN module and not
 * this one, and the reason is the paragraph below: this file must contain no mail
 * path, and the drain is nothing but one. Keeping them apart is what lets the
 * source assertion on this file stay a meaningful check rather than a comment.
 *
 * ## No mail path, deliberately
 *
 * Parent §9.9 requires this pass to REQUIRE NO TRANSACTIONAL-EMAIL KEY: expiry
 * is evaluated before the mail-config check, not after, because ordering it the
 * other way strands stale rows on precisely the deployments that caused them.
 * This module therefore has no dependency on the mail package and reads no
 * transactional-email provider key, and a test asserts both on the source
 * text — which is also why this paragraph never spells either name out.
 *
 * SAY IT THAT WAY ROUND, never as "runs on a worker without one". A Temporal
 * task queue routes work; it starts no process and draws no module or
 * environment boundary. All of `worker.ts`'s queues are served from a single
 * process sharing one activities namespace, so the mail graph is resident
 * alongside this activity and, on any real deployment, so is the key. What
 * makes the property true is the ABSENCE OF A CHECK IN THIS CODE PATH, not the
 * absence of a key in the process — and that is the version an operator can
 * act on.
 *
 * ## No feature flag, deliberately
 *
 * publishing_suggestion_cycle holds no PENDING rows while
 * FABRIC_FEATURE_PUBLISHING_SUITE is off -- a cycle enters the notification
 * lifecycle only through the flagged path -- so an ungated sweep is a no-op in
 * that state, and both passes reach a partial index to discover it. Gating it
 * would mean that turning the master flag off during an incident silently
 * stops the ALERT: stale PENDING cycles accumulate with nothing raising them,
 * which is the loss class this card exists to remove. The flag can hide the
 * producer; it must not be able to hide the reader.
 *
 * ## Time is read HERE
 *
 * Both clocks are read in the activity, never in the workflow (workflow
 * determinism). That is also what makes the database layer's injectable `now`
 * testable.
 */

import {
	type AbandonStaleCyclesResult,
	abandonStalePublishingCycleOutcomes,
	enrolNullClockPendingCycles,
	type ReclaimPublishingDeliveryStatesResult,
	reclaimPublishingDeliveryStates,
} from "@repo/database";
import { logger } from "@repo/logs";
import { safeHeartbeat } from "../lib/activity-liveness";
import { PUBLISHING_SUGGESTION_EXECUTION_TIMEOUT_MS } from "./dispatch-suggestion";

/**
 * EXTENDS the database result rather than restating it, and that is not a
 * stylistic preference.
 *
 * `AbandonStaleCyclesResult` carries the prose that makes its fields readable
 * — `usedBatchBudget` "says nothing about the backlog", and the ~25 lines on
 * why `moreWorkRemains` is PROBED rather than derived from `batches`. Restating
 * the six field names here produced an operator-facing type carrying none of
 * it, which is the half a workflow, a runbook and an alert actually read. It
 * also made the spread below silently lossy: a field added to
 * `AbandonStaleCyclesResult` would be dropped from this type with no compile
 * error, because a hand-written superset of a shape is a superset only on the
 * day it was written.
 *
 * WHAT THE INHERITED COUNTERS MEAN HERE, said once. `scanned`, `abandoned`,
 * `lost`, `batches`, `usedBatchBudget` and `moreWorkRemains` describe the
 * ABANDON pass alone. The enrolment pass runs its own batch loop with its own
 * `batches` and `usedBatchBudget`, and those are deliberately NOT merged in:
 * `usedBatchBudget` is the raise-the-ceiling signal, and an operator reading it
 * has to know which ceiling. Enrolment reports through `enrolled`,
 * `nullClockResidual` and `nullClockResidualCapped` instead.
 */
export interface AbandonStalePublishingCyclesOutput
	extends AbandonStaleCyclesResult {
	/** Null-clock PENDING cycles this run adopted (Decision 31). */
	enrolled: number;
	/** Null-clock PENDING cycles STILL unenrolled after this run. */
	nullClockResidual: number;
	/** The residual hit its bounded cap, so the real number is at least that. */
	nullClockResidualCapped: boolean;
	/** The staleness BOUND in milliseconds, never a cutoff instant (Decision 33). */
	staleAfterMs: number;
}

/**
 * The cycle-level sweep — in 2a the only thing this module does, and the only
 * unambiguous cycle-outcome write the slice makes.
 *
 * ## The signal, and why it is a log line
 *
 * ABANDONED is the alert: an operator investigates why the step never resolved,
 * and it is the rollback runbook's target state. Writing the value with nothing
 * reading it would repeat a failure this repo has already had — a delivery error
 * written to a column nothing read, which made a month-long outage invisible.
 *
 * A structured log line is what the observability stack actually collects here,
 * established by reading the code rather than assumed:
 *
 *   - The worker serves a prom-client registry on METRICS_PORT (default 9464),
 *     but monitoring/prometheus/prometheus.yml defines exactly three scrape jobs
 *     and none of them is the worker. A counter here would be served and never
 *     collected — write-only telemetry, the very failure this comment exists to
 *     avoid.
 *   - getMeter() in @repo/observability has no callers anywhere, and the
 *     MeterProvider it resolves against is only initialised by the web app's
 *     instrumentation, not by this process.
 *   - Every existing sweep and retention activity in this package reports its
 *     counts exactly this way — a structured logger call plus a returned result
 *     object — and not one of them emits a metric.
 *
 * The line is emitted ONCE PER RUN carrying a count, never once per cycle: an
 * alert on "one or more abandoned this hour" is the useful shape and a per-cycle
 * line buries it. `warn` when the count is non-zero so the level itself is
 * queryable; `info` at zero so the absence of the sweep is also visible.
 *
 * A full alert RULE is out of scope for this slice.
 */
export async function abandonStalePublishingCycles(): Promise<AbandonStalePublishingCyclesOutput> {
	safeHeartbeat("abandonStalePublishingCycles");

	// THE BOUND, NOT A CUTOFF (Decision 33). This activity passes the staleness
	// bound in milliseconds and the DATABASE computes the cutoff inside the
	// statement that decides. There is deliberately no `new Date()` here: a
	// cutoff computed in this process is a clock captured before the statement
	// runs, which is the class of defect three review rounds found in three
	// different places. The bound itself is imported, never copied — a cycle is
	// stale once it is older than the suggestion workflow's own execution
	// timeout, past which the step provably cannot still be running.
	const staleAfterMs = PUBLISHING_SUGGESTION_EXECUTION_TIMEOUT_MS;

	// ENROLMENT FIRST (Decision 31). A cycle activated by a worker on the
	// previous build carries no clock and is invisible to the sweep; this adopts
	// it under a floor that is never earlier than the moment the sweep first saw
	// the row, so a lagging worker clock cannot make a LIVE cycle look stale. It
	// runs first so the residual below is what is STILL invisible after the run,
	// not a number the run has not acted on yet.
	const enrolment = await enrolNullClockPendingCycles({
		onBatch: () => safeHeartbeat("abandonStalePublishingCycles"),
	});

	const result = await abandonStalePublishingCycleOutcomes({
		staleAfterMs,
		onBatch: () => safeHeartbeat("abandonStalePublishingCycles"),
	});

	const output: AbandonStalePublishingCyclesOutput = {
		...result,
		enrolled: enrolment.enrolled,
		nullClockResidual: enrolment.residual,
		nullClockResidualCapped: enrolment.residualCapped,
		// The BOUND is reported, not a cutoff instant. A cutoff would be this
		// process's opinion about when the database decided, which is exactly
		// the value that must not exist here.
		staleAfterMs,
	};

	const message = `[PublishingReconcile] Abandoned ${result.abandoned} stale PENDING cycle(s) (scanned ${result.scanned}, enrolled ${enrolment.enrolled}, ${enrolment.residual}${enrolment.residualCapped ? "+" : ""} still without an activation clock)`;
	const fields = {
		event: "publishing.reconcile.cycles_abandoned",
		...output,
	};
	// A non-zero residual is a SIGNAL, not a footnote: it means some cycles are
	// invisible to this sweep right now, which is the blind spot the whole pass
	// exists to close. It raises the level on its own, independently of whether
	// anything was abandoned — otherwise "nothing to abandon" and "nothing
	// VISIBLE to abandon" would print identically.
	if (result.abandoned > 0 || enrolment.residual > 0) {
		logger.warn(fields, message);
	} else {
		logger.info(fields, message);
	}

	return output;
}

/**
 * EXTENDS the database result for the same reason the cycle output does: the
 * ~25 lines on why `moreWorkRemains` is PROBED rather than derived from
 * `batches`, and the sentence saying `usedBatchBudget` is a fact about the RUN
 * and not about the backlog, are the half a runbook and an alert actually read.
 * Restating four field names here would produce an operator-facing type carrying
 * none of it, and would make the spread below silently lossy the day 1C-2d-2b-2
 * adds a fifth transition.
 */
export interface ReclaimPublishingNotificationStatesOutput
	extends ReclaimPublishingDeliveryStatesResult {
	/** The clock this run classified with, as an ISO string. */
	sweptAt: string;
}

/**
 * Pass 1 over the delivery ledger: expire, reclaim, and discharge the attempt
 * bound.
 *
 * NO MAIL PATH, and that is the requirement rather than a preference — parent
 * §9.9 requires this pass to REQUIRE NO TRANSACTIONAL-EMAIL KEY, because expiry
 * is evaluated BEFORE the mail-config check and ordering it the other way
 * strands stale rows on precisely the deployments that caused them. This module
 * already imports nothing from the mail package and the source assertion at the
 * top of the activity suite already covers it; adding an import here turns that
 * case red, which is the point of asserting it on the source rather than on
 * behaviour.
 *
 * Say it that way round — never "runs on a worker without one". The header
 * above has the whole argument.
 *
 * ## The clock, and why reading it HERE is not a contradiction
 *
 * `abandonStalePublishingCycles` deliberately reads NO clock: it passes a bound
 * in milliseconds and lets the database compute the cutoff inside the statement
 * that decides (Decision 33). This activity does the opposite, and the
 * difference is not an oversight.
 *
 * The cycle sweep's cutoff decides TERMINALITY on its own — a cutoff captured
 * early terminalizes a cycle that is still running, and nothing downstream can
 * undo it. The ledger statements do not work that way: each candidate is
 * classified ONCE, inside its own locked UPDATE, with expiry taking explicit
 * precedence over the attempt bound. Two executions with different clocks can
 * differ about WHEN a row terminalizes; for a row that is not at the attempt
 * bound they cannot differ about WHAT it becomes, and for one that is, both
 * answers are terminal and neither sends mail. An injectable clock is also what
 * makes the whole database suite testable at all.
 *
 * Before changing it, read Decision 33's four clauses and Decision 10's
 * precedence together — in particular clause 4, which is a measured property of
 * PostgreSQL rather than a style rule: an UPDATE's new tuple is projected BEFORE
 * its row lock is taken, so any value whose wrongness is terminal must be
 * written by a statement that cannot wait between choosing the value and
 * committing it. Pass 1's statements write `status` and `reason` — never a
 * clock — so clause 4 does not bite them.
 */
export async function reclaimPublishingNotificationStates(): Promise<ReclaimPublishingNotificationStatesOutput> {
	safeHeartbeat("reclaimPublishingNotificationStates");

	const now = new Date();
	const result = await reclaimPublishingDeliveryStates({
		now,
		onBatch: () => safeHeartbeat("reclaimPublishingNotificationStates"),
	});

	const output: ReclaimPublishingNotificationStatesOutput = {
		...result,
		sweptAt: now.toISOString(),
	};

	const moved = Object.values(result.counts).reduce((sum, n) => sum + n, 0);

	// ONE line per RUN carrying the counts — the same shape and the same reason
	// as the cycle sweep's line. A durable write with no reader is a failure this
	// repo has already had once; `moved` is what an operator alerts on and
	// `moreWorkRemains` is what says the budget was not enough.
	//
	// `info` and not `warn`, unlike the cycle line, and the level is the whole
	// difference between "this ran" and "investigate this". An expired obligation
	// is the sweep WORKING — the deadline passed and the ledger recorded it. An
	// ABANDONED cycle is work that got stuck. Nothing pass 1 writes is by itself
	// evidence of a fault, so nothing here raises the level on its own; a backlog
	// the budget could not clear shows up in `moreWorkRemains`, which is the field
	// an alert rule reads.
	logger.info(
		{ event: "publishing.reconcile.states_reclaimed", moved, ...output },
		`[PublishingReconcile] Moved ${moved} ledger row(s) (${result.counts.EXPIRE_DEFERRED} expired deferred, ${result.counts.EXPIRE_SENDING} expired sending, ${result.counts.FAIL_SENDING_AT_BOUND} out of attempts, ${result.counts.RECLAIM_SENDING_LEASE} leases reclaimed)`,
	);

	return output;
}
