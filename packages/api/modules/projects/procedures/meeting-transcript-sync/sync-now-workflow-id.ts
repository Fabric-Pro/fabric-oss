const SYNC_NOW_WORKFLOW_PREFIX = "meeting-transcript-sync-oneshot-";

export function syncNowWorkflowId(projectId: string, now = Date.now()): string {
	return `${SYNC_NOW_WORKFLOW_PREFIX}${projectId}-${now}`;
}

/**
 * When the "Sync now" run named by `workflowId` started, or null when the id
 * is not a run of this project. Anything malformed is rejected rather than
 * parsed leniently, because the id is the only thing that selects whose run
 * is read.
 */
export function syncNowStartedAt(
	workflowId: string,
	projectId: string,
): Date | null {
	const prefix = `${SYNC_NOW_WORKFLOW_PREFIX}${projectId}-`;
	if (!workflowId.startsWith(prefix)) {
		return null;
	}
	const suffix = workflowId.slice(prefix.length);
	return /^\d{13}$/.test(suffix) ? new Date(Number(suffix)) : null;
}
