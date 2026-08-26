/**
 * Prompt Enhancer Prompts Module
 *
 * Handles system prompt generation for prompt enhancement.
 * Uses simple, direct prompt style matching ag-ui-demo for best model compatibility.
 */

import { FORMAT_GUIDANCE, type PromptFormat } from "../types.js";

/**
 * Generate system prompt for prompt enhancement
 *
 * Uses simple, direct instructions matching ag-ui-demo for best model compatibility.
 * Complex prompts with lots of warnings can confuse models.
 *
 * @param currentContent - Current content of the prompt (legacy, may be undefined)
 * @param format - The template format of the prompt (HANDLEBARS, LIQUID, etc.)
 * @returns System prompt string
 */
export function getSystemPrompt(
	currentContent: string | undefined,
	format?: PromptFormat,
): string {
	// Get format-specific guidance if format is provided
	const formatGuidance =
		format && FORMAT_GUIDANCE[format]
			? `\nTemplate format (${format}): ${FORMAT_GUIDANCE[format]}`
			: "";

	return `You are an expert prompt engineer specializing in improving AI prompts.

To enhance the prompt, you MUST use the enhance_prompt_local tool.
You MUST write the full prompt, even when changing only a few words.
When making edits, try to make them minimal - do not change every word.

## Response Format (Two-Channel Pattern)

Your response has two parts:
1. **Tool call**: Contains the enhanced prompt (streams to editor)
2. **Message content**: Brief summary + follow-up question (appears in sidebar)

### After Enhancement:
- Summarize changes briefly (1-2 sentences)
- Ask a relevant follow-up question to help refine the prompt further

### Good Follow-Up Questions:
- "Would you like me to add more specific examples or personas?"
- "Should I make the instructions more detailed for edge cases?"
- "Would you like me to add output format specifications?"
- "Should I include constraints or guardrails for safety?"

Important rules:
- Do NOT add template variables unless the user explicitly asks
- If the prompt has existing variables ({{var}}, {% var %}), preserve them exactly
${formatGuidance}

This is the current state of the prompt:
----
${currentContent || ""}
----`;
}

/**
 * Get the predict_state metadata configuration for AG-UI protocol
 *
 * @returns Predict state configuration
 */
export function getPredictStateConfig() {
	return [
		{
			state_key: "streamingContent",
			tool: "enhance_prompt_local",
			tool_argument: "enhancedContent",
		},
		{
			state_key: "focusAnchor",
			tool: "enhance_prompt_local",
			tool_argument: "focusAnchor",
		},
	];
}
