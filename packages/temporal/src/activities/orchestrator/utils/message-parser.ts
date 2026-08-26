/**
 * Message Parser Utilities
 *
 * Extracts user intent and document content from orchestrator messages.
 * Used to separate what to display (user intent) from what to execute (full context).
 *
 * SECURITY: Document content should NOT be stored in task plan descriptions
 * that are persisted to the database or shown in approval UIs.
 */

export interface ParsedMessage {
	/** The user's actual request/intent without document content */
	userIntent: string;
	/** The workspace document content if present */
	documentContent: string | null;
	/** Whether workspace documents were included in the message */
	hasDocuments: boolean;
	/** The full original message */
	fullMessage: string;
}

/**
 * Extracts the user's intent from a message, separating it from workspace document content.
 *
 * The workspace documents are appended in the format:
 * ```
 * ## Workspace Documents:
 * The following content is from the user's attached workspace documents...
 * ### From: filename.pdf
 * ...content...
 * ```
 *
 * @param message - The full message potentially containing workspace documents
 * @returns Parsed message with separated user intent and document content
 */
export function parseMessage(message: string): ParsedMessage {
	const workspaceMarker = "## Workspace Documents:";
	const markerIndex = message.indexOf(workspaceMarker);

	if (markerIndex === -1) {
		// No workspace documents in message
		return {
			userIntent: message.trim(),
			documentContent: null,
			hasDocuments: false,
			fullMessage: message,
		};
	}

	// Extract user intent (everything before the marker)
	const userIntent = message.substring(0, markerIndex).trim();

	// Extract document content (everything from marker onwards)
	const documentContent = message.substring(markerIndex).trim();

	return {
		userIntent: userIntent || "Process the attached documents",
		documentContent,
		hasDocuments: true,
		fullMessage: message,
	};
}

/**
 * Creates a clean, display-safe description for a task step.
 * Removes document content and creates a concise action description.
 *
 * @param message - The full message or step description
 * @param maxLength - Maximum length for the description (default: 200)
 * @returns A clean description suitable for display
 */
export function createCleanDescription(
	message: string,
	maxLength = 200,
): string {
	const parsed = parseMessage(message);
	let description = parsed.userIntent;

	// Truncate if too long
	if (description.length > maxLength) {
		description = `${description.substring(0, maxLength - 3)}...`;
	}

	return description;
}

/**
 * Creates a display-safe version of a task plan description.
 * Used for the main plan description shown in UI.
 *
 * @param message - The original message
 * @returns A clean plan description
 */
export function createPlanDescription(message: string): string {
	const parsed = parseMessage(message);

	// Create a short description for the plan
	if (parsed.hasDocuments) {
		// If documents are attached, summarize what the user wants to do with them
		return parsed.userIntent || "Process attached workspace documents";
	}

	return parsed.userIntent;
}

/**
 * Detects individual action requests in a user's message.
 * Used to determine if we should decompose into multiple steps.
 *
 * @param userIntent - The user's request without document content
 * @returns Array of detected action descriptions
 */
export function detectMultipleActions(userIntent: string): string[] {
	const actions: string[] = [];
	const intentLower = userIntent.toLowerCase();

	// Check for list patterns like "1. ..., 2. ..." or "first..., then..., finally..."
	const hasNumberedList = /\d+\.\s*\w+/.test(userIntent);
	const hasSequenceWords =
		intentLower.includes("then") ||
		intentLower.includes("after that") ||
		intentLower.includes("finally") ||
		intentLower.includes("first") ||
		intentLower.includes("second");

	// Check for "and" connecting distinct actions
	const andParts = userIntent
		.split(/\s+and\s+/i)
		.filter((p) => p.trim().length > 10);

	// Common action verb patterns
	const actionPatterns = [
		/(summarize|summarise)\s+.+?(?=,|and\s|$)/gi,
		/(create|make|generate)\s+.+?(?=,|and\s|$)/gi,
		/(assign|give|send)\s+.+?(?=,|and\s|$)/gi,
		/(update|modify|edit|change)\s+.+?(?=,|and\s|$)/gi,
		/(delete|remove)\s+.+?(?=,|and\s|$)/gi,
		/(get|fetch|retrieve|find|search|list)\s+.+?(?=,|and\s|$)/gi,
	];

	for (const pattern of actionPatterns) {
		let match: RegExpExecArray | null;
		while (
			// biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration idiom
			(match = pattern.exec(userIntent)) !== null
		) {
			const action = match[0].trim().replace(/,\s*$/, "");
			if (action.length > 5 && !actions.includes(action)) {
				actions.push(action);
			}
		}
	}

	// If we found multiple distinct actions or sequence patterns, return them
	if (actions.length > 1 || hasNumberedList || hasSequenceWords) {
		return actions.length > 0 ? actions : [userIntent];
	}

	// If "and" separates what look like distinct actions
	if (andParts.length > 1) {
		return andParts.map((p) => p.trim());
	}

	return [];
}
