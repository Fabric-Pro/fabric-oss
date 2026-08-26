/**
 * Pipeline-results sync workflow (cards 1834 / 1688). A thin, replay-safe wrapper
 * over the `syncPipelineResultsForProject` activity — all IO + non-determinism
 * live in the activity, so this body stays pure (no Date/random, single activity
 * call). Started on-demand from the QA tab ("Sync now") with a project-scoped
 * workflow id, so concurrent triggers for one project collapse onto one run.
 *
 * The activity is idempotent (run ingestion dedups on the external run id, the
 * cursor advances only on success, RCA bugs dedup per case), so the retry policy
 * is safe.
 */

// The already-started error lives in @temporalio/common, not
// @temporalio/workflow — importing it from the latter compiles nowhere and is an
// easy wrong guess. It is sandbox-safe in workflow code.
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import {
	ParentClosePolicy,
	patched,
	proxyActivities,
	startChild,
} from "@temporalio/workflow";
import type {
	listProjectsDueForPipelineSyncActivity as ListProjectsDueFn,
	reapStaleAgenticRunsActivity as ReapStaleAgenticRunsFn,
} from "../activities/pipeline-results/list-projects-due-for-sync";
import type {
	syncPipelineResultsForProject as SyncPipelineResultsForProjectFn,
	SyncPipelineResultsResult,
} from "../activities/pipeline-results/sync-pipeline-results";

const { syncPipelineResultsForProject } = proxyActivities<{
	syncPipelineResultsForProject: typeof SyncPipelineResultsForProjectFn;
}>({
	// Pulls several ADO sources, each list→detail→results + ingest; generous but
	// bounded so a hung source can't wedge the run forever.
	startToCloseTimeout: "3 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export interface SyncPipelineResultsWorkflowInput {
	projectId: string;
	organizationId?: string | null;
	userId: string | null;
	/** Limit to one repo integration; omit to sync every ADO source on the project. */
	integrationId?: string;
	/** Project opt-in for RCA→BUG (resolved at the trigger site from the project). */
	autoCreateBugsFromFailures?: boolean;
	maxRuns?: number;
}

export async function syncPipelineResultsWorkflow(
	input: SyncPipelineResultsWorkflowInput,
): Promise<SyncPipelineResultsResult> {
	return syncPipelineResultsForProject({
		projectId: input.projectId,
		organizationId: input.organizationId ?? null,
		userId: input.userId ?? null,
		integrationId: input.integrationId,
		autoCreateBugsFromFailures: input.autoCreateBugsFromFailures,
		maxRuns: input.maxRuns,
	});
}

// ---------------------------------------------------------------------------
// Scheduled sweep
// ---------------------------------------------------------------------------

const { listProjectsDueForPipelineSyncActivity, reapStaleAgenticRunsActivity } =
	proxyActivities<{
		listProjectsDueForPipelineSyncActivity: typeof ListProjectsDueFn;
		reapStaleAgenticRunsActivity: typeof ReapStaleAgenticRunsFn;
	}>({
		startToCloseTimeout: "1 minute",
		retry: { maximumAttempts: 3 },
	});

export interface SyncAllPipelineResultsResult {
	/** Projects the enumeration returned this tick. */
	considered: number;
	/** Per-project syncs this tick actually started. */
	started: number;
	/** Skipped because a sync for that project was already running. */
	alreadyRunning: number;
}

/**
 * Scheduled sweep: pull pipeline results for every project that has a connected
 * repository, without anyone pressing a button.
 *
 * Until this existed the only way results arrived was the manual "Sync now",
 * so a team that never clicked it simply had no CI results — the QA tab looked
 * empty rather than stale, which is the worse of the two.
 *
 * **It starts the SAME per-project workflow the button starts, under the SAME
 * workflow id.** That is the whole trick: a scheduled tick and a human pressing
 * "Sync now" collapse onto one run instead of racing each other into duplicate
 * provider calls. An id already in flight throws, and that throw is the success
 * signal for "someone is already doing this", not an error.
 *
 * Children are ABANDONed rather than awaited. A project whose provider is slow
 * must not hold the sweep open — the sweep's job is to make sure everyone got
 * *started*, and each child reports its own outcome through the existing sync
 * state that the UI already reads.
 */
export async function syncAllPipelineResultsWorkflow(input?: {
	limit?: number;
}): Promise<SyncAllPipelineResultsResult> {
	if (patched("qa-agentic-stale-run-reaper")) {
		await reapStaleAgenticRunsActivity();
	}
	const projects = await listProjectsDueForPipelineSyncActivity({
		limit: input?.limit,
	});

	let started = 0;
	let alreadyRunning = 0;

	for (const project of projects) {
		try {
			await startChild(syncPipelineResultsWorkflow, {
				// Identical to the manual trigger's id, deliberately.
				workflowId: `pipeline-results-sync-${project.projectId}`,
				parentClosePolicy: ParentClosePolicy.ABANDON,
				args: [
					{
						projectId: project.projectId,
						organizationId: project.organizationId,
						// No actor: a scheduled sweep is not a person. The
						// per-project sync treats a null user as "system", the
						// same as any other unattended path.
						userId: null,
						autoCreateBugsFromFailures:
							project.autoCreateBugsFromFailures,
					},
				],
			});
			started++;
		} catch (err) {
			if (err instanceof WorkflowExecutionAlreadyStartedError) {
				// Expected and healthy: a manual sync, or the previous tick, is
				// still going. Counted rather than swallowed so a deployment
				// where EVERY tick collides is visible instead of silent.
				alreadyRunning++;
				continue;
			}
			throw err;
		}
	}

	return { considered: projects.length, started, alreadyRunning };
}
