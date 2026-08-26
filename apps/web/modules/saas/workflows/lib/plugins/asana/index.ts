/**
 * Asana Integration Plugin
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { AsanaSettings } from "./AsanaSettings";
import { AsanaIcon } from "./icon";

const asanaPlugin: IntegrationPlugin = {
	type: "ASANA",
	category: "tool",
	label: "Asana",
	description: "Create and manage tasks in Asana projects",
	icon: AsanaIcon,
	color: "text-pink-500",
	brandColor: "#F06A6A",
	SettingsComponent: AsanaSettings,

	formFields: [
		{
			id: "apiKey",
			label: "Asana Personal Access Token",
			type: "password",
			placeholder: "1/1234567890abcdef:...",
			helpText:
				"Get your token from Asana Settings → Apps → Developer Apps → Personal Access Token",
			helpLink: {
				text: "How to get Asana token",
				url: "https://developers.asana.com/docs/personal-access-token",
			},
			configKey: "apiKey",
			envVar: "ASANA_ACCESS_TOKEN",
			required: true,
		},
	],

	testConfig: {
		getTestFunction: async () => {
			const { testAsanaConnection } = await import("./test");
			return testAsanaConnection;
		},
	},

	actions: [
		{
			slug: "create-task",
			label: "Create Asana Task",
			description: "Create a new task in an Asana project",
			category: "Productivity",
			stepFunction: "executeAsanaCreateTaskStep",
			stepImportPath: "asana-create-task",
			outputFields: [
				{ field: "taskId", description: "Task GID" },
				{ field: "taskUrl", description: "URL to the task" },
			],
			outputConfig: { type: "url", field: "taskUrl" },
			configFields: [
				{
					key: "name",
					label: "Task Name",
					type: "template-input",
					required: true,
					placeholder:
						"Fix bug in authentication or {{NodeName.title}}",
				},
				{
					key: "notes",
					label: "Notes / Description",
					type: "template-textarea",
					placeholder:
						"Detailed description or {{NodeName.description}}",
					rows: 4,
				},
				{
					key: "projectId",
					label: "Project ID",
					type: "template-input",
					placeholder: "Asana project GID",
				},
				{
					key: "dueOn",
					label: "Due Date (YYYY-MM-DD)",
					type: "template-input",
					placeholder: "2026-01-15 or {{NodeName.dueDate}}",
				},
			],
		},
		{
			slug: "list-tasks",
			label: "List Asana Tasks",
			description: "List tasks from an Asana project",
			category: "Productivity",
			stepFunction: "executeAsanaListTasksStep",
			stepImportPath: "asana-list-tasks",
			outputFields: [
				{ field: "tasks", description: "Array of tasks" },
				{ field: "count", description: "Number of tasks" },
			],
			outputConfig: { type: "json", field: "tasks" },
			configFields: [
				{
					key: "projectId",
					label: "Project ID",
					type: "template-input",
					required: true,
					placeholder: "Asana project GID",
				},
				{
					key: "completed",
					label: "Include Completed",
					type: "boolean",
					defaultValue: "false",
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(asanaPlugin);
