/** Deterministic correlation only; arbitrary providers do not promise deduplication. */
export function savedAgentEffectId(
	workflowId: string,
	stepIndex: number,
	modelToolCallId: string,
	effectScope = "turn",
): string {
	return `saved-agent:${encodeURIComponent(workflowId)}:${encodeURIComponent(effectScope)}:${stepIndex}:${encodeURIComponent(modelToolCallId)}`;
}
export const SAVED_AGENT_STEP_BYTES = 512 * 1024;
export const SAVED_AGENT_TOOL_BYTES = 96 * 1024;
