/**
 * The Temporal workflow id of a project's Living Memory repository sync
 * (design 2026-09-23 §5.2, Fizzy #2657).
 *
 * ONE id per project, not per run: the API starts it with
 * `workflowIdConflictPolicy: "FAIL"`, so a second "Sync now" while a run is
 * open is refused by Temporal itself. Two places must agree on the string:
 * the API's start and "is it running" check
 * (`packages/api/modules/projects/lib/context-repository-sync-workflow.ts`,
 * which holds its own copy of this literal) and the sync's `begin` activity
 * in `@repo/temporal`, which describes each unfinished predecessor's exact
 * execution (this id plus the run id in its run key). Change them together.
 */
export function contextRepositorySyncWorkflowId(projectId: string): string {
	return `context-repository-sync-${projectId}`;
}

/**
 * The deterministic Temporal workflow id of a Coding Instructions snapshot's
 * validation run.
 *
 * Derived from the snapshot row alone, which is what makes `finalize`
 * idempotent: a retried finalize re-attempts the same start, and Temporal's
 * `WorkflowExecutionAlreadyStartedError` is then proof that an earlier
 * attempt's start succeeded rather than a failure to report.
 *
 * It lives here, in a package with no runtime dependencies, because THREE
 * places have to agree on the string and two of them cannot import the third:
 * `packages/api/.../finalize-snapshot.ts` builds it to start the workflow, and
 * the scheduled reaper
 * (`packages/temporal/src/activities/project-instructions-reaper.ts`) builds
 * it to ask Temporal whether an execution exists before it closes a stale
 * RECEIVING row out. A copy-pasted template that drifted on either side would
 * make the reaper's liveness check answer "nothing is running" for every
 * snapshot — silently, and only for rows a live workflow owns.
 */
export function instructionSnapshotWorkflowId(snapshotId: string): string {
	return `project-instruction-snapshot-${snapshotId}`;
}

/**
 * The deterministic Temporal workflow id of a project's repository sync run
 * (spec §5.2).
 *
 * ONE id per project, not per run: the start uses
 * `workflowIdConflictPolicy: "FAIL"`, so a second "Sync now" while a run is
 * open is refused by Temporal itself and reported as `already_running`,
 * with no lock row to leak. The procedure that starts it and the procedure
 * that reports `running` both build it here.
 */
export function instructionRepositorySyncWorkflowId(projectId: string): string {
	return `project-instruction-repository-sync-${projectId}`;
}

/**
 * The Temporal workflow id of one proposal's pull-request operation (Fizzy
 * #2563 spec §6): one per operation, started with
 * `workflowIdConflictPolicy: "FAIL"`, so a second start while it runs is
 * adoption rather than a second opener. The admission, retry and refresh
 * starts in `@repo/api` and the sweeper's restart in `@repo/temporal` all
 * build it here.
 */
export function instructionProposalPullRequestWorkflowId(
	operationId: string,
): string {
	return `project-instruction-proposal-pull-request-${operationId}`;
}

/** The one proposal pull-request sweeper (spec §9), started by its schedule. */
export const INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_WORKFLOW_ID =
	"instruction-proposal-pull-request-sweep";
