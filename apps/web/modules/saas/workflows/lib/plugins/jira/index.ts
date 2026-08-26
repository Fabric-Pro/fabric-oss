import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { JiraIcon } from "./icon";

const jiraPlugin: IntegrationPlugin = {
	type: "JIRA",
	category: "tool",
	label: "Jira",
	description: "Create and search Jira issues in real time",
	icon: JiraIcon,
	color: "text-blue-500",
	brandColor: "#2684FF",
	formFields: [
		{
			id: "domain",
			label: "Jira Domain",
			type: "text",
			placeholder: "your-company.atlassian.net",
			helpText: "Your Jira Cloud domain without https://",
			configKey: "domain",
			envVar: "JIRA_DOMAIN",
			required: true,
		},
		{
			id: "email",
			label: "Jira User Email (required for Jira Cloud)",
			type: "email",
			placeholder: "user@company.com",
			configKey: "email",
			envVar: "JIRA_EMAIL",
			required: true,
		},
		{
			id: "apiToken",
			label: "API or Personal Access Token",
			type: "password",
			placeholder: "Your Jira token",
			helpText:
				"Create an API token in your Atlassian account security settings.",
			helpLink: {
				text: "Create Jira API token",
				url: "https://id.atlassian.com/manage-profile/security/api-tokens",
			},
			configKey: "apiToken",
			envVar: "JIRA_API_TOKEN",
			required: true,
		},
	],
	testConfig: {
		getTestFunction: async () => {
			const { testJiraConnection } = await import("./test");
			return testJiraConnection;
		},
	},
	actions: [
		{
			slug: "create-issue",
			label: "Create Jira Issue",
			description: "Create a new issue in a Jira project",
			category: "Productivity",
			stepFunction: "executeJiraCreateIssueStep",
			stepImportPath: "jira-create-issue",
			outputFields: [
				{ field: "issueKey", description: "Created issue key" },
				{ field: "issueUrl", description: "Issue URL" },
			],
			outputConfig: { type: "url", field: "issueUrl" },
			configFields: [
				{
					key: "projectKey",
					label: "Project Key",
					type: "template-input",
					required: true,
					placeholder: "ENG",
				},
				{
					key: "summary",
					label: "Summary",
					type: "template-input",
					required: true,
					placeholder: "{{NodeName.title}}",
				},
				{
					key: "description",
					label: "Description",
					type: "template-textarea",
					rows: 4,
					placeholder: "Issue details",
				},
				{
					key: "issueType",
					label: "Issue Type",
					type: "template-input",
					placeholder: "Task, Bug, Story",
					defaultValue: "Task",
				},
			],
		},
		{
			slug: "search-issues",
			label: "Search Jira Issues",
			description: "Search Jira issues with JQL",
			category: "Productivity",
			stepFunction: "executeJiraSearchIssuesStep",
			stepImportPath: "jira-search-issues",
			outputFields: [
				{ field: "issues", description: "Matching issues" },
				{ field: "count", description: "Number of issues returned" },
			],
			outputConfig: { type: "json", field: "issues" },
			configFields: [
				{
					key: "jql",
					label: "JQL Query",
					type: "template-textarea",
					required: true,
					rows: 3,
					placeholder: 'project = ENG AND text ~ "customer"',
				},
				{
					key: "maxResults",
					label: "Max Results",
					type: "number",
					defaultValue: "25",
				},
			],
		},
	],
};

registerIntegration(jiraPlugin);
