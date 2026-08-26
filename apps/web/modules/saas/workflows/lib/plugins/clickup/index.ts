import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { ClickUpIcon } from "./icon";

const clickupPlugin: IntegrationPlugin = {
	type: "CLICKUP",
	category: "tool",
	label: "ClickUp",
	description: "Create and search ClickUp tasks in your workspace",
	icon: ClickUpIcon,
	color: "text-violet-500",
	brandColor: "#7C3AED",
	formFields: [
		{
			id: "apiToken",
			label: "ClickUp API Token",
			type: "password",
			placeholder: "pk_...",
			helpText: "Generate a personal API token from ClickUp settings.",
			configKey: "apiToken",
			envVar: "CLICKUP_API_TOKEN",
			required: true,
		},
		{
			id: "teamId",
			label: "ClickUp Team ID",
			type: "text",
			placeholder: "Optional default team id",
			helpText:
				"Optional default team/workspace used when list IDs are not provided.",
			configKey: "teamId",
			envVar: "CLICKUP_TEAM_ID",
			required: false,
		},
	],
	testConfig: {
		getTestFunction: async () => {
			const { testClickUpConnection } = await import("./test");
			return testClickUpConnection;
		},
	},
	actions: [
		{
			slug: "create-task",
			label: "Create ClickUp Task",
			description: "Create a new task in a ClickUp list",
			category: "Productivity",
			stepFunction: "executeClickUpCreateTaskStep",
			stepImportPath: "clickup-create-task",
			outputFields: [
				{ field: "taskId", description: "Created task id" },
				{ field: "taskUrl", description: "ClickUp task URL" },
			],
			outputConfig: { type: "url", field: "taskUrl" },
			configFields: [
				{
					key: "listId",
					label: "List ID",
					type: "template-input",
					required: true,
					placeholder: "ClickUp list id",
				},
				{
					key: "name",
					label: "Task Name",
					type: "template-input",
					required: true,
					placeholder: "{{NodeName.title}}",
				},
				{
					key: "description",
					label: "Description",
					type: "template-textarea",
					rows: 4,
					placeholder: "Task description",
				},
				{
					key: "assigneeId",
					label: "Assignee User ID",
					type: "template-input",
					placeholder: "Optional assignee user id",
				},
				{
					key: "priority",
					label: "Priority",
					type: "select",
					options: [
						{ value: "1", label: "Urgent" },
						{ value: "2", label: "High" },
						{ value: "3", label: "Normal" },
						{ value: "4", label: "Low" },
					],
				},
			],
		},
		{
			slug: "search-tasks",
			label: "Search ClickUp Tasks",
			description: "Search tasks live in ClickUp",
			category: "Productivity",
			stepFunction: "executeClickUpSearchTasksStep",
			stepImportPath: "clickup-search-tasks",
			outputFields: [
				{ field: "tasks", description: "Matching tasks" },
				{ field: "count", description: "Number of tasks returned" },
			],
			outputConfig: { type: "json", field: "tasks" },
			configFields: [
				{
					key: "query",
					label: "Search Query",
					type: "template-input",
					required: true,
					placeholder: "bug, customer issue, {{NodeName.query}}",
				},
				{
					key: "listId",
					label: "List ID",
					type: "template-input",
					placeholder: "Optional list id",
				},
				{
					key: "teamId",
					label: "Team ID",
					type: "template-input",
					placeholder: "Optional team/workspace id",
				},
				{
					key: "includeClosed",
					label: "Include Closed Tasks",
					type: "boolean",
					defaultValue: "false",
				},
			],
		},
	],
};

registerIntegration(clickupPlugin);
