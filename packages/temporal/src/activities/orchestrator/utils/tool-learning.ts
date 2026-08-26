/**
 * Tool Call Learning Cache
 *
 * Stores successful patterns and error corrections for each tool.
 * Enables the AI to learn from past mistakes and successes.
 */

import type { ToolCallPattern } from "../types";

// In-memory cache for tool call patterns (per-process)
// In production, this should be stored in Redis or database
const toolCallLearningCache = new Map<string, ToolCallPattern>();

/**
 * Record a successful tool call pattern
 */
export function recordSuccessfulToolCall(
	toolName: string,
	args: Record<string, unknown>,
): void {
	const pattern = toolCallLearningCache.get(toolName) || {
		toolName,
		successfulArgs: [],
		errorPatterns: [],
	};

	// Store successful args (keep last 5 successful patterns)
	pattern.successfulArgs = [args, ...pattern.successfulArgs.slice(0, 4)];
	pattern.lastSuccessfulCall = {
		args,
		timestamp: new Date().toISOString(),
	};

	toolCallLearningCache.set(toolName, pattern);
	console.log(`[ToolLearning] Recorded successful pattern for ${toolName}`);
}

/**
 * Record a failed tool call and its correction (if any)
 */
export function recordFailedToolCall(
	toolName: string,
	badArgs: Record<string, unknown>,
	errorMessage: string,
	correctedArgs?: Record<string, unknown>,
): void {
	const pattern = toolCallLearningCache.get(toolName) || {
		toolName,
		successfulArgs: [],
		errorPatterns: [],
	};

	// Add error pattern if not already recorded (avoid duplicates)
	const existingError = pattern.errorPatterns.find(
		(e) =>
			e.errorMessage === errorMessage &&
			JSON.stringify(e.badArgs) === JSON.stringify(badArgs),
	);

	if (!existingError) {
		pattern.errorPatterns.push({
			badArgs,
			errorMessage,
			correctedArgs,
			learnedAt: new Date().toISOString(),
		});

		// Keep only last 10 error patterns
		pattern.errorPatterns = pattern.errorPatterns.slice(-10);
	} else if (correctedArgs && !existingError.correctedArgs) {
		// Update with correction if we now have one
		existingError.correctedArgs = correctedArgs;
	}

	toolCallLearningCache.set(toolName, pattern);
	console.log(
		`[ToolLearning] Recorded error pattern for ${toolName}: ${errorMessage}`,
	);
}

/**
 * Get learning context for AI to avoid past mistakes
 */
export function getToolLearningContext(toolNames: string[]): string {
	const contexts: string[] = [];

	for (const toolName of toolNames) {
		const pattern = toolCallLearningCache.get(toolName);
		if (!pattern) {
			continue;
		}

		const toolContext: string[] = [];

		// Show last successful call as example
		if (pattern.lastSuccessfulCall) {
			toolContext.push(
				`  WORKING EXAMPLE: ${JSON.stringify(pattern.lastSuccessfulCall.args)}`,
			);
		}

		// Show common errors to avoid
		if (pattern.errorPatterns.length > 0) {
			const recentErrors = pattern.errorPatterns.slice(-3);
			for (const err of recentErrors) {
				if (err.correctedArgs) {
					toolContext.push(
						`  AVOID: ${JSON.stringify(err.badArgs)} → USE: ${JSON.stringify(err.correctedArgs)}`,
					);
				} else {
					toolContext.push(
						`  AVOID: ${JSON.stringify(err.badArgs)} (Error: ${err.errorMessage.slice(0, 100)})`,
					);
				}
			}
		}

		if (toolContext.length > 0) {
			contexts.push(`Tool "${toolName}":\n${toolContext.join("\n")}`);
		}
	}

	return contexts.length > 0
		? `\n\nLEARNED PATTERNS (use these to avoid past mistakes):\n${contexts.join("\n\n")}`
		: "";
}

/**
 * Clear the learning cache (useful for testing)
 */
export function clearToolLearningCache(): void {
	toolCallLearningCache.clear();
}

/**
 * Get a specific tool's learning pattern (useful for debugging)
 */
export function getToolPattern(toolName: string): ToolCallPattern | undefined {
	return toolCallLearningCache.get(toolName);
}
