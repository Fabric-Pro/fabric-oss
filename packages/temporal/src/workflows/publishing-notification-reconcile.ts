/**
 * `publishingNotificationReconcileWorkflow` — Publishing Suite 1C-2d.
 * Fizzy #2213.
 *
 * The §9.9 reconciliation sweep, WHOLE, in three activities. 1C-2d-2a shipped
 * the cycle half — the PENDING -> ABANDONED terminalization and the enrolment
 * pass that feeds it. 1C-2d-2b-1 added pass 1's ledger half: expire, reclaim a
 * dead lease, and discharge the attempt bound. 1C-2d-2b-2 added passes 2 and 3 —
 * the mail-config gate, the keyset drain page, the atomic claim, re-authorization,
 * tenant re-derivation, the project kill switch, the provider idempotency key and
 * the send.
 *
 * What is still absent is the PRODUCER: nothing writes a DEFERRED row until
 * 1C-2d-3 flips `notify-topics-ready`, so the third activity reads an empty
 * backlog on merge. That ordering is required rather than incidental — a
 * mechanism that creates durable obligations must not ship ahead of the mechanism
 * that discharges them.
 *
 * Body is intentionally trivial: three sequential activity calls, no branching
 * beyond the two patch markers, no `Date.now()`, no `Math.random()`.
 *
 * ## The second and third calls are behind `patched()` markers, and an earlier
 * draft of this comment argued the second did not need to be
 *
 * That argument was wrong, and the repo has already paid for it once. Appending
 * an activity to a workflow whose recorded histories COMPLETE after the first
 * one is a replay divergence: the replayer reaches the point where the new code
 * issues `ScheduleActivityTask` and finds `WorkflowExecutionCompleted` in the
 * history instead, which surfaces as "Activity machine does not handle this
 * event: WorkflowExecutionCompleted". See the same guard, and the same
 * reasoning, at `backlog-apply-changes-workflow.ts:329-341`.
 *
 * PRODUCTION IS NOT WHERE THIS BITES, and saying so matters because it is what
 * makes the marker look unnecessary. This workflow is hourly, `overlap: SKIP`,
 * and completes in seconds, so no execution is open across a deploy for long;
 * and replaying an OPEN history simply ends where the history ends, where an
 * appended command is legal. What replays COMPLETED histories is the
 * replay-validation job, which fetches the last three days of real dev
 * executions per workflow type — and 1C-2d-2a's schedule has been producing
 * one-activity histories on that schedule since it merged. Without the marker
 * that job goes red on this change.
 *
 * DEPRECATION PATH, so this does not become permanent scenery: once no history
 * older than the deploy is still fetched — three days, per the job's
 * `--since-days` — the marker can become `deprecatePatch()` and later be
 * removed. Until then, `ledger` is null for exactly the executions that predate
 * the ledger pass, which is the honest value rather than a fabricated zero.
 *
 * ## What "no mail key needed" means here, stated affirmatively
 *
 * PASSES 1 AND 2 REQUIRE NO TRANSACTIONAL-EMAIL KEY: neither of the first two
 * activities contains a mail-config check, and this workflow calls them
 * unconditionally, so expiry and reclamation are evaluated with zero reference to
 * mail configuration. The gate lives INSIDE the third activity — never here —
 * which is exactly what makes that true: a check hoisted into this body would
 * return before pass 1 on a keyless worker, and the backlog would grow for as
 * long as the outage lasted, on precisely the deployments that produced it.
 *
 * That is why the third call carries no condition of its own beyond its marker.
 * It is ALWAYS made; the activity decides whether there is a key and reports
 * `mailConfigured: false` when there is not, which is a fact an operator can act
 * on rather than an absence they have to infer.
 *
 * It is NOT a claim that this runs in a process without such a key. A Temporal
 * task queue routes work; it creates no process, no module graph and no
 * environment boundary. Every queue in `worker.ts` is served from one process
 * sharing one activities namespace, so the mail graph is resident here too.
 * Anyone reading this as process-level isolation would believe a boundary that
 * does not exist.
 *
 * ## Why there is no try/catch
 *
 * A workflow that reports success while its work threw is a silent failure, and
 * this project has been bitten by exactly that shape. If an activity exhausts
 * its retries the workflow fails, which is visible in Temporal, and the next
 * hourly tick re-runs from scratch — every transition is idempotent and every
 * batch commits independently, so nothing is lost by starting over.
 *
 * Schedule registration: `registerPublishingNotificationReconcileSchedule()` in
 * `packages/temporal/src/schedules.ts`.
 */

import { log, patched, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

/**
 * The marker guarding 1C-2d-2b-1's second activity. CHANGING THIS STRING
 * RE-BREAKS REPLAY of every history recorded under the old one, so it is a
 * module constant with a test pinning its value rather than a literal inline.
 */
export const PUBLISHING_RECONCILE_LEDGER_PATCH =
	"publishing-reconcile-ledger-pass-1";

/**
 * The marker guarding 1C-2d-2b-2's third activity — passes 2 and 3, the mail gate
 * and the drain.
 *
 * A NEW STRING, NEVER A REUSE of the marker above. A marker's whole job is to
 * tell histories recorded before a change apart from histories recorded after it,
 * and there are now TWO changes. Reusing the ledger marker would make it answer
 * `true` for histories that contain the ledger call and NOT the drain call, and
 * the replayer would then reach a `ScheduleActivityTask` those histories do not
 * have — which is the divergence a marker exists to prevent, produced by the
 * marker itself.
 *
 * CHANGING THIS STRING re-breaks replay of every history recorded under the old
 * one, and no live execution can tell, which is why it is a module constant with
 * a case pinning its value rather than a literal inline.
 *
 * DEPRECATION PATH, so it does not become permanent scenery: once no history
 * older than the deploy is still fetched — three days, per the replay job's
 * `--since-days` — it becomes `deprecatePatch()` and later goes. Both markers
 * retire independently, oldest first.
 */
export const PUBLISHING_RECONCILE_DRAIN_PATCH =
	"publishing-reconcile-drain-pass-3";

const { abandonStalePublishingCycles, reclaimPublishingNotificationStates } =
	proxyActivities<typeof activities>({
		// THE TWO PASSES COST WILDLY DIFFERENT THINGS, and the sentence that used to
		// sit here described only the cheap one: "at most 20 statements per pass,
		// each moving at most 100 rows by primary key". That is true of ENROLMENT
		// and false of ABANDON by roughly 300x.
		//
		// MEASURED on postgres:16 (16.14 — the CI image), full budget, every one of
		// the 20 batches full, by counting the server's own `log_statement = all`
		// output between two marker statements rather than by reading the code:
		//
		//   ENROLMENT  2,000 adopted:      21 statements (20 UPDATEs + 1 residual
		//                                  probe).            ~77 ms.
		//   ABANDON    2,000 terminalized: 6,021 statements — 21 SELECTs (20
		//                                  candidate pages + 1 residual probe),
		//                                  2,000 UPDATEs, and 2,000 BEGIN/COMMIT
		//                                  pairs.             ~8.4 s.
		//
		// The 2,000 is structural, not incidental: the abandon pass writes through
		// the SHARED transition writer one candidate at a time (that is what buys it
		// the terminality guard and the compare-and-swap), and each `updateMany` is
		// its own implicit transaction. Per candidate that is 4.16 ms, of which
		// 1.96 ms is the empty BEGIN/UPDATE/COMMIT envelope alone — measured
		// separately as an `updateMany` matching ZERO rows. So the pass is bound by
		// network round trips and per-commit WAL flushes, which are properties of
		// the DEPLOYMENT; no amount of indexing in the statements bounds them.
		//
		// WHY THE BUDGET IS SIZED TO BE UNREACHABLE RATHER THAN TIGHT. The
		// `publishing.reconcile.cycles_abandoned` line is emitted only after BOTH
		// passes return, so a run killed at this timeout emits NOTHING AT ALL — and
		// an hour with no line looks exactly like a quiet hour. Committed batches
		// survive, so the BACKLOG self-heals on the next tick; the ALERT does not.
		// The failure is therefore silent, and it arrives precisely when the backlog
		// is largest. That asymmetry, not the arithmetic, is what sets this value.
		//
		// FIVE MINUTES: 36x the measured 8.4 s worst case, and it tolerates ~50 ms
		// per round trip (300 s / 6,021) where two minutes broke at ~20 ms — a
		// latency a loaded or cross-region managed Postgres can genuinely reach,
		// which is why the old value was not merely conservative but reachable.
		//
		// RAISING IT COSTS NO WEDGE DETECTION, which is what the old bound was
		// really doing. `heartbeatTimeout` is the wedge detector: the activity
		// heartbeats once per batch (20 times in a full run, ~0.4 s apart when
		// healthy), so a genuinely stuck pass is still killed in 30 seconds no
		// matter what this value is. A start-to-close bound only has to be
		// unreachable by a HEALTHY run.
		//
		// THE LEDGER PASS WAS MEASURED SEPARATELY RATHER THAN ASSUMED TO RESEMBLE
		// EITHER OF THESE, because the handoff required it and because the two
		// existing passes differ from each other by 300x — "it is another sweep"
		// predicts nothing. Same method, same image, 2,100 candidates for EACH of
		// its two statements so both spend the whole budget:
		//
		//   LEDGER  4,000 rows moved:      42 statements (40 UPDATEs + 2 residual
		//                                  probes).           ~197 ms.
		//
		// It is the CHEAP shape, and structurally so: each statement moves a whole
		// page of 100 rows in ONE `UPDATE ... WHERE id = ANY (ARRAY(...))`, where
		// the abandon pass writes one candidate per statement through the shared
		// transition writer and pays a BEGIN/COMMIT envelope for each. 143x fewer
		// round trips than abandon for twice the rows.
		//
		// So the ceiling is unchanged: this timeout is per ACTIVITY, and the
		// binding one is still abandon's 8.4 s. What the second activity does move
		// is the WORKFLOW's worst case — two activities at 5 minutes with 3
		// attempts each is at most 30 minutes of activity time against the
		// schedule's 45-minute `PUBLISHING_RECONCILE_EXECUTION_TIMEOUT_MS`, where
		// 2a had 15.
		//
		// A THIRD ACTIVITY DID ARRIVE, and it did NOT come at these settings — it
		// has its own proxy group below at 3 minutes, which is what makes the
		// arithmetic close at all. The prediction one draft of this comment made
		// was that a third would not fit; what was true is that a third AT THESE
		// SETTINGS would not. A FOURTH does not fit at any settings worth having.
		startToCloseTimeout: "5 minutes",
		heartbeatTimeout: "30 seconds",
		retry: {
			initialInterval: "2s",
			backoffCoefficient: 2,
			// Three attempts at five minutes is fifteen minutes plus six seconds of
			// backoff, still inside the schedule's 45-minute execution timeout
			// (PUBLISHING_RECONCILE_EXECUTION_TIMEOUT_MS in schedules.ts). Retrying
			// is safe because every committed batch survives: a re-invocation
			// resumes against a smaller backlog rather than redoing work.
			maximumAttempts: 3,
		},
	});

/**
 * THE THIRD ACTIVITY GETS ITS OWN PROXY GROUP, because its cost is a different
 * KIND from its two neighbours' and the schedule's bound is now the binding
 * constraint rather than a comfortable ceiling.
 *
 * THE ARITHMETIC, WHICH MUST BE RE-DERIVED AND NOT ASSUMED. The two passes above
 * take 5 minutes x 3 attempts each, plus 2 s + 4 s of backoff apiece: 30 minutes
 * 12 seconds of the schedule's 45-minute PUBLISHING_RECONCILE_EXECUTION_TIMEOUT_MS.
 * This group takes 3 minutes x 3 attempts plus the same backoff — 9 minutes 6
 * seconds — for a workflow worst case of 39 minutes 18 seconds and 5 minutes 42
 * seconds of margin. A FOURTH ACTIVITY DOES NOT FIT.
 *
 * AND THE PARENT DESIGN'S OWN FOUR NUMBERS DO NOT CLOSE, which is why this comment
 * exists rather than a citation. It specifies, for ONE workflow, a 45-minute
 * execution timeout, two minutes per batch, three attempts and a 100/20 page
 * budget. Driven as one activity call per batch that is 20 x 2 x 3 = 120 minutes
 * against a 45-minute bound; even at one attempt each it is 40, and 30 of the 45
 * are already spent. The four have never been reconcilable, and nothing surfaced
 * it because nothing had ever run pass 3. The resolution is here and in the page
 * budget: the drain pages INTERNALLY like both of its neighbours, so the workflow
 * sees one activity rather than twenty, and PUBLISHING_DRAIN_MAX_BATCHES is
 * derived from what this bound affords rather than copied.
 *
 * THREE MINUTES IS UNREACHABLE BY A HEALTHY RUN, which is the only thing a
 * start-to-close bound has to be. The wedge detector is `heartbeatTimeout`: the
 * drain heartbeats once per ROW, so a stalled provider call is killed in 30
 * seconds no matter what this value is.
 */
const { drainDeferredPublishingNotifications } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "3 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export interface PublishingNotificationReconcileOutput {
	cycles: Awaited<ReturnType<typeof abandonStalePublishingCycles>>;
	/**
	 * NULL for an execution recorded before the ledger pass existed — see the
	 * patch marker above. Every live execution carries a value; a fabricated
	 * zero-count object would tell an operator the pass ran and moved nothing.
	 */
	ledger: Awaited<
		ReturnType<typeof reclaimPublishingNotificationStates>
	> | null;
	/**
	 * NULL for an execution recorded before the drain existed — see the second
	 * patch marker. Every live execution carries a value, and on a deployment with
	 * no transactional-email key that value has `mailConfigured: false` rather
	 * than being absent: "the gate closed" and "the pass did not exist" are
	 * different facts and an operator acts differently on each.
	 */
	drain: Awaited<
		ReturnType<typeof drainDeferredPublishingNotifications>
	> | null;
}

export async function publishingNotificationReconcileWorkflow(): Promise<PublishingNotificationReconcileOutput> {
	log.info("Starting publishing notification reconciliation");

	// THE ALERT FIRST (Decision 20). The two are independent — different tables,
	// different grains, no data dependency — so the order is free, and the free
	// choice puts the alert first: a ledger-side failure must not be able to
	// suppress the signal that surfaces stuck work.
	//
	// SEQUENTIAL, AND THAT IS WHY `ACTIVITY_SLOTS.publishingReconcile` STAYS 2.
	// Awaiting the first before starting the second means this workflow never
	// occupies more than one slot; the second is headroom for a manual trigger
	// overlapping a scheduled tick. Running these concurrently would double the
	// concurrency this queue can reach and invalidate the connection-budget
	// arithmetic in `worker.ts`.
	const cycles = await abandonStalePublishingCycles();

	// STILL NO try/catch, and the second call is where that stops being free:
	// from here on a persistently failing cycle sweep blocks the ledger reclaim
	// for as long as it fails. Deliberate on both counts. It is VISIBLE — the
	// workflow fails in Temporal and the schedule's own failure is the signal —
	// and BOUNDED, because the ledger reclaim has an hour of slack before the
	// next tick and every transition it performs is idempotent. Wrapping either
	// call would produce a green workflow over a failed pass, which is the
	// silent-failure shape this project has already been bitten by.
	// GUARD ONLY THE SECOND CALL. `abandonStalePublishingCycles` is present in
	// every recorded history, so guarding it too would make the marker's false
	// branch skip an activity those histories DO contain — the mirror image of
	// the divergence this exists to prevent.
	const ledger = patched(PUBLISHING_RECONCILE_LEDGER_PATCH)
		? await reclaimPublishingNotificationStates()
		: null;

	// PASS 1 BEFORE THE MAIL GATE, and the ORDER OF THESE THREE AWAITS IS THE
	// WHOLE OF PARENT §9.9's REQUIREMENT rather than a preference. Expiry and
	// reclamation are evaluated with zero reference to mail configuration; the
	// gate lives INSIDE the third activity, which is what lets a worker with no
	// transactional-email key still make progress. Moving the check up here — into
	// a workflow, where it would also be recorded once into history and replayed
	// forever — would strand stale rows on precisely the deployments that produced
	// them, because a keyless worker would return before expiring anything and the
	// backlog would grow for exactly as long as the outage lasted.
	//
	// ITS OWN MARKER. Reusing the ledger's would make that marker answer `true`
	// for histories containing the ledger call and not this one.
	const drain = patched(PUBLISHING_RECONCILE_DRAIN_PATCH)
		? await drainDeferredPublishingNotifications()
		: null;

	// NO COMPLETION LINE HERE, DELIBERATELY, and the second activity does not
	// change the argument. Each activity already emits its own canonical line —
	// `publishing.reconcile.cycles_abandoned` and
	// `publishing.reconcile.states_reclaimed` — with its full result spread under
	// its own field names, exactly once per run, at the level its counts warrant.
	// A workflow-side line duplicated three of the cycle counters under renamed
	// keys (`cyclesAbandoned`, `cyclesMoreWorkRemains`), dropped `usedBatchBudget`
	// and the `event` key, and so gave the runbook two spellings to teach and an
	// alert rule two places to double-count. With THREE activities a combined line
	// would have to rename twenty-odd counters and pick one level for three
	// independent signals, which is worse rather than better. One line per pass,
	// one spelling. Whether the WORKFLOW (as opposed to the activities) completed is
	// already in Temporal's own history, which is where an operator looks.
	return { cycles, ledger, drain };
}
