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
