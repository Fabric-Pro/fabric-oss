/**
 * Coding Instructions lifecycle reaper (Fizzy #2550).
 *
 * Three jobs nothing else in the feature does, all of them unbounded without
 * a schedule to run them:
 *
 *  1. **Abandoned uploads.** `projects.instructions.begin` creates a snapshot
 *     row in RECEIVING and hands the browser one signed PUT per file;
 *     `finalize` is what moves it on. Close the upload dialog part-way through
 *     and `finalize` is never called: the row stays RECEIVING forever, the tab
 *     reads it as work in progress and keeps polling it, and its staged
 *     objects are referenced by a row that will never reach a verdict. The
 *     bucket lifecycle rule that was meant to collect them is not in place.
 *  2. **The failure path.** `pruneInstructionSnapshots` runs only at the END
 *     of a SUCCESSFUL validation workflow, so a project whose uploads keep
 *     failing accumulates REJECTED/FAILED rows and their staged copies with
 *     nothing bounding them.
 *  3. **Stranded validations.** A row in VALIDATING is owned by a workflow
 *     that writes its verdict either way — until that workflow is gone and
 *     its failure marker never landed. Nothing else will ever move such a
 *     row: the tab polls it forever and never offers "Try again".
 *  4. **Stranded deferred scans** (Fizzy #2737). A version published before
 *     its secret scan is READY with the scan PENDING until its own workflow
 *     records a verdict. When that workflow is gone first, nothing else ever
 *     would, and the version reads "scan pending" forever (phase 0b).
 *
 * Modelled on the attachment sweeps: bounded per-run budgets, structured
 * `instructions.reaper.*` events, a result object of counts, and no tenant in
 * scope — the candidate queries are system-wide, and every per-row write is
 * bound to the `projectId`/`organizationId` that came off that row.
 *
 * ORDER, everywhere: the row's status first, its objects second. A snapshot
 * whose staging objects were deleted while its row still said RECEIVING would
 * be an upload the tab offers to finish and that cannot be finished.
 *
 * LIVENESS: a RECEIVING row is not by itself proof that nothing is running.
 * `finalize` starts the validation workflow BEFORE it writes VALIDATING, and
 * tolerates losing that write, so phase 1 asks Temporal about the snapshot's
 * deterministic workflow id first, through `describeSnapshotWorkflow` in
 * `./lib/instruction-abandonment` (shared with the repository sync's own
 * `record` activity), and leaves any row whose execution is still RUNNING
 * alone; a closed execution that never claimed the row is abandoned like a
 * missing one (design 2026-09-23 §5.7).
 *
 * The row itself is what actually decides it, though. `verifyAndScanInstruc-
 * tionFiles` CLAIMS the snapshot (RECEIVING -> VALIDATING, and only from
 * RECEIVING: a retry from FAILED awaits the finalize API's own transition,
 * because an activity attempt cannot prove on its own evidence that it still
 * owns a FAILED row) before it touches storage, and phase 1's verdict below
 * requires RECEIVING, so the two are conditional writes on the same row from
 * the same from-state and exactly one can win. The Temporal check is no longer
 * what makes that safe: it now only avoids the needless verdict on an
 * execution that has STARTED but whose first activity has not run yet, which
 * is a live upload whose row still reads RECEIVING and has not been claimed.
 *
 * STRANDED VALIDATING ROWS: phase 0 is the other half of the same picture. A
 * row moved to VALIDATING whose execution is gone has nothing left to write
 * its verdict, so it polls forever and never offers "Try again". That is a
 * heal, not a prevention — see the phase for what preventing it would take.
 *
 * BUDGETS: four row/project budgets bound how much work a run SELECTS, and
 * two global ones — objects deleted and wall clock — bound what that work
 * costs, because the product of the nominal per-unit limits runs far past the
 * activity's start-to-close timeout. Both are checked between units of work
 * only.
 *
 * FAILURE POLICY: every phase counts a per-row or per-project storage
 * failure, carries on, and lets the next hourly run retry it. Nothing here
 * aborts a run, because each unit of work belongs to a DIFFERENT tenant: one
 * project's storage hiccup must not stop the other ninety-nine.
 *
 * For the abandonment phases that is safe only because the work is
 * rediscoverable. `rejectAbandonedInstructionSnapshot` writes its verdict
 * with `detail: ABANDONED_STAGING_PENDING`, and only a completed sweep
 * rewrites that to `ABANDONED_STAGING_CLEARED`, so a row whose objects were
 * not deleted — by a crash in the gap, by a non-empty `deleteObjects.errors`,
 * or by a failure in this run that was counted and passed over — is still
 * selected by phase 1b on the next run, and on every run after it. That mark
 * never expires: a prefix that will not delete for days is an operations
 * signal, visible as a standing `errorCount`; retention keeps the row pinned
 * until a successful sweep clears the marker.
 *
 * `updatedAt` is therefore NOT eligibility, only order. Phase 1b takes the
 * oldest pending rows first and re-dates a row that FAILED to the back, so a
 * single undeletable prefix cannot sit at the head of the queue every hour
 * and starve the rows behind it.
 */

import {
	failStaleValidatingInstructionSnapshot,
	listAbandonedReceivingInstructionSnapshots,
	listPendingAbandonedInstructionSnapshots,
	listProjectsWithPrunableInstructionSnapshots,
	listStaleDeferredScanInstructionSnapshots,
	listStaleValidatingInstructionSnapshots,
	markStaleDeferredScanIncomplete,
	rejectAbandonedInstructionSnapshot,
} from "@repo/database";
import {
	DEFERRED_SCAN_STALE_AFTER_MS,
	PROPOSAL_UPLOAD_SIGNING_WINDOW_MS,
	RECEIVING_ABANDON_AFTER_MS,
	VALIDATING_STALE_AFTER_MS,
} from "@repo/instructions";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import type { Client } from "@temporalio/client";
import { getTemporalClient } from "../client";
import { safeHeartbeat } from "./lib/activity-liveness";
import {
	describeSnapshotWorkflow,
	errorFacts,
	sweepClosedAbandonment,
} from "./lib/instruction-abandonment";
import {
	FAILED_SNAPSHOT_RETENTION,
	MAX_PREFIX_PAGES,
	pruneProjectInstructionSnapshots,
	SNAPSHOT_RETENTION,
	type StorageBudget,
} from "./lib/instruction-prune";

/**
 * Per-run budgets. The sweep runs hourly, so these bound one execution's
 * blast radius rather than its coverage: whatever is left over is the next
 * run's work, and `hitCap` in the result says when that happened.
 *
 * The prune slice is deliberately the smallest of them. Its per-project cost
 * is the one that is genuinely unbounded — two retention windows of up to
 * fifty rows each, every row carrying its own file keys and its own export
 * prefix — and unlike the abandonment phases, a project it does not reach
 * this hour is reached the next, now that the candidate query rotates.
 */
const MAX_ABANDONED_PER_RUN = 200;
const MAX_PRUNE_PROJECTS_PER_RUN = 25;
const MAX_RESWEPT_ABANDONED_PER_RUN = 200;
/**
 * Phase 0's slice. Smaller than the abandonment budgets because every row in
 * it costs a Temporal `describe` — a network round trip the abandonment phases
 * only pay for rows that are already six hours old — and because a healthy
 * deployment has none of these at all: a full page is an incident, not a
 * backlog, and it is still reported through `hitCap`.
 */
const MAX_STALE_VALIDATING_PER_RUN = 100;
/**
 * Phase 0b's slice, sized like phase 0's and for the same reasons: every row
 * costs a `describe`, and a healthy deployment has none.
 */
const MAX_STALE_DEFERRED_SCAN_PER_RUN = 100;

/**
 * The two GLOBAL budgets, spent across every phase rather than per phase.
 *
 * The row budgets above bound how many units of work a run selects, not how
 * much storage work a unit can be: one prefix is up to `MAX_PREFIX_PAGES`
 * pages, one pruned snapshot carries its own file keys, and the product of
 * the nominal limits runs to millions of keys — far past what fits in the
 * activity's 15-minute `startToCloseTimeout`. A run that times out is retried
 * FROM THE TOP, so an early phase that cannot finish means the later phases
 * never run at all, every hour, indefinitely.
 *
 * So both budgets are checked before each row and each project, and the run
 * stops with `hitCap` when either is spent. The time budget is two thirds of
 * the start-to-close timeout: enough headroom for the in-flight unit of work
 * to finish and the result to be written.
 */
const MAX_STORAGE_OBJECTS_PER_RUN = 20_000;
const RUN_TIME_BUDGET_MS = 10 * 60 * 1000;

/** How far a rotation advances per hour: one full slice. */
const ROTATION_PERIOD_MS = 60 * 60 * 1000;

/**
 * One run's slice of a candidate population: a window of `slice` candidates
 * that moves by exactly one slice per hour and wraps at the end of the
 * population. Used by every phase whose candidates can be passed over without
 * being written — the prune, whose per-project failures do not clear, and
 * phase 0b, whose RUNNING or unknown rows keep their place — because a fixed
 * first page lets those rows be re-selected every hour and starves every
 * candidate behind them indefinitely.
 *
 * `fetchPage` returns ONE ordered relation's page at `offset` and the
 * population's size with it, so the rotation is a window over a single
 * canonical order. For the prune that is the whole point of the raw SQL
 * behind it: skipping the READY and REJECTED windows separately and
 * interleaving the results is not a window of anything — twenty-five sticky
 * READY-only projects and twenty-five sticky rejected-only ones left half of
 * each starved at offset 0 and the whole population unvisited at offset 25,
 * every hour, indefinitely.
 *
 * TWO queries at most, each returning at most one slice:
 *
 *  1. The HEAD page, always. It is where `total` comes from — for the prune
 *     the population size rides on the page's rows, so only a page that HAS
 *     rows reports it, and offset 0 is the one page that is non-empty
 *     whenever the population is. It is also this run's page outright when
 *     the population fits in one slice, or when the hour's offset is zero.
 *  2. The rotated page, when the offset is past zero. If it comes back short
 *     it reached the END of the ordering, and the remainder wraps to the
 *     start of the population — which is the head page this run already
 *     holds, so the wraparound costs no third query.
 *
 * COVERAGE: the offset advances by exactly one slice per hour modulo `total`,
 * so consecutive runs walk adjacent windows of one circular order. With the
 * population stable, every candidate is reached within `ceil(total / slice)`
 * runs from any starting hour.
 *
 * The two ranges cannot overlap while the population is stable — a page short
 * by `missing` rows ends at `total`, and `missing` is `offset - (total -
 * slice)`, which is below `offset` whenever `total` exceeds one slice. The
 * dedup (by `keyOf`) is for the case where the population SHRANK between the
 * two statements: handling one candidate twice in a run is harmless, but it
 * would spend a slot on a no-op.
 */
async function selectRotatedSlice<T>(
	fetchPage: (
		limit: number,
		offset: number,
	) => Promise<{ candidates: T[]; total: number }>,
	slice: number,
	startedAtMs: number,
	keyOf: (candidate: T) => string,
): Promise<T[]> {
	const head = await fetchPage(slice, 0);
	const offset =
		(Math.floor(startedAtMs / ROTATION_PERIOD_MS) * slice) %
		// `% 0` is NaN, which is not an offset. An empty population has
		// nothing to rotate through anyway.
		Math.max(1, head.total);
	if (head.total <= slice || offset === 0) {
		return head.candidates;
	}
	const rotated = await fetchPage(slice, offset);
	const missing = slice - rotated.candidates.length;
	if (missing <= 0) {
		return rotated.candidates;
	}
	const taken = new Set(rotated.candidates.map(keyOf));
	return [
		...rotated.candidates,
		...head.candidates
			.filter((c) => !taken.has(keyOf(c)))
			.slice(0, missing),
	];
}

/**
 * One run's slice of the prune candidate population (`selectRotatedSlice`
 * over `listProjectsWithPrunableInstructionSnapshots`). `projectId` alone is
 * the dedup key: it is a primary key of `project`, so the pair cannot
 * disagree about which project a row names.
 */
function selectPruneCandidates(
	keep: { ready: number; rejected: number },
	startedAtMs: number,
): Promise<Array<{ projectId: string; organizationId: string }>> {
	return selectRotatedSlice(
		(limit, offset) =>
			listProjectsWithPrunableInstructionSnapshots(keep, limit, offset),
		MAX_PRUNE_PROJECTS_PER_RUN,
		startedAtMs,
		(c) => c.projectId,
	);
}

export interface ReapInstructionSnapshotsResult {
	/** Abandoned RECEIVING rows the candidate query returned. */
	scanned: number;
	/** Of those, how many THIS run moved to REJECTED. */
	rejected: number;
	/** Stale VALIDATING rows phase 0's candidate query returned. */
	staleValidating: number;
	/**
	 * Of those, how many THIS run moved to FAILED because no execution stood
	 * behind them any more. Every one is a snapshot that would otherwise have
	 * polled forever with no "Try again" offered, so a non-zero count is worth
	 * an operator's attention even though the row is now recovered.
	 */
	healedValidating: number;
	/** Stale pending deferred scans phase 0b's candidate query returned. */
	staleDeferredScans: number;
	/**
	 * Of those, how many THIS run recorded as INCOMPLETE because no execution
	 * stood behind them any more: a published version whose scan will now
	 * never run, which the tab shows as not checked. Worth an operator's
	 * attention for the same reason `healedValidating` is.
	 */
	incompleteDeferredScans: number;
	/**
	 * Rows any phase left alone because Temporal still knows of an
	 * execution for their validation workflow. In phase 1 that is a RECEIVING
	 * row whose `finalize` started one and whose status write was lost or is
	 * still in flight; in phase 0 it is a VALIDATING row whose execution is
	 * genuinely still RUNNING, and in phase 0b a pending deferred scan whose
	 * workflow is still working through it. Not an error either way — these rows belong to
	 * a workflow, and it owns their verdict. A phase-1 count that stays high
	 * across runs means status writes are failing, which is a different bug
	 * from the one this sweep exists for.
	 */
	skippedLive: number;
	/**
	 * Already-REJECTED abandonments still marked pending whose staging prefix
	 * phase 1b attempted this run, successfully or not. Not a count of what
	 * was deleted: the normal case for a row that got this far is a prefix
	 * some earlier attempt left behind. Rows phase 1 handled in THIS run are
	 * excluded by the query, not skipped afterwards.
	 */
	resweptAbandoned: number;
	stagingObjectsDeleted: number;
	projectsPruned: number;
	snapshotsPruned: number;
	/**
	 * Units of work that could not be completed and were carried past: an
	 * abandonment whose staging sweep threw in either phase, a project whose
	 * prune threw, or a row whose liveness could not be established because
	 * `describe` (or the client behind it) failed. An abandonment counted here
	 * is still pending, so it is retried next run; a count that stays high
	 * across runs is the signal that something needs a human.
	 */
	errorCount: number;
	/**
	 * Some prefix sweep stopped at `MAX_PREFIX_PAGES` with more objects still
	 * under it. Those objects are the bucket-lifecycle follow-up's work, not
	 * the next run's: their rows are gone.
	 */
	storageTruncated: boolean;
	/**
	 * A candidate query came back full, or a global budget stopped a phase
	 * part-way: there is more to do next run. Which one it was is in the
	 * `instructions.reaper.cap_hit` / `budget_exhausted` events.
	 */
	hitCap: boolean;
	cutoffAt: string;
}

export async function reapInstructionSnapshots(): Promise<ReapInstructionSnapshotsResult> {
	const storage = getStorageProvider();
	const startedAtMs = Date.now();
	const cutoff = new Date(startedAtMs - RECEIVING_ABANDON_AFTER_MS);
	const proposalCleanupCutoff = new Date(
		startedAtMs - PROPOSAL_UPLOAD_SIGNING_WINDOW_MS,
	);
	const validatingCutoff = new Date(startedAtMs - VALIDATING_STALE_AFTER_MS);
	const deferredScanCutoff = new Date(
		startedAtMs - DEFERRED_SCAN_STALE_AFTER_MS,
	);
	// Spent across all phases, not per phase.
	const objectBudget: StorageBudget = {
		remaining: MAX_STORAGE_OBJECTS_PER_RUN,
	};
	let budgetStopped = false;
	/**
	 * True when a global budget is spent. Checked before each row and each
	 * project, never mid-unit: a unit of work here is a row write followed by
	 * its storage, and stopping between those two is the one ordering this
	 * feature does not allow.
	 */
	const outOfBudget = (phase: string): boolean => {
		const objects = objectBudget.remaining <= 0;
		const time = Date.now() - startedAtMs >= RUN_TIME_BUDGET_MS;
		if (!objects && !time) {
			return false;
		}
		if (!budgetStopped) {
			// Once per run: the first phase to hit it is the informative one,
			// and every later check would say the same thing.
			logger.warn(
				{
					event: "instructions.reaper.budget_exhausted",
					// Which budget, and counts only.
					budget: objects ? "objects" : "time",
					phase,
					objectsRemaining: objectBudget.remaining,
					elapsedMs: Date.now() - startedAtMs,
				},
				"[InstructionReaper] Global run budget spent; the remainder is next run's work",
			);
		}
		budgetStopped = true;
		return true;
	};

	logger.info(
		{
			event: "instructions.reaper.started",
			cutoffAt: cutoff.toISOString(),
			validatingCutoffAt: validatingCutoff.toISOString(),
			deferredScanCutoffAt: deferredScanCutoff.toISOString(),
			maxAbandoned: MAX_ABANDONED_PER_RUN,
			maxStaleValidating: MAX_STALE_VALIDATING_PER_RUN,
			maxStaleDeferredScans: MAX_STALE_DEFERRED_SCAN_PER_RUN,
			maxPruneProjects: MAX_PRUNE_PROJECTS_PER_RUN,
			maxStorageObjects: MAX_STORAGE_OBJECTS_PER_RUN,
			runTimeBudgetMs: RUN_TIME_BUDGET_MS,
		},
		"[InstructionReaper] Starting sweep run",
	);

	const staleValidating = await listStaleValidatingInstructionSnapshots(
		validatingCutoff,
		MAX_STALE_VALIDATING_PER_RUN,
	);
	// ROTATED, unlike phase 0's page: see `selectRotatedSlice`. A row this
	// phase skips (RUNNING, or liveness unknown) is not written and keeps its
	// place, so a fixed oldest page could be the same hundred rows every hour.
	const staleDeferredScans = await selectRotatedSlice(
		(limit, offset) =>
			listStaleDeferredScanInstructionSnapshots(
				deferredScanCutoff,
				limit,
				offset,
			),
		MAX_STALE_DEFERRED_SCAN_PER_RUN,
		startedAtMs,
		(row) => row.id,
	);
	const abandoned = await listAbandonedReceivingInstructionSnapshots(
		cutoff,
		MAX_ABANDONED_PER_RUN,
	);
	// Acquired once per run, and only because phases 0, 0b and 1 need it —
	// phases 1b and 3 work on rows whose verdict is already written. A client
	// that will not construct is an UNKNOWN, not a licence to write a verdict:
	// every candidate of those phases is then counted in `errorCount` and left
	// for the next run, exactly as an unreachable `describe` would be.
	const livenessCandidates =
		staleValidating.length + staleDeferredScans.length + abandoned.length;
	let temporalClient: Client | null = null;
	if (livenessCandidates > 0) {
		try {
			temporalClient = await getTemporalClient();
		} catch (err) {
			logger.warn(
				{
					event: "instructions.reaper.temporal_unavailable",
					candidates: livenessCandidates,
					...errorFacts(err),
				},
				"[InstructionReaper] Temporal client unavailable; no row can be proven dead this run",
			);
		}
	}
	let rejected = 0;
	let healedValidating = 0;
	let incompleteDeferredScans = 0;
	let skippedLive = 0;
	let stagingObjectsDeleted = 0;
	let storageTruncated = false;
	let errorCount = 0;

	// PHASE 0: rows stranded in VALIDATING with no execution behind them.
	//
	// VALIDATING normally means a workflow owns the row and will write its
	// verdict either way, so nothing else may touch it. Three things break
	// that, and they leave the same row:
	//
	//  - `finalize` starts the workflow and THEN writes VALIDATING. When that
	//    write is slow enough, the run it belongs to can reach the end of its
	//    retries and close first: the boundary catch's FAILED marker matches a
	//    row that still says FAILED and does nothing, and the delayed write
	//    then lands on top, leaving VALIDATING behind a closed execution.
	//  - a worker that dies between the gate's claim and the boundary catch
	//    never writes a marker at all.
	//  - any other way a failure marker is lost.
	//
	// This phase HEALS that; it cannot prevent it. Preventing it needs an
	// ownership token on the row — a validation generation the API transition,
	// the activity claim and the failure marker all carry — which is a schema
	// change deliberately outside this change, and is tracked as a follow-up.
	// Until then the row is recovered within a cycle or two of the sweep
	// instead of polling forever with no "Try again" offered.
	//
	// The evidence is the EXECUTION, never the age alone: `describe` must say
	// the workflow is closed, or that Temporal has never heard of the id at
	// all. A running execution is exactly why a row is legitimately VALIDATING
	// and is skipped; an unreachable Temporal proves nothing and is counted,
	// like everywhere else here. The threshold decides only which rows are
	// worth ASKING about — a legitimate run can exceed it (see
	// `VALIDATING_STALE_AFTER_MS`), so nothing here may be decided on age.
	//
	// `describe` and the write are still two operations, so the write carries
	// the row version the describe was about: `failStaleValidatingInstructionSnapshot`
	// puts the `updatedAt` this candidate was listed with into its own WHERE
	// clause. Anything that touched the row in between — `finalize` starting a
	// newer run, an activity claim, a real verdict — moved that timestamp, so
	// the write matches nothing and the row is left alone. That is also what
	// makes this phase safe under Temporal's at-least-once delivery: a stalled
	// attempt that wakes after a newer generation has begun can no longer
	// match it. `failInstructionSnapshot`, whose predicate is any
	// RECEIVING/VALIDATING row, is deliberately NOT used here.
	//
	// NO storage work: a FAILED row keeps its staging objects on purpose,
	// because "Try again" re-runs the workflow over them. Its objects leave
	// with the retention prune, phase 3's job.
	for (const row of staleValidating) {
		if (outOfBudget("heal-validating")) {
			break;
		}
		safeHeartbeat({ phase: "heal-validating", snapshotId: row.id });
		const liveness =
			temporalClient === null
				? "unknown"
				: await describeSnapshotWorkflow(temporalClient, row.id);
		if (liveness === "running") {
			skippedLive++;
			continue;
		}
		if (liveness === "unknown") {
			// Cannot be proven dead. Counted so a Temporal outage shows up
			// rather than reading as a quiet run, and left for the next run.
			errorCount++;
			continue;
		}
		const { changed } = await failStaleValidatingInstructionSnapshot({
			snapshotId: row.id,
			projectId: row.projectId,
			organizationId: row.organizationId,
			// The version this run described, not "whatever is there now".
			observedUpdatedAt: row.updatedAt,
		});
		if (changed) {
			healedValidating++;
		}
	}

	logger.info(
		{
			event: "instructions.reaper.validating_healed",
			// Counts only: an id here names a project and a snapshot.
			scanned: staleValidating.length,
			healed: healedValidating,
			skippedLive,
		},
		`[InstructionReaper] Healed ${healedValidating} snapshot(s) stranded in VALIDATING`,
	);

	// PHASE 0b: publish-first versions whose deferred secret scan will never
	// report (Fizzy #2737).
	//
	// The same shape as phase 0, for the same kind of row: one whose owner is
	// a workflow that records a verdict whichever way the scan goes — until
	// that workflow is gone. A publish step that exhausted its retries, an
	// outcome write that failed, a termination or an execution timeout all
	// leave the version READY with its scan PENDING, readable and never
	// checked, and nothing else would ever move it.
	//
	// The verdict written is INCOMPLETE, never PASSED: nothing was found
	// because nothing looked, and the tab says exactly that. Nothing is
	// withdrawn or unpublished — the version stays as it is, and the member
	// decides (spec decision).
	//
	// The evidence is the EXECUTION, never the age alone, exactly as in phase
	// 0: `readyAt` older than `DEFERRED_SCAN_STALE_AFTER_MS` only makes a row
	// worth asking about; a running execution is skipped, an unreachable
	// Temporal is counted and left, and only a closed or unknown-to-Temporal
	// execution is closed out. The write is a compare-and-set on the
	// `updatedAt` the candidate was listed with AND on the scan still being
	// PENDING, so a verdict the workflow recorded after `describe` answered
	// makes it match nothing. Its audit row commits with it.
	//
	// NO storage work: the version's objects are its published bytes.
	for (const row of staleDeferredScans) {
		if (outOfBudget("close-deferred-scan")) {
			break;
		}
		safeHeartbeat({ phase: "close-deferred-scan", snapshotId: row.id });
		const liveness =
			temporalClient === null
				? "unknown"
				: await describeSnapshotWorkflow(temporalClient, row.id);
		if (liveness === "running") {
			skippedLive++;
			continue;
		}
		if (liveness === "unknown") {
			errorCount++;
			continue;
		}
		const { changed } = await markStaleDeferredScanIncomplete({
			snapshotId: row.id,
			projectId: row.projectId,
			organizationId: row.organizationId,
			observedUpdatedAt: row.updatedAt,
		});
		if (changed) {
			incompleteDeferredScans++;
		}
	}

	logger.info(
		{
			event: "instructions.reaper.deferred_scans_closed",
			// Counts only, as above.
			scanned: staleDeferredScans.length,
			incomplete: incompleteDeferredScans,
		},
		`[InstructionReaper] Recorded ${incompleteDeferredScans} stranded deferred scan(s) as incomplete`,
	);
	// Every id phase 1 closed out in THIS run, swept or not. Phase 1b selects
	// on the pending mark the rejection above just wrote, so without this the
	// rows phase 1 has already dealt with seconds ago would come straight
	// back and spend its budget — and a full page of them would report a
	// backlog that does not exist. The exclusion goes into phase 1b's QUERY,
	// so `take` still returns a page of real work.
	const closedThisRun: string[] = [];
	for (const row of abandoned) {
		if (outOfBudget("reject-abandoned")) {
			break;
		}
		safeHeartbeat({ phase: "reject-abandoned", snapshotId: row.id });
		// LIVENESS FIRST, because the status column alone cannot answer it.
		// `finalize` starts the workflow before it writes VALIDATING and
		// tolerates losing that write, so a RECEIVING row six hours old can
		// still have a workflow behind it that is about to read these exact
		// staging objects.
		//
		// `describe` and the conditional write below are two statements, so a
		// `finalize` that starts a workflow in the milliseconds between them
		// is not seen here. That is no longer a correctness residual: the
		// verdict is decided on the ROW. `verifyAndScanInstructionFiles`
		// claims the snapshot RECEIVING -> VALIDATING before it reads any
		// object — only RECEIVING, because an activity attempt cannot prove it
		// still owns a FAILED row; a retry from FAILED waits for the finalize
		// API's own transition instead — and the write below requires
		// RECEIVING, so whichever commits first leaves the other matching
		// nothing. A run that lost neither scans nor promotes, while its
		// boundary catch writes FAILED only from RECEIVING/VALIDATING and so
		// leaves the reaper's REJECTED row alone. What this check still buys
		// is the needless verdict avoided on an execution that is merely
		// QUEUED: started, not yet claimed, and a live upload all the same.
		//
		// Only a RUNNING execution counts here (design 2026-09-23 §5.7). A
		// closed one that claimed the row moved it off RECEIVING, so the
		// conditional write below matches nothing; a closed one that did NOT
		// claim it (terminated or timed out before its first activity) left a
		// row nothing else will ever close, and is abandoned like a missing one.
		const liveness =
			temporalClient === null
				? "unknown"
				: await describeSnapshotWorkflow(temporalClient, row.id);
		if (liveness === "running") {
			skippedLive++;
			continue;
		}
		if (liveness === "unknown") {
			// Cannot be proven dead. Counted so a Temporal outage shows up
			// rather than reading as a quiet run, and left for the next run.
			errorCount++;
			continue;
		}
		// The verdict SECOND, as one conditional write whose predicate still
		// names RECEIVING and the cutoff. A `finalize` that arrived between
		// the candidate query and this statement has already moved the row to
		// VALIDATING, and that upload is alive: it matches nothing here, and
		// its staging objects are left exactly where its own workflow expects
		// to find them.
		const { changed } = await rejectAbandonedInstructionSnapshot({
			snapshotId: row.id,
			projectId: row.projectId,
			organizationId: row.organizationId,
			cutoff,
		});
		if (!changed) {
			continue;
		}
		rejected++;
		closedThisRun.push(row.id);
		// Objects SECOND, and only for a row this run actually closed out.
		// A storage failure here is counted and passed over rather than
		// thrown: the row keeps its pending mark, so phase 1b rediscovers it
		// on the next run, and the other candidates — every one of them a
		// different tenant — still get their turn in this one.
		const swept = await sweepClosedAbandonment(
			storage,
			row,
			"reject-abandoned",
			objectBudget,
		);
		stagingObjectsDeleted += swept.deleted;
		storageTruncated ||= swept.truncated;
		if (swept.failed) {
			errorCount++;
		}
	}

	logger.info(
		{
			event: "instructions.reaper.abandoned_closed",
			scanned: abandoned.length,
			rejected,
			skippedLive,
			stagingObjectsDeleted,
		},
		`[InstructionReaper] Closed out ${rejected} abandoned upload(s)`,
	);

	// PHASE 1b: the residue phase 1 cannot reach.
	//
	// The transition above commits before its objects are deleted, so an
	// attempt that dies in that gap — or one whose `deleteObjects` reported
	// failures — leaves staged, possibly secret-bearing bytes behind under a
	// row that is REJECTED now and therefore invisible to the RECEIVING
	// candidate query. Retrying the activity does not help: the row it would
	// have to revisit is no longer a candidate.
	//
	// So those rows are rediscovered by the mark they still carry —
	// `ABANDONED_STAGING_PENDING` on their one rejection element, which only
	// a completed sweep rewrites — and their prefixes are swept again.
	// Deleting under a REJECTED row's prefix races nothing (REJECTED is
	// terminal; `finalize` moves RECEIVING/FAILED only), and the sweep is
	// idempotent: an already-empty prefix costs one list call and no deletes.
	// Nothing here is re-audited or counted as `rejected` — the verdict was
	// recorded once, by the attempt that made it.
	//
	// Eligibility is the mark, not a time window, and `updatedAt` only
	// ORDERS: oldest pending first, each failure rotated to the back. That
	// separation is the point — the previous design used one timestamp for
	// both, so a successful sweep renewed the eligibility it was meant to
	// end and cleanly finished rows circled the queue forever.
	//
	// The phase is skipped WHOLE when a global budget is already spent —
	// candidate query included. There is nothing to select for: every row it
	// returned would be dropped by the check inside the loop, and the query
	// itself is not free.
	const pending = outOfBudget("resweep-abandoned")
		? []
		: await listPendingAbandonedInstructionSnapshots(
				MAX_RESWEPT_ABANDONED_PER_RUN,
				closedThisRun,
				proposalCleanupCutoff,
			);
	let resweptAbandoned = 0;
	for (const row of pending) {
		if (outOfBudget("resweep-abandoned")) {
			break;
		}
		safeHeartbeat({ phase: "resweep-abandoned", snapshotId: row.id });
		const swept = await sweepClosedAbandonment(
			storage,
			row,
			"resweep-abandoned",
			objectBudget,
		);
		stagingObjectsDeleted += swept.deleted;
		storageTruncated ||= swept.truncated;
		// Attempted, not finished: a row whose sweep failed is counted here
		// and in `errorCount`, and is still pending for the next run.
		resweptAbandoned++;
		if (swept.failed) {
			errorCount++;
		}
	}

	logger.info(
		{
			event: "instructions.reaper.abandoned_reswept",
			reswept: resweptAbandoned,
			stagingObjectsDeleted,
		},
		`[InstructionReaper] Re-checked the staging prefix of ${resweptAbandoned} closed abandonment(s)`,
	);

	// PHASE 3: the failure-path prune, on a ROTATING page of candidates.
	//
	// The candidate query orders the whole candidate population, so a fixed
	// page is the same page every hour. A project whose prune keeps failing,
	// or whose backlog is deeper than one run can drain, stays a candidate
	// forever — and every project sorting after the slice is then never
	// visited at all, not slowly but NEVER. Unlike the abandonment phases,
	// which drain in age order and re-date their failures to the back, this
	// query has no cursor of its own.
	//
	// So the offset advances one whole slice per hour and wraps at the size of
	// the candidate population (see `selectPruneCandidates`). It is derived
	// from the clock rather than persisted because there is nowhere to persist
	// it that would not be a schema change, and a schedule that skips a tick
	// must not re-walk the page the skipped tick would have walked.
	//
	// Skipped WHOLE — candidate queries included — when a global budget is
	// already spent, for the same reason phase 1b is.
	const keep = {
		ready: SNAPSHOT_RETENTION,
		rejected: FAILED_SNAPSHOT_RETENTION,
	};
	const projects = outOfBudget("prune")
		? []
		: await selectPruneCandidates(keep, startedAtMs);
	let projectsPruned = 0;
	let snapshotsPruned = 0;
	for (const project of projects) {
		if (outOfBudget("prune")) {
			break;
		}
		safeHeartbeat({ phase: "prune", projectId: project.projectId });
		try {
			const prune = await pruneProjectInstructionSnapshots(
				storage,
				project.projectId,
				project.organizationId,
				objectBudget,
			);
			projectsPruned++;
			snapshotsPruned += prune.deleted;
			storageTruncated ||= prune.storageTruncated;
		} catch (err) {
			// Counted and carried past — see the failure policy at the top —
			// with the error's CLASS and code only, never its message (see
			// `errorFacts`).
			errorCount++;
			logger.error(
				{
					event: "instructions.reaper.prune_error",
					projectId: project.projectId,
					organizationId: project.organizationId,
					...errorFacts(err),
				},
				"[InstructionReaper] Prune failed for one project; continuing",
			);
		}
	}

	const result: ReapInstructionSnapshotsResult = {
		scanned: abandoned.length,
		rejected,
		staleValidating: staleValidating.length,
		healedValidating,
		staleDeferredScans: staleDeferredScans.length,
		incompleteDeferredScans,
		skippedLive,
		resweptAbandoned,
		stagingObjectsDeleted,
		projectsPruned,
		snapshotsPruned,
		errorCount,
		storageTruncated,
		// The pending list is in here too, off the RAW length of a query that
		// already excluded this run's phase-1 rows: a full page there is a
		// genuine backlog of un-swept abandonments, not the rows phase 1 just
		// finished coming round again, and a run that filled it must not
		// report itself as quiet. A global budget that stopped a phase counts
		// the same way: there is more to do, and the next run does it.
		hitCap:
			budgetStopped ||
			staleValidating.length >= MAX_STALE_VALIDATING_PER_RUN ||
			staleDeferredScans.length >= MAX_STALE_DEFERRED_SCAN_PER_RUN ||
			abandoned.length >= MAX_ABANDONED_PER_RUN ||
			pending.length >= MAX_RESWEPT_ABANDONED_PER_RUN ||
			projects.length >= MAX_PRUNE_PROJECTS_PER_RUN,
		cutoffAt: cutoff.toISOString(),
	};

	if (result.storageTruncated) {
		logger.warn(
			// Counts only: a key names a project, a snapshot and a file.
			{
				event: "instructions.reaper.storage_truncated",
				maxPrefixPages: MAX_PREFIX_PAGES,
				stagingObjectsDeleted,
				snapshotsPruned,
			},
			"[InstructionReaper] A prefix sweep stopped at its page or object budget; the remainder is the bucket lifecycle rule's work or the next run's",
		);
	}
	if (result.hitCap) {
		logger.warn(
			{ event: "instructions.reaper.cap_hit", ...result },
			"[InstructionReaper] Per-run budget reached; the remainder is next run's work",
		);
	}
	logger.info(
		{ event: "instructions.reaper.completed", ...result },
		`[InstructionReaper] Rejected ${rejected} abandoned upload(s) and pruned ${snapshotsPruned} snapshot(s) across ${projectsPruned} project(s)`,
	);
	return result;
}
