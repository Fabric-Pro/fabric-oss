import type { AdvisorResultStoreContext } from "../../activities/advisor-result-store";

/** Workflow-owned ordinal survives activity retry and deterministic replay. */
export function advisorResultStoreFields(
	input: { conversationId?: string; turnId?: string },
	executionId: string,
	ordinal: number,
	toolName: string,
): { advisorResultStore?: AdvisorResultStoreContext } {
	if (!input.conversationId || !input.turnId) {
		return {};
	}
	return {
		advisorResultStore: {
			conversationId: input.conversationId,
			turnId: input.turnId,
			sourceKey: `${executionId}:${ordinal}`,
			toolName,
		},
	};
}
