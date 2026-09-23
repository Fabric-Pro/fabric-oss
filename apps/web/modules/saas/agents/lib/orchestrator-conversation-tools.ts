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
	/** The AiChat that uploaded documents are stored under (Files tab). */
	documentChatId?: string | null;
}): Record<string, unknown> {
	// A conversation keeps the engine it was created on (Fizzy #2040). Stamping
	// `orchestrator` over a Direct thread would hand it to an engine that
	// cannot hydrate it, so only a missing mode is filled in.
	const existingMode = params.existing?.mode;
	const next: Record<string, unknown> = {
		...(params.existing ?? {}),
		mode:
			typeof existingMode === "string" && existingMode.length > 0
				? existingMode
				: "orchestrator",
		executionMode: params.executionMode,
		lastUpdated: new Date().toISOString(),
	};

	if (params.instanceId) {
		next.instanceId = params.instanceId;
	}

	if (params.executions !== undefined) {
		next.executions = params.executions;
	}

	if (params.documentChatId) {
		next.documentChatId = params.documentChatId;
	}

	if (params.selectedMcpConfigIds !== undefined) {
		next.selectedMcpConfigIds = params.selectedMcpConfigIds;
	} else {
		delete next.selectedMcpConfigIds;
	}

	return next;
}
