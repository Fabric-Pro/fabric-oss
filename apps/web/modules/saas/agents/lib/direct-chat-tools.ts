import type { ChatPlanModel } from "../components/FabricChat/shared/agent-selection";

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

/** The ChatGPT plan model the conversation keeps for its chat, if any. */
export function getConversationPlanModel(
	metadata: unknown,
): ChatPlanModel | null {
	if (
		!metadata ||
		typeof metadata !== "object" ||
		!("planModel" in metadata)
	) {
		return null;
	}
	const { planModel } = metadata;
	if (
		planModel &&
		typeof planModel === "object" &&
		"canonicalName" in planModel &&
		"name" in planModel &&
		typeof planModel.canonicalName === "string" &&
		planModel.canonicalName.length > 0 &&
		typeof planModel.name === "string"
	) {
		return { canonicalName: planModel.canonicalName, name: planModel.name };
	}
	return null;
}

export function mergeDirectConversationMetadata(params: {
	documentChatId?: string | null;
	/** Null leaves the new conversation unpinned. */
	instanceId?: string | null;
	selectedMcpConfigIds?: string[];
	/** Null keeps no plan model for the new conversation. */
	planModel?: ChatPlanModel | null;
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

	if (params.planModel) {
		next.planModel = params.planModel;
	}

	return next;
}
