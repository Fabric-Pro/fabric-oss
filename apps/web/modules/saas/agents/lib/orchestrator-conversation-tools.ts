interface OrchestratorConversationToolMetadata {
	mode?: string;
	executionMode?: string;
	executions?: unknown[];
	instanceId?: string;
	selectedMcpConfigIds?: string[];
	[key: string]: unknown;
}

export function getSelectedOrchestratorToolIds(
	metadata: unknown,
): string[] | null {
	if (
		metadata &&
		typeof metadata === "object" &&
		"selectedMcpConfigIds" in
			(metadata as OrchestratorConversationToolMetadata) &&
		Array.isArray(
			(metadata as OrchestratorConversationToolMetadata)
				.selectedMcpConfigIds,
		)
	) {
		return ((metadata as OrchestratorConversationToolMetadata)
			.selectedMcpConfigIds ?? []) as string[];
	}

	return null;
}

export function mergeOrchestratorConversationMetadata(params: {
	existing?: Record<string, unknown> | null;
	executionMode: "lite" | "balanced" | "deep" | "planner";
	instanceId?: string;
	executions?: unknown[];
	selectedMcpConfigIds?: string[];
}): Record<string, unknown> {
	const next: Record<string, unknown> = {
		...(params.existing ?? {}),
		mode: "orchestrator",
		executionMode: params.executionMode,
		lastUpdated: new Date().toISOString(),
	};

	if (params.instanceId) {
		next.instanceId = params.instanceId;
	}

	if (params.executions !== undefined) {
		next.executions = params.executions;
	}

	if (params.selectedMcpConfigIds !== undefined) {
		next.selectedMcpConfigIds = params.selectedMcpConfigIds;
	} else {
		delete next.selectedMcpConfigIds;
	}

	return next;
}
