"use client";

/**
 * useAgentActions Hook
 *
 * Registers standard frontend actions with CopilotKit.
 * These actions can be called by AI agents to manipulate the UI.
 */

import { useCopilotAction } from "@copilotkit/react-core";
import { useCallback } from "react";
import { toast } from "sonner";

interface UseAgentActionsOptions {
	/** Callback when document is updated */
	onDocumentUpdate?: (
		content: string,
		mode: "replace" | "append" | "prepend",
	) => void;
	/** Callback when section is generated */
	onSectionGenerate?: (
		sectionName: string,
		sectionType: string,
		content: string,
	) => void;
	/** Callback when task is executed */
	onTaskExecute?: (taskName: string, result: unknown) => void;
	/** Callback when UI state is updated */
	onUIStateUpdate?: (updates: Record<string, unknown>) => void;
	/** Callback when user input is requested */
	onUserInputRequest?: (
		prompt: string,
		inputType: string,
	) => Promise<string | boolean | string[] | null>;
}

export function useAgentActions(options: UseAgentActionsOptions = {}) {
	// Register updateDocument action
	useCopilotAction({
		name: "updateDocument",
		description: "Update the content of the document being edited",
		parameters: [
			{
				name: "content",
				type: "string",
				description: "The new document content",
				required: true,
			},
			{
				name: "mode",
				type: "string",
				description:
					"How to update the document (replace, append, prepend)",
				required: false,
			},
			{
				name: "section",
				type: "string",
				description: "Specific section to update (optional)",
				required: false,
			},
		],
		handler: useCallback(
			async (args: unknown) => {
				const {
					content,
					mode = "replace",
					section,
				} = args as {
					content: string;
					mode?: "replace" | "append" | "prepend";
					section?: string;
				};
				console.log("[useAgentActions] updateDocument:", {
					content,
					mode,
					section,
				});
				options.onDocumentUpdate?.(
					content,
					mode as "replace" | "append" | "prepend",
				);
				toast.success("Document updated");
				return { success: true };
			},
			[options],
		),
	});

	// Register generateSection action
	useCopilotAction({
		name: "generateSection",
		description: "Generate a specific section of the document",
		parameters: [
			{
				name: "sectionName",
				type: "string",
				description: "Name of the section to generate",
				required: true,
			},
			{
				name: "sectionType",
				type: "string",
				description: "Type of section content",
				required: true,
			},
			{
				name: "context",
				type: "string",
				description: "Additional context for section generation",
				required: false,
			},
		],
		handler: useCallback(
			async (args: unknown) => {
				const { sectionName, sectionType, context } = args as {
					sectionName: string;
					sectionType: string;
					context?: string;
				};
				console.log("[useAgentActions] generateSection:", {
					sectionName,
					sectionType,
					context,
				});
				// In real implementation, this would generate the section content
				const generatedContent = `# ${sectionName}\n\n[Generated content for ${sectionName}]`;
				options.onSectionGenerate?.(
					sectionName,
					sectionType,
					generatedContent,
				);
				toast.success(`Section "${sectionName}" generated`);
				return { success: true, content: generatedContent };
			},
			[options],
		),
	});

	// Register executeTask action
	useCopilotAction({
		name: "executeTask",
		description: "Execute a custom task with specified parameters",
		parameters: [
			{
				name: "taskName",
				type: "string",
				description: "Name of the task to execute",
				required: true,
			},
			{
				name: "taskType",
				type: "string",
				description: "Type of task",
				required: true,
			},
			{
				name: "parameters",
				type: "object",
				description: "Task-specific parameters",
				required: true,
			},
		],
		handler: useCallback(
			async (args: unknown) => {
				const { taskName, taskType, parameters } = args as {
					taskName: string;
					taskType: string;
					parameters: Record<string, unknown>;
				};
				console.log("[useAgentActions] executeTask:", {
					taskName,
					taskType,
					parameters,
				});
				// Execute task logic here
				const result = {
					status: "completed",
					output: "Task completed successfully",
				};
				options.onTaskExecute?.(taskName, result);
				toast.success(`Task "${taskName}" executed`);
				return { success: true, result };
			},
			[options],
		),
	});

	// Register updateUIState action
	useCopilotAction({
		name: "updateUIState",
		description: "Update arbitrary UI state fields",
		parameters: [
			{
				name: "updates",
				type: "object",
				description: "State updates to apply",
				required: true,
			},
			{
				name: "merge",
				type: "boolean",
				description: "Whether to merge with existing state or replace",
				required: false,
			},
		],
		handler: useCallback(
			async (args: unknown) => {
				const { updates, merge = true } = args as {
					updates: Record<string, unknown>;
					merge?: boolean;
				};
				console.log("[useAgentActions] updateUIState:", {
					updates,
					merge,
				});
				options.onUIStateUpdate?.(updates);
				return { success: true };
			},
			[options],
		),
	});

	// Register showNotification action
	useCopilotAction({
		name: "showNotification",
		description: "Display a notification to the user",
		parameters: [
			{
				name: "message",
				type: "string",
				description: "Notification message",
				required: true,
			},
			{
				name: "type",
				type: "string",
				description:
					"Notification type (info, success, warning, error)",
				required: false,
			},
			{
				name: "duration",
				type: "number",
				description: "Duration in milliseconds",
				required: false,
			},
		],
		handler: useCallback(async (args: unknown) => {
			const {
				message,
				type = "info",
				duration = 5000,
			} = args as {
				message: string;
				type?: "info" | "success" | "warning" | "error";
				duration?: number;
			};
			console.log("[useAgentActions] showNotification:", {
				message,
				type,
				duration,
			});

			switch (type) {
				case "success":
					toast.success(message, { duration });
					break;
				case "error":
					toast.error(message, { duration });
					break;
				case "warning":
					toast.warning(message, { duration });
					break;
				default:
					toast.info(message, { duration });
			}

			return { success: true };
		}, []),
	});

	// Register requestUserInput action
	useCopilotAction({
		name: "requestUserInput",
		description: "Request input or confirmation from the user",
		parameters: [
			{
				name: "prompt",
				type: "string",
				description: "Prompt to display to the user",
				required: true,
			},
			{
				name: "inputType",
				type: "string",
				description: "Type of input to request",
				required: true,
			},
			{
				name: "options",
				type: "string[]",
				description: "Options for select/multiselect",
				required: false,
			},
			{
				name: "required",
				type: "boolean",
				description: "Whether input is required",
				required: false,
			},
		],
		handler: useCallback(
			async (args: unknown) => {
				const {
					prompt,
					inputType,
					options: optionList,
					required = true,
				} = args as {
					prompt: string;
					inputType: string;
					options?: string[];
					required?: boolean;
				};
				console.log("[useAgentActions] requestUserInput:", {
					prompt,
					inputType,
					options: optionList,
					required,
				});

				// In real implementation, this would show a dialog and wait for user input
				const userResponse = await options.onUserInputRequest?.(
					prompt,
					inputType,
				);

				return { success: true, userResponse };
			},
			[options],
		),
	});

	return {
		// Return any utility functions if needed
		triggerAction: useCallback(
			(actionName: string, params: Record<string, unknown>) => {
				console.log(
					"[useAgentActions] Manually triggering action:",
					actionName,
					params,
				);
				// This could be used to manually trigger actions from the UI
			},
			[],
		),
	};
}
