interface ActiveContextSelection {
	workspaceIds?: readonly string[];
	mcpConfigIds?: readonly string[];
	agentIds?: readonly string[];
	fabricToolIds?: readonly string[];
	integrationIds?: readonly string[];
	projectId?: string | null;
}

export function hasActiveContext(context: ActiveContextSelection): boolean {
	return Boolean(
		context.workspaceIds?.length ||
			context.mcpConfigIds?.length ||
			context.agentIds?.length ||
			context.fabricToolIds?.length ||
			context.integrationIds?.length ||
			context.projectId,
	);
}
