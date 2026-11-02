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
	documentChatId?: string | null;
	/** Null leaves the new conversation unpinned. */
	instanceId?: string | null;
	selectedMcpConfigIds?: string[];
}): Record<string, unknown> {
	const next: Record<string, unknown> = { mode: "direct" };

	if (params.documentChatId) {
		next.documentChatId = params.documentChatId;
	}

	if (params.instanceId) {
		next.instanceId = params.instanceId;
	}

	if (params.selectedMcpConfigIds !== undefined) {
		next.selectedMcpConfigIds = params.selectedMcpConfigIds;
	}

	return next;
}
