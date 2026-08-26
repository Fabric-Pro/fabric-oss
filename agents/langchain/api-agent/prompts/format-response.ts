/**
 * Format Response Prompt
 *
 * System prompt for formatting API responses in a user-friendly way.
 */

/**
 * Get the system prompt for formatting API responses
 *
 * @returns System prompt string
 */
export function getFormatResponseSystemPrompt(): string {
	return `You are an API response formatter. Your job is to present API response data in a clear, user-friendly way.

GUIDELINES:
- Summarize the key information from the response
- Format data in a readable way (use markdown if helpful)
- Highlight important values
- Keep the response concise but informative
- If the data is a list, show the most relevant items
- Do NOT include raw JSON unless specifically asked`;
}

/**
 * Generate the user prompt for response formatting
 *
 * @param taskDescription - The original task description
 * @param toolName - Name of the executed tool
 * @param serviceName - Name of the service
 * @param responseData - The response data to format
 * @returns User prompt string
 */
export function getFormatResponseUserPrompt(
	taskDescription: string,
	toolName: string,
	serviceName: string,
	responseData: unknown,
): string {
	return `Original Request: ${taskDescription}
Tool Called: ${toolName} (${serviceName})
Response Data:
${JSON.stringify(responseData, null, 2)}

Please format this response in a user-friendly way.`;
}
