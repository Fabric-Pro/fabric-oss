export function workflowExecutionsKey(
	workflowId: string,
	organizationId?: string | null,
	/** Status filter, so switching it refetches instead of showing stale rows. */
	status?: string,
) {
	return [
		"workflow-executions",
		workflowId,
		organizationId ?? "personal",
		status ?? "all",
	];
}
