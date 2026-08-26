/**
 * Extract Task Utility
 *
 * Extracts the task description from the agent state.
 */

import type { ApiAgentStateType } from "../state";

/**
 * Extract the task description from the state
 *
 * Checks taskDescription first, then falls back to the last human message.
 *
 * @param state - The agent state
 * @returns The extracted task description
 */
export function extractTask(state: ApiAgentStateType): string {
	// Check explicit task description first
	if (state.taskDescription) {
		return state.taskDescription;
	}

	// Fall back to last human message
	const messages = state.messages || [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (
			(msg as any)?._getType?.() === "human" ||
			(msg as any)?.role === "user" ||
			msg.constructor?.name === "HumanMessage"
		) {
			const content =
				typeof msg.content === "string"
					? msg.content
					: Array.isArray(msg.content)
						? msg.content.map((c: any) => c.text || c).join(" ")
						: String(msg.content);
			return content;
		}
	}

	return "";
}
