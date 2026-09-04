/**
 * Job Hub progress reporting from Temporal activities.
 *
 * Thin wrapper over the `@repo/database` BackgroundJob writers that resolves
 * the current workflow id from the activity context, so call sites read as one
 * line and never have to plumb ids through activity inputs.
 *
 * WHY ACTIVITIES, NOT WORKFLOWS: workflow code is replayed, so adding calls
 * there would need `patched()` sentinels and would put every long-running
 * channel monitor through replay-validation CI. Activities are not replayed —
 * instrumenting them is invisible to determinism, and executions already in
 * flight start reporting at their next activity invocation.
 *
 * Every function here is best-effort and NEVER throws or rejects. Progress
 * reporting is strictly observational: it must not fail an ingestion pipeline,
 * and it must stay inert when an activity runs outside a workflow context or
 * against a partially-mocked `@repo/database` (as unit tests do).
 */

import * as dbWriters from "@repo/database";
import { Context } from "@temporalio/activity";

export type BackgroundJobStepStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	/**
	 * Written only by the writers in `@repo/database` when a job closes with
	 * this step still open. Activities never set it; it is listed so this
	 * declaration does not drift from the canonical one.
	 */
	| "skipped";

export interface BackgroundJobStep {
	key: string;
	status: BackgroundJobStepStatus;
	startedAt?: string;
	completedAt?: string;
	error?: string;
}

type Counts = Record<string, number>;

/** Canonical `sourceType` values, so writers and the UI agree on the vocabulary. */
export const JOB_SOURCE = {
	teamsLinkedChannel: "teamsLinkedChannel",
	teamsLinkedChat: "teamsLinkedChat",
	slackLinkedChannel: "slackLinkedChannel",
	repositoryIntegration: "repositoryIntegration",
	projectContext: "projectContext",
} as const;

/** Ordered subtask keys per job kind — the Job Hub renders them in this order. */
export const JOB_STEPS = {
	channelMonitor: ["fetch", "analyze", "propose"],
	codeIndexing: [
		"clone",
		"secretScan",
		"walk",
		"symbols",
		"embed",
		"summaries",
		"finalize",
	],
	contextProcessing: ["download", "extract", "chunk", "embed", "store"],
	// Publishing topic generation stops at `persist` on purpose: notification and
	// chat delivery run after the cycle terminalizes, each behind its own
	// patched() marker and its own try/catch, so there is no statically-known
	// last step to close from — and delivery is already reported by the refresh
	// history's Notified column.
	publishingTopicGeneration: ["collect", "summarize", "persist"],
} as const;

/** Build an ordered `pending` step list from machine keys (see `JOB_STEPS`). */
export function seedJobSteps(keys: readonly string[]): BackgroundJobStep[] {
	return keys.map((key) => ({ key, status: "pending" as const }));
}

export interface JobEnsureArgs {
	kind:
		| "TEAMS_CHANNEL_MONITOR"
		| "TEAMS_CHAT_MONITOR"
		| "SLACK_CHANNEL_MONITOR"
		| "SLACK_BACKFILL"
		| "CODE_INDEXING"
		| "CONTEXT_PROCESSING"
		| "PUBLISHING_TOPIC_GENERATION";
	title: string;
	projectId: string;
	userId: string;
	organizationId?: string | null;
	sourceType?: string | null;
	sourceId?: string | null;
	counts?: Counts;
	steps?: BackgroundJobStep[];
	/**
	 * Reopen this run's own failed row instead of opening a second one. Only
	 * for one-shot activities Temporal retries — see the writer's docs.
	 */
	reopenFailedWithClass?: string;
}

/**
 * Current workflow execution, or null when running outside an activity context
 * (unit tests calling activity functions directly). Null makes every reporting
 * call below a no-op rather than an error.
 */
function currentExecution(): { workflowId: string; runId: string } | null {
	try {
		// Unset for a standalone Activity (SDK 1.23+), which nothing here
		// starts. Same no-op path as running outside an activity entirely.
		const execution = Context.current().info.workflowExecution;
		if (!execution) {
			return null;
		}
		return { workflowId: execution.workflowId, runId: execution.runId };
	} catch {
		return null;
	}
}

/**
 * Run a writer, swallowing everything.
 *
 * Also absorbs a missing export: unit tests across the repo mock
 * `@repo/database` wholesale, and telemetry added to an activity must not turn
 * those mocks into failures.
 */
async function safely(fn: () => Promise<unknown>): Promise<void> {
	try {
		await fn();
	} catch {
		// Best-effort telemetry.
	}
}

/**
 * Open (or adopt) the job row for this workflow + source.
 *
 * Called by the first activity that finds real work — that is what keeps idle
 * monitor ticks from creating empty rows.
 */
export async function jobEnsure(args: JobEnsureArgs): Promise<void> {
	const execution = currentExecution();
	if (!execution) {
		return;
	}
	await safely(() =>
		dbWriters.ensureRunningBackgroundJob({
			...args,
			workflowId: execution.workflowId,
			runId: execution.runId,
		}),
	);
}

/** Add to the job's counters (atomic jsonb merge — safe under concurrency). */
export async function jobIncrement(
	deltas: Counts,
	sourceId?: string | null,
): Promise<void> {
	const execution = currentExecution();
	if (!execution) {
		return;
	}
	await safely(() =>
		dbWriters.incrementBackgroundJobCounts(
			{ workflowId: execution.workflowId, sourceId },
			deltas,
		),
	);
}

/** Set counters to known absolute values (totals discovered up front). */
export async function jobSetCounts(
	counts: Counts,
	sourceId?: string | null,
): Promise<void> {
	const execution = currentExecution();
	if (!execution) {
		return;
	}
	await safely(() =>
		dbWriters.setBackgroundJobCounts(
			{ workflowId: execution.workflowId, sourceId },
			counts,
		),
	);
}

/** Move a subtask to a new state (drives the expandable step list). */
export async function jobStep(
	key: string,
	status: BackgroundJobStepStatus,
	opts?: { sourceId?: string | null; error?: string },
): Promise<void> {
	const execution = currentExecution();
	if (!execution) {
		return;
	}
	await safely(() =>
		dbWriters.setBackgroundJobStep(
			{ workflowId: execution.workflowId, sourceId: opts?.sourceId },
			key,
			status,
			opts?.error,
		),
	);
}

/**
 * Mark whichever step is `running` as `failed`, for a failure raised OUTSIDE the
 * activity that owns the step.
 *
 * The close sweep records a still-`running` step as `skipped`, which reads as
 * "never reached" — the opposite of what happened. An activity that owns its
 * step marks it directly; this is for the case where the throw comes from
 * workflow code (a collector fan-out where every source failed, say) and no
 * single activity is in a position to.
 */
export async function jobFailRunningStep(
	error: string,
	sourceId?: string | null,
): Promise<void> {
	const execution = currentExecution();
	if (!execution) {
		return;
	}
	await safely(() =>
		dbWriters.failRunningBackgroundJobStep(
			{ workflowId: execution.workflowId, sourceId },
			error,
		),
	);
}

/** Keep a slow-but-alive job out of the watchdog's reach. */
export async function jobHeartbeat(sourceId?: string | null): Promise<void> {
	const execution = currentExecution();
	if (!execution) {
		return;
	}
	await safely(() =>
		dbWriters.touchBackgroundJobHeartbeat({
			workflowId: execution.workflowId,
			sourceId,
		}),
	);
}

/** Close one source's job as COMPLETED. */
export async function jobComplete(opts?: {
	sourceId?: string | null;
	counts?: Counts;
}): Promise<void> {
	const execution = currentExecution();
	if (!execution) {
		return;
	}
	await safely(() =>
		dbWriters.completeBackgroundJob(
			{ workflowId: execution.workflowId, sourceId: opts?.sourceId },
			{ counts: opts?.counts },
		),
	);
}

/**
 * Close every open job of this workflow as COMPLETED.
 *
 * Channel monitors call this from their per-tick "stamp last run" activity: one
 * call closes all per-channel rows the tick opened, and a tick that opened none
 * is a no-op.
 */
export async function jobCompleteAll(counts?: Counts): Promise<void> {
	const execution = currentExecution();
	if (!execution) {
		return;
	}
	await safely(() =>
		dbWriters.completeBackgroundJobs(execution.workflowId, { counts }),
	);
}

/**
 * Close a job as FAILED. `error` is shown verbatim in the Job Hub, so pass the
 * user-actionable message, not a stack trace.
 */
export async function jobFail(
	error: string,
	opts?: { sourceId?: string | null; errorClass?: string },
): Promise<void> {
	const execution = currentExecution();
	if (!execution) {
		return;
	}
	await safely(() =>
		dbWriters.failBackgroundJob(
			{ workflowId: execution.workflowId, sourceId: opts?.sourceId },
			{ error, errorClass: opts?.errorClass },
		),
	);
}
