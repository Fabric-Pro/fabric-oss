import { patched } from "@temporalio/workflow";
import {
	type IterativeTurnOptions,
	turnScopeOptionArgs,
} from "./turn-contract";
import {
	type SecondaryUsageInput,
	type UsageOrigin,
	usageOriginFields as originFields,
} from "./usage-attribution";

export const USAGE_ORIGIN_PATCH = "orchestrator-complete-usage-origin-v1";

export function usageOriginFields(input: {
	conversationId?: string;
	usageFrameId?: string;
	frameId?: string;
	projectId?: string;
}): UsageOrigin {
	const { projectId, ...legacyOrigin } = input;
	return originFields({
		...legacyOrigin,
		...(projectId && patched(USAGE_ORIGIN_PATCH) ? { projectId } : {}),
	});
}

export function secondaryUsageOriginFields(
	input: Parameters<typeof usageOriginFields>[0],
): Pick<SecondaryUsageInput, "usageOrigin"> {
	if (
		!(input.conversationId || input.usageFrameId || input.projectId) ||
		!patched(USAGE_ORIGIN_PATCH)
	) {
		return {};
	}
	return {
		usageOrigin: { ...originFields(input), featureKey: "chat-agent" },
	};
}

export function secondaryUsageOptionArgs(
	input: Parameters<typeof usageOriginFields>[0],
	turn: IterativeTurnOptions | undefined,
):
	| []
	| [
			SecondaryUsageInput & {
				turnScope?: IterativeTurnOptions["turnScope"];
			},
	  ] {
	const turnOptions = turnScopeOptionArgs(turn);
	const origin = secondaryUsageOriginFields(input);
	if (input.conversationId || origin.usageOrigin) {
		return [
			{
				...turnOptions[0],
				...(input.conversationId
					? { usageConversationId: input.conversationId }
					: {}),
				...origin,
			},
		];
	}
	return turnOptions;
}
