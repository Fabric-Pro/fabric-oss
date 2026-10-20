import type { AiFeatureKey } from "@repo/ai";
import type { UsageLoggingContext } from "@repo/ai/lib/usage-logging-middleware";

export type UsageOrigin = Pick<
	UsageLoggingContext,
	"conversationId" | "frameId" | "projectId"
> & { featureKey?: AiFeatureKey };

export interface SecondaryUsageInput {
	usageConversationId?: string;
	usageOrigin?: UsageOrigin;
}

export function secondaryUsageFields(input: SecondaryUsageInput): UsageOrigin {
	return {
		...(input.usageConversationId
			? { conversationId: input.usageConversationId }
			: {}),
		...input.usageOrigin,
	};
}

/**
 * New workflows carry a server-validated usageFrameId; their activities use
 * the accounting contract's frameId. Empty spreads preserve old activity
 * payloads. Placement defaults and chat execution IDs never supply an origin.
 */
export function usageOriginFields(input: {
	conversationId?: string;
	usageFrameId?: string;
	frameId?: string;
	projectId?: string;
}): UsageOrigin {
	const frameId = input.usageFrameId ?? input.frameId;
	return {
		...(input.conversationId
			? { conversationId: input.conversationId }
			: {}),
		...(frameId ? { frameId } : {}),
		...(input.projectId ? { projectId: input.projectId } : {}),
	};
}
