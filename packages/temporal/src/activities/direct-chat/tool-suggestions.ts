/**
 * Tool Suggestions Activity
 *
 * Handles tool suggestion generation based on user message.
 */

import { canMcpToolsHandleTask } from "@repo/agent-core/backend";

/**
 * Tool info type for tool suggestions
 */
export interface ToolInfo {
	configId: string;
	serverName: string;
	configName: string;
	tools: Array<{
		name: string;
		description: string;
		inputSchema?: Record<string, unknown>;
	}>;
	serviceKeywords: string[];
}

/**
 * Generate tool suggestions based on the message
 */
export async function generateToolSuggestionsActivity(
	message: string,
	mcpToolInfo: ToolInfo[],
): Promise<string> {
	if (mcpToolInfo.length === 0) {
		return "";
	}

	const toolMatch = canMcpToolsHandleTask(message, mcpToolInfo);
	if (toolMatch.canHandle && toolMatch.matchedTools.length > 0) {
		const suggestedTools = toolMatch.matchedTools
			.slice(0, 3)
			.map((t) => `- ${t.toolName}: ${t.reason}`)
			.join("\n");
		return `\n\n## Suggested Tools for this Task:\n${suggestedTools}`;
	}

	return "";
}
