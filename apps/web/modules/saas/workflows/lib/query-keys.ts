/**
 * Every run-history query for one workflow, whatever its filter. Invalidate
 * this prefix after starting a run so the list under each filter and the
 * per-status counts all refetch, not only the unfiltered list.
 */
export function workflowExecutionsScopeKey(
	workflowId: string,
	organizationId?: string | null,
) {
	return ["workflow-executions", workflowId, organizationId ?? "personal"];
}

export function workflowExecutionsKey(
	workflowId: string,
	organizationId?: string | null,
	/** Status filter, so switching it refetches instead of showing stale rows. */
	status = "all",
) {
	return [...workflowExecutionsScopeKey(workflowId, organizationId), status];
}

/** The per-status run counts the runs panel's filter shows. */
export function workflowExecutionStatsKey(
	workflowId: string,
	organizationId?: string | null,
) {
	return [...workflowExecutionsScopeKey(workflowId, organizationId), "stats"];
}
