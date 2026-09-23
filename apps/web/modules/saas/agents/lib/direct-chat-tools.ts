interface DirectChatConversationMetadata {
	mode?: string;
	instanceId?: string;
	documentChatId?: string;
	selectedMcpConfigIds?: string[];
	[key: string]: unknown;
}

export function getSelectedConversationToolIds(
	metadata: unknown,
): string[] | null {
	if (
		metadata &&
		typeof metadata === "object" &&
		"selectedMcpConfigIds" in
			(metadata as DirectChatConversationMetadata) &&
		Array.isArray(
			(metadata as DirectChatConversationMetadata).selectedMcpConfigIds,
		)
	) {
		return ((metadata as DirectChatConversationMetadata)
			.selectedMcpConfigIds ?? []) as string[];
	}

	return null;
}

export function mergeDirectConversationMetadata(params: {
	existing?: Record<string, unknown> | null;
	documentChatId?: string | null;
	instanceId?: string | null;
	selectedMcpConfigIds?: string[];
}): Record<string, unknown> {
	// A conversation keeps the engine it was recorded with (Fizzy #2040),
	// mirroring `mergeOrchestratorConversationMetadata`: Direct can end up
	// saving a thread another engine started (simple mode opens a Research
	// thread on Direct), and stamping `direct` over it would move that thread
	// to another engine for good. Only a missing mode is filled in.
	const existingMode = params.existing?.mode;
	const next: Record<string, unknown> = {
		...(params.existing ?? {}),
		mode:
			typeof existingMode === "string" && existingMode.length > 0
				? existingMode
				: "direct",
	};

	if (params.documentChatId) {
		next.documentChatId = params.documentChatId;
	}

	if (params.instanceId) {
		next.instanceId = params.instanceId;
	}

	if (params.selectedMcpConfigIds !== undefined) {
		next.selectedMcpConfigIds = params.selectedMcpConfigIds;
	} else {
		delete next.selectedMcpConfigIds;
	}

	return next;
}
