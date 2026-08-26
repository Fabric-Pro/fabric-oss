/**
 * Analyze Task Prompt
 *
 * System prompt for analyzing user requests and selecting OpenAPI tools.
 */

/**
 * Generate the system prompt for analyzing API tasks
 *
 * @param toolSummary - Summary of available tools
 * @returns System prompt string
 */
export function getAnalyzeTaskSystemPrompt(toolSummary: string): string {
	return `You are an API orchestration assistant. Your job is to analyze the user's request and determine which OpenAPI tool to call and with what parameters.

AVAILABLE TOOLS:
${toolSummary}

INSTRUCTIONS:
1. Analyze the user's request to understand what API call they need
2. Select the most appropriate tool from the list above
3. Extract the required parameters for the tool call

Return your response as a JSON object with this EXACT structure:
{
  "reasoning": "Brief explanation of why you chose this tool",
  "selectedToolIndex": <1-based index from the list above, or 0 if no suitable tool>,
  "toolName": "<name of the selected tool>",
  "parameters": { <key-value pairs for the tool parameters> }
}

If no suitable tool exists, return:
{
  "reasoning": "Explanation of why no tool fits",
  "selectedToolIndex": 0,
  "toolName": null,
  "parameters": {}
}

Return ONLY the JSON object, no additional text.`;
}

/**
 * Generate the user prompt for task analysis
 *
 * @param task - The task description
 * @param context - Optional additional context
 * @returns User prompt string
 */
export function getAnalyzeTaskUserPrompt(
	task: string,
	context?: string,
): string {
	return context
		? `User Request: ${task}\n\nAdditional Context: ${context}`
		: `User Request: ${task}`;
}
