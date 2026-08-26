/**
 * Groq-Optimized Prompt Utilities
 *
 * This module provides utilities for creating prompts optimized for Groq models.
 * Based on Groq's official prompting best practices:
 * - https://console.groq.com/docs/prompting
 * - https://console.groq.com/docs/prompting/patterns
 * - https://console.groq.com/docs/prefilling
 *
 * Key optimizations:
 * 1. Assistant Prefilling - Start responses with partial content to guide format
 * 2. Concise Prompts - Direct instructions without verbose preambles
 * 3. Clear Tool Instructions - Concise but explicit tool usage guidance
 * 4. Structured Output - JSON mode and format enforcement
 */

/**
 * Assistant prefill options for different response types
 */
export const ASSISTANT_PREFILLS = {
	/** For JSON object responses */
	json: "{",
	/** For JSON array responses */
	jsonArray: "[",
	/** For markdown document responses */
	markdown: "# ",
	/** For code responses */
	code: "```",
	/** For numbered list responses */
	numberedList: "1. ",
	/** For bullet list responses */
	bulletList: "- ",
	/** Skip preamble and start directly */
	direct: "",
} as const;

export type AssistantPrefillType = keyof typeof ASSISTANT_PREFILLS;

/**
 * Create an assistant prefill message to guide response format.
 * This technique prevents verbose preambles like "Certainly!" or "I'd be happy to help!"
 *
 * @param type - The type of prefill to use
 * @param customPrefill - Optional custom prefill string
 * @returns The prefill string to use as assistant message start
 *
 * @example
 * // For JSON responses
 * const messages = [
 *   { role: "system", content: systemPrompt },
 *   { role: "user", content: userMessage },
 *   { role: "assistant", content: getAssistantPrefill("json") }
 * ];
 */
export function getAssistantPrefill(
	type: AssistantPrefillType,
	customPrefill?: string,
): string {
	return customPrefill ?? ASSISTANT_PREFILLS[type];
}

/**
 * Groq-optimized system prompt builder.
 * Creates concise, direct prompts following Groq best practices.
 */
export interface GroqSystemPromptOptions {
	/** Role definition - keep concise */
	role: string;
	/** Task description - be specific and direct */
	task: string;
	/** Output format specification */
	outputFormat?: string;
	/** Constraints and rules */
	constraints?: string[];
	/** Few-shot examples (keep minimal for speed) */
	examples?: Array<{ input: string; output: string }>;
	/** Whether to include anti-preamble instruction */
	skipPreamble?: boolean;
}

/**
 * Build a Groq-optimized system prompt.
 * Follows best practices: concise, direct, structured.
 *
 * @param options - Prompt configuration options
 * @returns Optimized system prompt string
 */
export function buildGroqSystemPrompt(
	options: GroqSystemPromptOptions,
): string {
	const parts: string[] = [];

	// Role - concise, no fluff
	parts.push(options.role);

	// Task - direct instruction
	parts.push(`\nTask: ${options.task}`);

	// Output format - explicit specification
	if (options.outputFormat) {
		parts.push(`\nOutput: ${options.outputFormat}`);
	}

	// Constraints - numbered for clarity
	if (options.constraints && options.constraints.length > 0) {
		parts.push("\nRules:");
		options.constraints.forEach((c, i) => {
			parts.push(`${i + 1}. ${c}`);
		});
	}

	// Examples - minimal for speed
	if (options.examples && options.examples.length > 0) {
		parts.push("\nExamples:");
		options.examples.forEach((ex) => {
			parts.push(`Input: ${ex.input}\nOutput: ${ex.output}`);
		});
	}

	// Anti-preamble instruction
	if (options.skipPreamble !== false) {
		parts.push("\nRespond directly without preamble.");
	}

	return parts.join("\n");
}

/**
 * Format tool descriptions for Groq models.
 * Keeps descriptions concise but clear.
 *
 * @param tools - Array of tool definitions
 * @returns Formatted tool description string
 */
export function formatToolDescriptions(
	tools: Array<{ name: string; description: string }>,
): string {
	return tools
		.map((t) => `- ${t.name}: ${t.description.split(".")[0]}`)
		.join("\n");
}

/**
 * Create a concise tool usage instruction.
 * Groq models perform better with explicit but brief tool guidance.
 */
export function getToolUsageInstruction(toolName: string): string {
	return `Use the ${toolName} tool to complete this task. Provide all required parameters.`;
}

/**
 * Wrap content for JSON output mode.
 * Adds instruction to ensure valid JSON response.
 */
export function wrapForJsonOutput(prompt: string): string {
	return `${prompt}\n\nRespond with valid JSON only.`;
}

/**
 * Common anti-preamble phrases to avoid in Groq prompts.
 * These phrases slow down responses and add no value.
 */
export const AVOID_PHRASES = [
	"Certainly!",
	"I'd be happy to help!",
	"Of course!",
	"Sure thing!",
	"Absolutely!",
	"Great question!",
	"Let me help you with that.",
] as const;
