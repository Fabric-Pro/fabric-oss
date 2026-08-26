/**
 * Orchestrator Chat Utilities
 *
 * Helper functions for the Temporal Orchestrator Chat component.
 */

/**
 * Check if a tool is a document artifact (used internally by hasDocumentArtifacts)
 */
function isDocumentArtifact(toolName?: string): boolean {
	if (!toolName) {
		return false;
	}
	// Document artifacts from agent delegation
	// e.g., project_document_generator:document, document_generator:prd
	return (
		toolName.includes(":document") ||
		toolName.includes(":prd") ||
		toolName.includes(":spec") ||
		toolName.includes(":proposal") ||
		toolName.includes(":report")
	);
}

/**
 * Check if any tool calls contain a document artifact
 * Used to determine if we should hide the final response (since document is the artifact)
 */
export function hasDocumentArtifacts(
	stepResults: Array<{
		toolCalls: Array<{ name?: string }>;
	}>,
): boolean {
	return stepResults.some((result) =>
		result.toolCalls.some((tc) => isDocumentArtifact(tc.name)),
	);
}

/**
 * Creates a summary string for tool input arguments to display in the collapsed header
 * Extracts the most relevant argument value (query, url, task, message, etc.)
 */
export function getToolInputSummary(
	args: Record<string, unknown> | undefined,
	maxLength = 80,
): string | undefined {
	if (!args || Object.keys(args).length === 0) {
		return undefined;
	}

	// Priority order of keys to show as summary
	const priorityKeys = [
		"query",
		"url",
		"task",
		"message",
		"prompt",
		"input",
		"text",
		"content",
		"search",
		"name",
	];

	// Try to find a priority key first
	for (const key of priorityKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return value.length > maxLength
				? `${value.slice(0, maxLength)}...`
				: value;
		}
	}

	// Fall back to first string value
	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string" && value.length > 0) {
			const summary = `${key}: ${value}`;
			return summary.length > maxLength
				? `${summary.slice(0, maxLength)}...`
				: summary;
		}
	}

	// Show object key summary if no string values
	const keys = Object.keys(args);
	if (keys.length <= 3) {
		return `{${keys.join(", ")}}`;
	}
	return `{${keys.slice(0, 3).join(", ")}, ...}`;
}
