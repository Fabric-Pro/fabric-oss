/**
 * Linear Integration Plugin
 * Aligned with Vercel workflow-builder-template patterns
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { LinearIcon } from "./icon";
import { LinearSettings } from "./LinearSettings";

export const linearPlugin: IntegrationPlugin = {
	type: "LINEAR",
	category: "tool",
	label: "Linear",
	description: "Create and manage issues in Linear",
	icon: LinearIcon,
	color: "text-indigo-500",
	brandColor: "#5E6AD2",
	SettingsComponent: LinearSettings,

	formFields: [
		{
			id: "apiKey",
			label: "Linear Access Token",
			type: "password",
			placeholder: "lin_api_...",
			helpText:
				"Get your API key from Linear Settings → Security → API Keys",
			configKey: "apiKey",
			envVar: "LINEAR_API_KEY",
			required: true,
		},
		{
			id: "teamId",
			label: "Team ID",
			type: "text",
			placeholder: "Leave blank for default team",
			helpText: "The team ID to create issues in",
			configKey: "teamId",
			envVar: "LINEAR_TEAM_ID",
			required: false,
		},
	],

	testConfig: {
		getTestFunction: async () => {
			const { testLinearConnection } = await import("./test");
			return testLinearConnection;
		},
	},

	actions: [
		{
			slug: "create-ticket",
			label: "Create Linear Ticket",
			description: "Create a new issue in Linear",
			category: "Productivity",
			stepFunction: "executeLinearCreateTicketStep",
			stepImportPath: "linear-create-ticket",
			outputFields: [
				{ field: "id", description: "Issue ID" },
				{
					field: "identifier",
					description: "Issue identifier (e.g., LIN-123)",
				},
				{ field: "title", description: "Issue title" },
				{ field: "url", description: "Issue URL" },
			],
			outputConfig: { type: "url", field: "url" },
			configFields: [
				{
					key: "ticketTitle",
					label: "Ticket Title",
					type: "template-input",
					required: true,
					placeholder:
						"Bug in user authentication or {{NodeName.title}}",
				},
				{
					key: "ticketDescription",
					label: "Description",
					type: "template-textarea",
					placeholder: "Detailed description or {{NodeName.field}}",
					rows: 4,
				},
				{
					key: "priority",
					label: "Priority",
					type: "select",
					options: [
						{ value: "0", label: "No Priority" },
						{ value: "1", label: "Urgent" },
						{ value: "2", label: "High" },
						{ value: "3", label: "Normal" },
						{ value: "4", label: "Low" },
					],
				},
			],
		},
		{
			slug: "find-issues",
			label: "Find Linear Issues",
			description: "Search for issues in Linear",
			category: "Productivity",
			stepFunction: "executeLinearFindIssuesStep",
			stepImportPath: "linear-find-issues",
			outputFields: [
				{ field: "issues", description: "Array of matching issues" },
				{ field: "count", description: "Number of matches" },
			],
			outputConfig: { type: "json", field: "issues" },
			configFields: [
				{
					key: "assignee",
					label: "Assignee (User ID)",
					type: "template-input",
					required: true,
					placeholder: "User ID or {{NodeName.userId}}",
				},
				{
					key: "teamId",
					label: "Team ID (Optional)",
					type: "template-input",
					placeholder: "Team ID or {{NodeName.teamId}}",
				},
				{
					key: "status",
					label: "Status (Optional)",
					type: "select",
					options: [
						{ value: "any", label: "Any" },
						{ value: "backlog", label: "Backlog" },
						{ value: "todo", label: "Todo" },
						{ value: "in_progress", label: "In Progress" },
						{ value: "done", label: "Done" },
						{ value: "canceled", label: "Canceled" },
					],
				},
				{
					key: "label",
					label: "Label (Optional)",
					type: "template-input",
					placeholder: "Label or {{NodeName.label}}",
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(linearPlugin);
