export type ChatToolSelectionMode = "DEFAULT" | "ONLY_SELECTED" | "DISABLED";

export function resolveSelectedChatToolIds(params: {
	toolSelectionMode: ChatToolSelectionMode;
	selectedMcpConfigIds: string[] | null;
}): string[] | null {
	if (params.toolSelectionMode === "DEFAULT") {
		return null;
	}

	return params.selectedMcpConfigIds ?? [];
}

export function buildChatToolSelectionPayload(
	selectedMcpConfigIds: string[] | null,
): {
	selectedMcpConfigIds: string[];
	toolSelectionMode: ChatToolSelectionMode;
} {
	if (selectedMcpConfigIds === null) {
		return {
			selectedMcpConfigIds: [],
			toolSelectionMode: "DEFAULT",
		};
	}

	if (selectedMcpConfigIds.length === 0) {
		return {
			selectedMcpConfigIds,
			toolSelectionMode: "DISABLED",
		};
	}

	return {
		selectedMcpConfigIds,
		toolSelectionMode: "ONLY_SELECTED",
	};
}

export function applyConversationMcpSelection(
	existingEnabledMcpConfigIds: string[] | null | undefined,
	selectedMcpConfigIds: string[] | null,
): string[] | null | undefined {
	if (selectedMcpConfigIds === null) {
		return existingEnabledMcpConfigIds;
	}

	return selectedMcpConfigIds;
}
