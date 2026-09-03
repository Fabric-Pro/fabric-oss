/**
 * Publishing Suggestion — per-project dispatch activity (Publishing Suite 1A,
 * Task 10). Mirrors `dispatch-newsletter-send.ts` (createOrGet + deterministic
 * `client.workflow.start` + `WorkflowExecutionAlreadyStartedError` no-op) and
 * the `isWorkflowStillRunning` liveness guard from
 * `packages/api/modules/daily-brief/lib/request-regeneration.ts` — but the
 * liveness guard here is TRI-STATE (M11/P4), not a boolean.
 *
 * Idempotency (N2): two layers. (1) The active-`GENERATING` partial index on
 * `PublishingSuggestionCycle` dedupes CONCURRENT dispatches of the same project.
 * (2) A stable per-dispatch-run `occurrenceKey` (the dispatcher workflow's
 * deterministic runId) dedupes RETRIES of THIS activity across time: if `start`
 * landed but the activity completion was lost, Temporal retries, and by then the
 * generation workflow may have terminalized the cycle (READY/etc.) — freeing the
 * partial-index slot. `createOrGetPublishingCycle` recovers the SAME cycle by
 * (projectId, occurrenceKey) regardless of status, so no duplicate cycle is
 * created. Either way the deterministic `publishing-suggestion-<cycleId>` id
 * makes `start` a safe `WorkflowExecutionAlreadyStartedError` no-op.
 *
 * Recovery (tri-state reclaim): a stale `GENERATING` cycle is CAS-flipped to
 * `FAILED` — releasing the partial-index slot — ONLY when the hard 2h timeout
 * has passed OR the cycle is past the start grace AND its workflow is provably
 * dead. A transient Temporal outage is UNKNOWN and never reclaims: it must not
 * steal a live cycle. The reclaim check runs BEFORE the cost guard so a quiet
 * project (no new context) still frees a stuck GENERATING cycle left behind
 * by a dead worker — otherwise the cost guard's early return would strand it
 * forever on a project that never accrues new content again.
 *
 * 1C-1: `dispatchPublishingSuggestion` (the Temporal activity, `heartbeat()`
 * and all) is a thin wrapper around `runPublishingSuggestionDispatch` (the
 * plain function, no Worker/activity-context dependency). The split exists so
 * the manual "Generate now" trigger — invoked from the API process, never
 * inside a Temporal Worker — can call the SAME create-or-get/tenant/liveness
 * logic without tripping `Context.current()` throwing outside an activity
 * execution.
 */

import {
	buildPublishingPreferencesSnapshot,
	computePublishingPreferencesHash,
	countNewContextSince,
	createOrGetPublishingCycle,
	db,
	ensureRunningBackgroundJob,
	failBackgroundJob,
	getLastCountedPublishingRunPreferencesHash,
	getPublishingSuiteSettings,
	type SourceCoverage,
} from "@repo/database";
import { heartbeat } from "@temporalio/activity";
import {
	WorkflowExecutionAlreadyStartedError,
	WorkflowNotFoundError,
} from "@temporalio/client";
import { getTemporalClient } from "../../client";
import type { PublishingSuggestionWorkflowInput } from "../../workflows/publishing-suggestion-generation-workflow";
import { JOB_STEPS, seedJobSteps } from "../lib/job-progress";
import {
	type EligibleProject,
	isPublishingSuiteEnabledForOrganizationUncached,
} from "./find-eligible-projects";

// A create→start may not have landed for a just-created cycle; never reclaim
// one younger than this. Mirrors the daily-brief STALE_GENERATING window's
// intent, but bounds the create→start-orphan case tightly (well under the 2h
// executionTimeoutAt) so an orphan is reclaimed minutes after grace, not hours.
const START_GRACE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * The suggestion workflow's execution timeout — the point past which the
 * generation step provably cannot still be running.
 *
 * EXPORTED because it has a second reader: 1C-2d-2a's reconciliation sweep
 * defines a stale `PENDING` cycle as one older than exactly this bound
 * (parent §9.7 rule 3), and the spec instructs verifying that value at
 * implementation time rather than copying it. A copy is the drift class this
 * project has already been bitten by — a "one-word" default that turned out to
 * be three duplicated literals — so the value has ONE representation and every
 * reader imports it.
 *
 * That is why `workflowExecutionTimeout` below is passed this number rather
 * than the string "2h": @temporalio/common's `Duration` is `StringValue |
 * number`, a number being milliseconds, so the string form bought nothing and
 * cost a second place to change.
 */
export const PUBLISHING_SUGGESTION_EXECUTION_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Tri-state liveness of a workflow execution. */
export type Liveness = "RUNNING" | "DEAD" | "UNKNOWN";

/**
 * Tri-state mirror of `isWorkflowStillRunning`. Distinguishes a DEFINITE
 * `WorkflowNotFoundError` (execution provably absent) from an ambiguous describe
 * failure (transient outage) — the single most important correctness point:
 *
 *   - definite `WorkflowNotFoundError`: within grace → `"UNKNOWN"` (a
 *     create→start may not have landed); past grace → `"DEAD"` (the
 *     create→start-orphan case — reclaim BEFORE the 2h timeout, not stranded
 *     until it).
 *   - any OTHER describe failure / Temporal-unavailable / `describe()` throw →
 *     `"UNKNOWN"` → never reclaim (a transient outage must not steal a live
 *     cycle).
 *   - `RUNNING`/`CONTINUED_AS_NEW` → `"RUNNING"`; a terminal describe status
 *     (COMPLETED/FAILED/CANCELED/TERMINATED/TIMED_OUT) → `"DEAD"`.
 *
 * The workflowId is always the deterministic `publishing-suggestion-<cycleId>`
 * — this function never reads the nullable `temporalWorkflowId`.
 */
export async function livenessOf(
	workflowId: string,
	startedAt: Date,
	now: Date,
): Promise<Liveness> {
	const withinGrace = now.getTime() - startedAt.getTime() <= START_GRACE_MS;
	let client: Awaited<ReturnType<typeof getTemporalClient>>;
	try {
		client = await getTemporalClient();
	} catch {
		// Cannot even reach Temporal — ambiguous, never reclaim.
		return "UNKNOWN";
	}
	try {
		const handle = client.workflow.getHandle(workflowId);
		const desc = await handle.describe();
		// WorkflowExecutionStatus names: RUNNING, COMPLETED, FAILED, CANCELED,
		// TERMINATED, CONTINUED_AS_NEW, TIMED_OUT. describe() resolves the LATEST
		// run, so a workflow mid-continueAsNew reports RUNNING.
		const status = desc.status.name;
		if (status === "RUNNING" || status === "CONTINUED_AS_NEW") {
			return "RUNNING";
		}
		return "DEAD";
	} catch (err) {
		// Only a DEFINITE not-found proves the execution is absent. Every other
		// throw (deadline exceeded, connection reset, namespace hiccup) is
		// ambiguous and must NOT be treated as dead.
		if (err instanceof WorkflowNotFoundError) {
			return withinGrace ? "UNKNOWN" : "DEAD";
		}
		return "UNKNOWN";
	}
}

/**
 * Reclaim decision for an existing `GENERATING` cycle (CAS-eligible when true):
 *   - `now > executionTimeoutAt` → reclaim REGARDLESS of liveness (hard timeout
 *     overrides everything; liveness is not even probed).
 *   - else reclaim only when past the start grace AND the workflow is DEAD.
 */
async function shouldReclaim(
	cycle: { id: string; startedAt: Date; executionTimeoutAt: Date | null },
	now: Date,
): Promise<boolean> {
	if (
		cycle.executionTimeoutAt &&
		now.getTime() > cycle.executionTimeoutAt.getTime()
	) {
		return true;
	}
	const workflowId = `publishing-suggestion-${cycle.id}`;
	const liveness = await livenessOf(workflowId, cycle.startedAt, now);
	return (
		liveness === "DEAD" &&
		now.getTime() - cycle.startedAt.getTime() > START_GRACE_MS
	);
}

export interface DispatchPublishingSuggestionInput extends EligibleProject {
	/**
	 * N2 (retry-idempotency): the dispatcher workflow's deterministic runId — a
	 * stable per-dispatch-run occurrence key. Constant across THIS activity's
	 * Temporal retries within one dispatcher execution and distinct per daily run;
	 * passed as `occurrenceKey` to createOrGetPublishingCycle so a retry (whose
	 * completion was lost after `start` landed) reuses the SAME cycle — even one
	 * the generation workflow already terminalized — instead of spawning a
	 * duplicate cycle + second workflow. Optional so non-workflow callers keep the
	 * legacy active-GENERATING-only idempotency; the production workflow always
	 * supplies it.
	 */
	dispatcherRunId?: string;
	/**
	 * 1C-1: the manual "Generate now" trigger. Bypasses the cost guard below and
	 * the workflow's F7 freshness gate (never sufficiency). Absent/false for the
	 * daily sweep — Task 5 does not set this.
	 */
	force?: boolean;
	/**
	 * Audit breadcrumb only (1C-1 follow-up): the user who clicked "Generate
	 * now", threaded straight through to `createOrGetPublishingCycle` and
	 * persisted as `PublishingSuggestionCycle.triggeredByUserId`. The scheduled
	 * sweep never sets this — it stays undefined → NULL. Deliberately NOT added
	 * to `PublishingSuggestionWorkflowInput`: the workflow has no use for it, and
	 * a new workflow-input field is a replay-determinism surface this fix does
	 * not need to open.
	 */
	triggeredByUserId?: string;
}

export async function dispatchPublishingSuggestion(
	input: DispatchPublishingSuggestionInput,
): Promise<void> {
	heartbeat(`dispatchPublishingSuggestion: ${input.projectId}`);
	return runPublishingSuggestionDispatch(input);
}

/**
 * Open the Job Hub row for a cycle whose workflow is now running (Fizzy #1850).
 *
 * NOT `jobEnsure`. That helper resolves the workflow id from the current
 * activity context, and neither dispatch path gives the right answer: on the
 * scheduled sweep the context is the DISPATCHER's execution, and on the manual
 * "Generate now" path there is no activity context at all, so every call would
 * silently no-op — a miss with no error to notice. The id is passed explicitly
 * instead, matching what `client.workflow.start` was just given.
 *
 * `userId` is the project OWNER. That is what the Job Hub's tenant filter
 * matches on in personal context, so a row keyed to whoever clicked "Generate
 * now" would be invisible to the project's own owner. It is a tenancy key, not
 * an authorship claim — authorship is recorded separately on
 * `PublishingSuggestionCycle.triggeredByUserId`.
 *
 * Best-effort, like every job writer: by the time this runs the workflow is
 * already started, and telemetry must never fail a dispatch. The generation
 * workflow's first activity re-ensures this row, so a miss here is recovered
 * rather than lost — this write is the optimization that makes the panel react
 * to a click immediately, not the guarantee.
 */
/**
 * Error class stamped on a row whose workflow could not be started, and the
 * class the dispatch reopens. Distinct from the watchdog's "TimedOut", which is
 * the generation activity's reopen class: each writer heals only the failure it
 * can reason about, and neither resurrects a row failed for a real reason.
 */
const START_FAILED_ERROR_CLASS = "PublishingStartFailed";

/**
 * How long a dispatch will wait on a job write before giving up on it.
 *
 * `safely()` in `job-progress` swallows a writer that THROWS; nothing bounds one
 * that merely HANGS, and on the manual "Generate now" path this code runs inside
 * an HTTP handler — an unbounded telemetry write there would turn a slow
 * database into a hung request. The generation workflow's first activity
 * re-ensures the row anyway, so abandoning the wait costs nothing but the
 * moment of immediacy.
 */
const JOB_WRITE_TIMEOUT_MS = 5_000;

/** Await a job write, but never longer than `JOB_WRITE_TIMEOUT_MS`. */
async function boundedJobWrite(write: () => Promise<unknown>): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			write(),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, JOB_WRITE_TIMEOUT_MS);
			}),
		]);
	} catch {
		// Best-effort telemetry.
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

async function openPublishingJobRow(args: {
	cycleId: string;
	projectId: string;
	ownerUserId: string;
	organizationId: string | null;
}): Promise<void> {
	await boundedJobWrite(() =>
		ensureRunningBackgroundJob({
			kind: "PUBLISHING_TOPIC_GENERATION",
			title: "Topic suggestions",
			projectId: args.projectId,
			userId: args.ownerUserId,
			organizationId: args.organizationId,
			workflowId: `publishing-suggestion-${args.cycleId}`,
			sourceId: null,
			steps: seedJobSteps([...JOB_STEPS.publishingTopicGeneration]),
			// A start failure re-throws so Temporal retries this activity; the
			// retry must reopen the row it failed rather than open a second one.
			reopenFailedWithClass: START_FAILED_ERROR_CLASS,
		}),
	);
}

/**
 * Close the row for a workflow that could not be started.
 *
 * Without this the row would sit RUNNING, claiming a run that does not exist,
 * until the watchdog failed it 45 minutes later with "no progress reported" —
 * which would be true and useless. The real transport error is more use, and
 * stamping `START_FAILED_ERROR_CLASS` is what lets the retry reopen this exact
 * row.
 */
async function failPublishingJobRow(
	cycleId: string,
	error: unknown,
): Promise<void> {
	await boundedJobWrite(() =>
		failBackgroundJob(
			{
				workflowId: `publishing-suggestion-${cycleId}`,
				sourceId: null,
			},
			{
				error:
					error instanceof Error
						? `Could not start the generation run: ${error.message}`
						: "Could not start the generation run.",
				errorClass: START_FAILED_ERROR_CLASS,
			},
		),
	);
}

/**
 * The activity body, minus the Temporal `heartbeat()` call. `heartbeat()`
 * (from `@temporalio/activity`) reaches `Context.current()`, which throws
 * outside a Worker's activity-execution context — so this function, unlike
 * `dispatchPublishingSuggestion` above, is safe to call directly from a
 * non-worker process. It is the SAME create-or-get + tenant re-read + XOR
 * normalization + liveness reclaim + deterministic-start logic either way;
 * nothing below this comment differs from what the daily sweep runs.
 *
 * 1C-1: this is also the manual "Generate now" entry point (via the
 * `@repo/temporal/activities/publishing-suggestion` export, called from
 * `packages/api/modules/projects/lib/request-publishing-generation.ts`). A
 * manual call omits `dispatcherRunId`, so `occurrenceKey` below resolves to
 * `undefined` → NULL, matching the schema's "NULL for manual/legacy rows"
 * (no synthetic key is invented for it).
 */
export async function runPublishingSuggestionDispatch(
	input: DispatchPublishingSuggestionInput,
): Promise<void> {
	const { projectId, dispatcherRunId, triggeredByUserId } = input;
	// Time is read HERE (server activity), never in the dispatcher workflow (N6).
	const now = new Date();

	// H4: point-of-use fresh read + XOR-normalize. Do NOT trust the sweep item —
	// the project may have been deleted, transferred, or org-changed between the
	// sweep and this dispatch. Every downstream call uses these fresh values.
	//
	// F3: re-apply the sweep's eligibility filter — status ACTIVE, deletedAt null
	// (mirrored VERBATIM from find-eligible-projects.ts, and the same columns F1
	// re-checks in persistCycleTerminal) PLUS the organization PUBLISHING_SUITE
	// gate re-checked just below, against the fresh organizationId, once it is
	// known. A bare `{ id }` lookup would let a project archived / soft-deleted
	// BETWEEN the sweep and this dispatch still pass; the eligibility conjuncts
	// make an ineligible project read as null → skip (no cycle created, no
	// workflow started), distinct from a hard-missing row (both resolve null
	// here → both skip).
	const fresh = await db.project.findFirst({
		where: { id: projectId, status: "ACTIVE", deletedAt: null },
		select: { id: true, userId: true, organizationId: true },
	});
	if (fresh === null) {
		return; // deleted/archived/ineligible between sweep and dispatch — skip.
	}

	const actorUserId = fresh.userId; // raw owner (non-null) — AI-usage actor.
	const organizationId = fresh.organizationId ?? null;
	// XOR-normalized so the created cycle satisfies the tenant-XOR CHECK (F1):
	// org context → userId null; personal context → userId = owner.
	const tenantUserId = fresh.organizationId ? null : fresh.userId;

	// F3 (organization dimension): re-check PUBLISHING_SUITE against the FRESH
	// organizationId just read above — never the sweep's. The sweep
	// (findEligibleProjects) filters by organization, but a project selected
	// while its organization was allowed can still be transferred into a
	// disabled organization, or have its organization disabled, between the
	// sweep and this dispatch; without this re-check that project would create
	// a cycle and start a generation workflow anyway — the one path that spends
	// model-inference cost.
	//
	// Codex fix round 2 (§E): this MUST be uncached. `isFeatureEnabled` (the
	// obvious choice) resolves org override > global override > env var >
	// registry default, but its global read goes through `getFlagOverrides`'s
	// 10-second TTL cache — and dispatch normally runs within seconds of the
	// sweep that selected this project, so a cached read here would usually
	// just be re-reading the SWEEP's own answer, making this re-check a no-op
	// for exactly the window it exists to close. `resolvePublishingSuiteGlobalUncached`
	// (via `isPublishingSuiteEnabledForOrganizationUncached`) is the fix
	// round 2 (§FIX 2) uncached global reader, reused here — the same reasoning
	// applies with even higher stakes: this is the LAST gate before an LLM
	// generation actually starts. Per ADR-018 ("An organization is the only
	// tenant context"), a project that resolves to no organization here — e.g.
	// transferred OUT of its organization between the sweep and this dispatch
	// — is refused (`false`, no flag read), the same as at the sweep and the
	// API gate; it is NOT routed into the global/env/default chain. See that
	// function's own docstring.
	const flagEnabled =
		await isPublishingSuiteEnabledForOrganizationUncached(organizationId);
	if (!flagEnabled) {
		return; // organization disabled/removed between sweep and dispatch — skip.
	}

	// priorCoverage = the last SUCCESSFUL cycle's cumulative coverage. An
	// intervening INSUFFICIENT_CONTEXT/FAILED cycle advances NO coverage and
	// persists {}, so reading merely "the last cycle" would reset the baseline
	// and re-classify aged content as fresh.
	//
	// F2: scope this read by the FRESH normalized tenant tuple, not just
	// projectId. After an org transfer the old tenant's success cycles must not
	// seed the new tenant's watermarks — a just-transferred project starts from
	// {} coverage so nothing from the prior tenant is silently treated as
	// already-covered.
	const lastSuccessful = await db.publishingSuggestionCycle.findFirst({
		where: {
			projectId: fresh.id,
			organizationId,
			userId: tenantUserId,
			status: { in: ["READY", "NO_TOPICS"] },
		},
		orderBy: { completedAt: "desc" },
		select: { sourceCoverage: true },
	});
	const priorCoverage = (lastSuccessful?.sourceCoverage ??
		{}) as SourceCoverage;

	// 1C-1b (§7.1): the preferences fingerprint, and the comparison that buys a
	// project ONE reprocessing run after a settings change.
	//
	// This has to happen BEFORE the cost guard, not merely before the workflow
	// input is built. The guard returns early — no cycle, no workflow — so for a
	// project with no ACTIVE repo integration and no new local content, threading
	// a bypass into the workflow input would arrive too late to matter: dispatch
	// would never reach the workflow at all and the promised recovery run would
	// simply never happen.
	//
	// Moving the settings read up costs one query on the skip path. That is the
	// price of the guard being able to consult it.
	const settings = await getPublishingSuiteSettings(fresh.id);
	const preferences = buildPublishingPreferencesSnapshot(settings);
	const lastRunPreferencesHash =
		await getLastCountedPublishingRunPreferencesHash(fresh.id, {
			organizationId,
			userId: tenantUserId,
		});
	// The hash is computed HERE only to compare. It is never sent: the snapshot
	// travels instead, and `persistCycleTerminal` derives the stored hash from
	// that same object — one producer, so the value compared and the value
	// recorded cannot drift apart.
	//
	// Null reads as changed, and so does a counted cycle that recorded none.
	// Every cycle written before this slice recorded none, so each project gets
	// a recovery run — which is the point: a project whose lookback was narrowed
	// and restored has content buried below its watermark right now. It settles
	// once one of its cycles terminalizes on a worker carrying this slice, which
	// is NOT the same as settling after exactly one run; the cadence timer, not
	// this comparison, is what bounds the spend in between.
	const preferencesChanged =
		lastRunPreferencesHash !==
		computePublishingPreferencesHash(preferences);

	// Liveness-aware reclaim of a stale GENERATING cycle. Runs BEFORE the cost
	// guard below: a quiet project (no new context) can still be carrying a
	// GENERATING cycle whose worker died, and that cycle must be freed even
	// when this dispatch has no new content to act on — otherwise a project
	// that goes quiet right after a worker crash is stuck GENERATING forever
	// (the hard executionTimeoutAt reclaim is never reached because dispatch
	// keeps returning early on the cost guard). Depends only on the fresh
	// project id + `now`, never on priorCoverage/hasNew, so the reorder is
	// safe. The deterministic workflowId is recomputed from cycle.id (never
	// the nullable temporalWorkflowId). CAS is projectId-scoped so it can only
	// flip THIS project's still-GENERATING cycle.
	//
	// F2 cross-tenant supersede (subtle): the active-GENERATING partial-unique
	// index is scoped by projectId ONLY (NOT the tenant tuple), so a leftover
	// GENERATING cycle stamped with the OLD tenant tuple (from an org transfer
	// between cycles) still holds the slot and blocks createOrGetPublishingCycle
	// (P2002) regardless of tuple. We therefore MUST keep finding it by projectId
	// (matching the index) — tenant-scoping THIS lookup would miss the blocker and
	// leave the dispatch stuck reusing it forever. The tenant handling lives in
	// the reclaim decision below, not the lookup.
	const existing = await db.publishingSuggestionCycle.findFirst({
		where: { projectId: fresh.id, status: "GENERATING" },
		orderBy: { startedAt: "desc" },
		select: {
			id: true,
			startedAt: true,
			executionTimeoutAt: true,
			organizationId: true,
			userId: true,
		},
	});
	if (existing) {
		// If the found cycle's stored tuple does NOT match the fresh normalized
		// tuple, it is a stale cross-tenant cycle from a transfer → reclaim it
		// UNCONDITIONALLY (bypassing liveness/grace/timeout): it can never
		// legitimately complete under the new tenant, and only reclaiming it frees
		// the projectId-scoped slot so createOrGetPublishingCycle can create a
		// fresh cycle with the correct new tuple. A MATCHING tuple keeps the
		// existing tri-state liveness/timeout reclaim unchanged.
		const sameTenant =
			(existing.organizationId ?? null) === organizationId &&
			existing.userId === tenantUserId;
		if (!sameTenant || (await shouldReclaim(existing, now))) {
			await db.publishingSuggestionCycle.updateMany({
				where: {
					id: existing.id,
					projectId: fresh.id,
					status: "GENERATING",
				},
				data: {
					status: "FAILED",
					completedAt: now,
					error: sameTenant
						? "Reclaimed: stale GENERATING cycle with no live workflow"
						: "Superseded: stale cross-tenant GENERATING cycle after project transfer",
				},
			});
		}
	}

	// Cost guard: nothing new since coverage (and no active external source) →
	// skip starting a cycle (no LLM cost). H2: an ACTIVE repo integration counts
	// as always-possibly-new; the workflow's qualifyingCount gate bounds spend.
	// A forced run is an explicit human request; it bypasses the cost guard as
	// well as the freshness gate. The endpoint's own cooldown bounds it.
	//
	// A preferences change bypasses it for a different reason: the guard asks
	// "is there new CONTENT", and the answer is no — what changed is how the
	// existing content should be read. Answering that question needs the run the
	// guard would skip.
	if (input.force !== true && !preferencesChanged) {
		const { hasNew } = await countNewContextSince(
			fresh.id,
			organizationId,
			priorCoverage,
		);
		if (!hasNew) {
			return;
		}
	}

	// N2: pass the dispatcher's deterministic runId as the occurrenceKey. On the
	// first attempt this creates the cycle; on a retry whose `start` already landed
	// but whose completion was lost, createOrGetPublishingCycle recovers the SAME
	// cycle by (projectId, occurrenceKey) REGARDLESS of status — even after the
	// generation workflow terminalized it (READY/etc.) — so no duplicate cycle is
	// created and the deterministic workflowId stays identical (start is an
	// AlreadyStarted no-op). Reclaim (F2) still ran BEFORE this, so a superseded
	// stale cycle was FAILED first and this creates fresh under the run's key. A
	// GENERATING cycle MUST carry executionTimeoutAt (F2).
	const { cycle } = await createOrGetPublishingCycle({
		projectId: fresh.id,
		organizationId,
		userId: tenantUserId,
		actorUserId,
		coveredThrough: now,
		executionTimeoutAt: new Date(
			now.getTime() + PUBLISHING_SUGGESTION_EXECUTION_TIMEOUT_MS,
		),
		occurrenceKey: dispatcherRunId,
		triggeredByUserId,
	});

	const workflowInput: PublishingSuggestionWorkflowInput = {
		cycleId: cycle.id,
		projectId: fresh.id,
		organizationId,
		tenantUserId,
		actorUserId,
		// F4: build the collection boundary from the cycle's STORED coveredThrough,
		// not the retry's `now`. On the created path this equals `now`; on a reused
		// cycle (createOrGet created:false, P2002 read-back) it is the original T0,
		// keeping the workflow's collection window consistent with the cycle row
		// instead of drifting forward on every retry.
		coveredThroughIso: cycle.coveredThrough.toISOString(),
		priorCoverage,
		// The conditional spreads matter: omitting the keys entirely keeps the
		// payload byte-identical to pre-1C for an unconfigured project.
		...(settings.lookbackDays != null && {
			lookbackDays: settings.lookbackDays,
		}),
		// `force` means exactly one thing to the workflow: skip the F7 freshness
		// gate (sufficiency still applies). Both callers want precisely that — a
		// human who clicked "Generate now", and a preferences change whose whole
		// purpose is to re-read content already below the watermark. One flag
		// rather than two, because two ways to express one condition is how a
		// later edit comes to handle one and miss the other. The human-initiated
		// signal is `PublishingSuggestionCycle.triggeredByUserId`, not this.
		...((input.force === true || preferencesChanged) && { force: true }),
		// Sent UNCONDITIONALLY rather than behind a spread: from this slice on,
		// every dispatch has one, and an absent field means "an old history" — a
		// meaning a live dispatch must never claim.
		preferences,
	};

	// Job Hub row (Fizzy #1850), opened BEFORE the start rather than after it.
	//
	// After looks safer and is not. `client.workflow.start` only confirms that
	// the server accepted the start; the worker can already be running the
	// workflow. On the FAST terminal paths — a tenant-tuple mismatch throws in the
	// first activity and `markCycleFailed` closes the run in two activity calls —
	// the whole execution can finish before this line is reached. The activity's
	// `jobFail` would then find no RUNNING row to close, and this call would open
	// one that nothing is left alive to close: a second, permanently RUNNING row
	// on a healthy dispatch.
	//
	// Opening first removes the window entirely. The workflow's own `jobEnsure`
	// adopts this row by (workflowId, sourceId), so there is exactly one.
	await openPublishingJobRow({
		cycleId: cycle.id,
		projectId: fresh.id,
		ownerUserId: actorUserId,
		organizationId,
	});

	try {
		const client = await getTemporalClient();
		await client.workflow.start("publishingSuggestionWorkflow", {
			taskQueue: "fabric-worker",
			workflowId: `publishing-suggestion-${cycle.id}`,
			args: [workflowInput],
			// This 2h bound is one budget together with the notify activity's retry
			// policy (startToCloseTimeout/maximumAttempts/initialInterval in
			// publishing-suggestion-generation-workflow.ts) and the mail provider's
			// 24h dedupe window, PUBLISHING_EMAIL_PROVIDER_DEDUPE_WINDOW_MS in
			// publishing-notification-delivery.ts. Server-enforced across the WHOLE
			// execution including retries — even through a worker/task-queue outage
			// — it keeps every notify attempt 12x inside that 24h window: a resend
			// past it needs the re-drive script's explicit --force-stale, never just
			// a retry. Raise this toward/past 24h and that guarantee disappears.
			workflowExecutionTimeout:
				PUBLISHING_SUGGESTION_EXECUTION_TIMEOUT_MS,
		});
	} catch (err) {
		// The deterministic id already runs (a concurrent dispatch or a still-live
		// reused cycle won the race) — idempotent, nothing to do. The row was
		// already opened above, and `ensureRunningBackgroundJob` adopts by
		// (workflowId, sourceId), so the winner and this caller share one row.
		if (err instanceof WorkflowExecutionAlreadyStartedError) {
			return;
		}
		// Any other start failure: re-throw so Temporal retries this activity. The
		// GENERATING cycle stays claimed; a later attempt reuses it + the
		// deterministic id. Close the row first, so it does not sit RUNNING
		// claiming a run that does not exist.
		await failPublishingJobRow(cycle.id, err);
		throw err;
	}
}
