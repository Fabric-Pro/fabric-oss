/**
 * @repo/agent-tools
 *
 * Framework-agnostic tool definitions for agents.
 * These tool definitions work with agents written in any language (TypeScript, Python, C#)
 * as long as they support the AG-UI protocol.
 */
/**
 * Write document tool
 * Single source of truth for the document writing tool definition
 * Used by all agents regardless of implementation language
 */
export const WRITE_DOCUMENT_TOOL = {
	type: "function",
	function: {
		name: "write_document_local",
		description: [
			"Write a document. Use markdown formatting to format the document.",
			"It's good to format the document extensively so it's easy to read.",
			"You can use all kinds of markdown.",
			"However, do not use italic or strike-through formatting, it's reserved for another purpose.",
			"You MUST write the full document, even when changing only a few words.",
			"When making edits to the document, try to make them minimal - do not change every word.",
			"Keep stories SHORT!",
			"When you update a specific section, include 'focusAnchor' as the exact section heading (e.g., '## Overview') so the UI can scroll to it.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				document: {
					type: "string",
					description: "The document to write",
				},
				focusAnchor: {
					type: "string",
					description:
						"Optional: The exact markdown section heading where the latest changes were applied (e.g., '## Overview')",
				},
			},
			required: ["document"],
		},
	},
};
/**
 * Confirm changes tool
 * Used to request user confirmation for document changes
 */
export const CONFIRM_CHANGES_TOOL = {
	type: "function",
	function: {
		name: "confirm_changes",
		description: "Request user confirmation for document changes",
		parameters: {
			type: "object",
			properties: {},
		},
	},
};
/**
 * Enhance prompt tool
 * Used by the Prompt Enhancer Agent to update prompt content
 */
export const ENHANCE_PROMPT_TOOL = {
	type: "function",
	function: {
		name: "enhance_prompt_local",
		description: [
			"Enhance a prompt with AI-powered improvements.",
			"You MUST write the COMPLETE enhanced prompt content in the 'enhancedContent' parameter.",
			"The 'enhancedContent' parameter must contain the FULL PROMPT TEXT, not a summary or explanation.",
			"Even when making small changes, you MUST include the entire prompt content.",
			"Preserve the template format syntax (Handlebars, Mustache, Liquid, Jinja2, etc.) EXACTLY.",
			"Apply best practices for the prompt category.",
			"Make improvements clear and actionable.",
			"Put your explanation of changes in the separate 'explanation' parameter, NOT in 'enhancedContent'.",
			"When you update a specific section, include 'focusAnchor' to help the UI highlight changes.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				enhancedContent: {
					type: "string",
					description:
						"The COMPLETE enhanced prompt content (full text, not a summary)",
				},
				explanation: {
					type: "string",
					description:
						"Brief explanation of the changes made (separate from the prompt content)",
				},
				focusAnchor: {
					type: "string",
					description:
						"Optional: Specific section or line where key changes were made",
				},
			},
			required: ["enhancedContent"],
		},
	},
};
/**
 * Get all standard document tools
 */
export function getDocumentTools() {
	return [WRITE_DOCUMENT_TOOL, CONFIRM_CHANGES_TOOL];
}
/**
 * Get all prompt enhancement tools
 */
export function getPromptTools() {
	return [ENHANCE_PROMPT_TOOL];
}
//# sourceMappingURL=index.js.map
