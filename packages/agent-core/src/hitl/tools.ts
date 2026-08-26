/**
 * HITL Tool Definitions
 *
 * Tool definitions that agents can use to request human input.
 * These tools are designed to work with CopilotKit's action system.
 */

import type { HITLOption } from "./types";

/**
 * Tool definition for requesting human approval
 */
export const REQUEST_HUMAN_APPROVAL_TOOL = {
	name: "request_human_approval",
	description: `Request human approval before proceeding with an action.
Use this tool when you need to:
- Confirm a destructive operation (delete, update, etc.)
- Verify a significant decision before executing
- Get user consent for an action that might have consequences

The user will see a dialog and can approve or reject the action.`,
	parameters: {
		type: "object",
		properties: {
			prompt: {
				type: "string",
				description:
					"The question or action to approve. Be specific about what will happen if approved.",
			},
			title: {
				type: "string",
				description: "Optional title for the approval dialog",
			},
			context: {
				type: "object",
				description: "Optional context data to display to the user",
			},
			timeout: {
				type: "number",
				description: "Timeout in milliseconds (default: 60000)",
			},
		},
		required: ["prompt"],
	},
};

/**
 * Tool definition for requesting human text input
 */
export const REQUEST_HUMAN_INPUT_TOOL = {
	name: "request_human_input",
	description: `Request text input from the user.
Use this tool when you need:
- A piece of information the user must provide
- Clarification or additional details
- User preferences or custom values

The user will see an input field and can provide their response.`,
	parameters: {
		type: "object",
		properties: {
			prompt: {
				type: "string",
				description:
					"The question to ask the user. Be clear about what information you need.",
			},
			title: {
				type: "string",
				description: "Optional title for the input dialog",
			},
			defaultValue: {
				type: "string",
				description: "Optional default value to pre-fill",
			},
			required: {
				type: "boolean",
				description: "Whether input is required (default: false)",
			},
			context: {
				type: "object",
				description: "Optional context data to display to the user",
			},
			timeout: {
				type: "number",
				description: "Timeout in milliseconds (default: 60000)",
			},
		},
		required: ["prompt"],
	},
};

/**
 * Tool definition for requesting human choice
 */
export const REQUEST_HUMAN_CHOICE_TOOL = {
	name: "request_human_choice",
	description: `Request the user to choose from a list of options.
Use this tool when you need:
- User to select from predefined options
- A decision between multiple approaches
- Configuration or preference selection

The user will see the options and can select one (or multiple if multiSelect is true).`,
	parameters: {
		type: "object",
		properties: {
			prompt: {
				type: "string",
				description:
					"The question to ask the user. Explain what the choice affects.",
			},
			title: {
				type: "string",
				description: "Optional title for the choice dialog",
			},
			options: {
				type: "array",
				items: {
					type: "object",
					properties: {
						value: {
							type: "string",
							description: "The value returned if selected",
						},
						label: {
							type: "string",
							description: "Display label for the option",
						},
						description: {
							type: "string",
							description: "Optional description of the option",
						},
						icon: {
							type: "string",
							description: "Optional icon identifier",
						},
					},
					required: ["value", "label"],
				},
				description: "The available options to choose from",
			},
			multiSelect: {
				type: "boolean",
				description:
					"Whether multiple selections are allowed (default: false)",
			},
			context: {
				type: "object",
				description: "Optional context data to display to the user",
			},
			timeout: {
				type: "number",
				description: "Timeout in milliseconds (default: 60000)",
			},
		},
		required: ["prompt", "options"],
	},
};

/**
 * All HITL tools
 */
export const HITL_TOOLS = [
	REQUEST_HUMAN_APPROVAL_TOOL,
	REQUEST_HUMAN_INPUT_TOOL,
	REQUEST_HUMAN_CHOICE_TOOL,
];

/**
 * Helper to create choice options
 */
export function createChoiceOptions(
	options: Array<{ value: string; label: string; description?: string }>,
): HITLOption[] {
	return options.map((o) => ({
		value: o.value,
		label: o.label,
		description: o.description,
	}));
}

/**
 * Common choice presets
 */
export const CHOICE_PRESETS = {
	yesNo: createChoiceOptions([
		{ value: "yes", label: "Yes", description: "Proceed with the action" },
		{ value: "no", label: "No", description: "Cancel the action" },
	]),
	continueCancel: createChoiceOptions([
		{
			value: "continue",
			label: "Continue",
			description: "Continue with the operation",
		},
		{ value: "cancel", label: "Cancel", description: "Stop and cancel" },
	]),
	priority: createChoiceOptions([
		{ value: "low", label: "Low", description: "Low priority" },
		{ value: "medium", label: "Medium", description: "Medium priority" },
		{ value: "high", label: "High", description: "High priority" },
		{
			value: "critical",
			label: "Critical",
			description: "Critical priority",
		},
	]),
	complexity: createChoiceOptions([
		{
			value: "simple",
			label: "Simple",
			description: "Quick and straightforward",
		},
		{
			value: "moderate",
			label: "Moderate",
			description: "Some complexity involved",
		},
		{
			value: "complex",
			label: "Complex",
			description: "Requires careful handling",
		},
	]),
};
