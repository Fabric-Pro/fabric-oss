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
 * The deterministic Temporal workflow id of a direct commit (Fizzy #2878
 * §10): one per `REPOSITORY_COMMIT` snapshot. The API starts it before the
 * snapshot's validation is, and a repeated start finds the open run by this
 * id rather than starting a second commit.
 */
export function instructionDirectCommitWorkflowId(snapshotId: string): string {
	return `project-instruction-direct-commit-${snapshotId}`;
}

/**
 * The Temporal workflow id of a project's revert of a commit on its synced
 * branch (Fizzy #2878 §10).
 *
 * ONE id per project, not per request: the API starts it with
 * `workflowIdConflictPolicy: "FAIL"`, so a second revert while one is open is
 * refused by Temporal itself and reported as `REVERT_BUSY`, with no lock row
 * to leak. Two reverts of one branch race for the same tip. The request id
 * stays the commit's `Fabric-Commit` trailer (it is in the workflow input),
 * so an activity retry finds the revert it already pushed instead of pushing
 * a second.
 */
export function instructionRevertCommitWorkflowId(projectId: string): string {
	return `project-instruction-revert-commit-${projectId}`;
}

/** The one proposal pull-request sweeper (spec §9), started by its schedule. */
export const INSTRUCTION_PROPOSAL_PULL_REQUEST_SWEEP_WORKFLOW_ID =
	"instruction-proposal-pull-request-sweep";

/** Which repository sync a queued follow-up run belongs to. */
export type RepositorySyncFollowUpSubject = "instructions" | "context";

/**
 * The deterministic Temporal workflow id of a project's queued follow-up
 * sync: the run a member asked for by changing what is synced while another
 * run was still open. One per subject and project, so a second change while
 * one is waiting replaces it (the API starts it with
 * `workflowIdConflictPolicy: "TERMINATE_EXISTING"`) rather than queueing
 * behind it. It is a different id from the sync's own, which is what lets it
 * wait for that run to close and then start the next one under the sync's
 * id with `FAIL`.
 */
export function repositorySyncFollowUpWorkflowId(
	subject: RepositorySyncFollowUpSubject,
	projectId: string,
): string {
	return `repository-sync-follow-up-${subject}-${projectId}`;
}
