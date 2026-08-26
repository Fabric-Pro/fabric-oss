import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { GitLabSettings } from "./GitLabSettings";
import { GitLabIcon } from "./icon";

const gitlabPlugin: IntegrationPlugin = {
	type: "GITLAB",
	category: "both",
	label: "GitLab",
	description: "Create and search GitLab issues and merge requests",
	icon: GitLabIcon,
	color: "text-orange-500",
	brandColor: "#FC6D26",

	// Custom settings component that supports OAuth and PAT
	settingsComponent: GitLabSettings,

	// Form fields are still defined for PAT fallback and credential mapping
	formFields: [
		{
			id: "domain",
			label: "GitLab URL",
			type: "url",
			placeholder: "https://gitlab.com",
			configKey: "domain",
			envVar: "GITLAB_URL",
			required: false,
		},
		{
			id: "apiToken",
			label: "GitLab Access Token",
			type: "password",
			placeholder: "glpat-...",
			helpText: "Create a personal access token in GitLab user settings.",
			configKey: "apiToken",
			envVar: "GITLAB_ACCESS_TOKEN",
			required: false, // Not required when using OAuth
		},
	],
	testConfig: {
		getTestFunction: async () => {
			const { testGitLabConnection } = await import("./test");
			return testGitLabConnection;
		},
	},
	actions: [
		{
			slug: "create-issue",
			label: "Create GitLab Issue",
			description: "Create a new issue in a GitLab project",
			category: "Developer",
			stepFunction: "executeGitLabCreateIssueStep",
			stepImportPath: "gitlab-create-issue",
			outputFields: [
				{ field: "issueId", description: "Created issue id" },
				{ field: "issueUrl", description: "Issue URL" },
			],
			outputConfig: { type: "url", field: "issueUrl" },
			configFields: [
				{
					key: "projectId",
					label: "Project ID or URL-encoded Path",
					type: "template-input",
					required: true,
					placeholder: "group%2Fproject",
				},
				{
					key: "title",
					label: "Issue Title",
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
					key: "labels",
					label: "Labels",
					type: "template-input",
					placeholder: "bug,customer",
				},
			],
		},
		{
			slug: "search-issues",
			label: "Search GitLab Issues",
			description: "Search issues in a GitLab project",
			category: "Developer",
			stepFunction: "executeGitLabSearchIssuesStep",
			stepImportPath: "gitlab-search-issues",
			outputFields: [
				{ field: "issues", description: "Matching issues" },
				{ field: "count", description: "Number of issues returned" },
			],
			outputConfig: { type: "json", field: "issues" },
			configFields: [
				{
					key: "projectId",
					label: "Project ID or URL-encoded Path",
					type: "template-input",
					required: true,
					placeholder: "group%2Fproject",
				},
				{
					key: "search",
					label: "Search Query",
					type: "template-input",
					required: true,
					placeholder: "customer, auth, {{NodeName.query}}",
				},
				{
					key: "state",
					label: "State",
					type: "select",
					options: [
						{ value: "opened", label: "Opened" },
						{ value: "closed", label: "Closed" },
						{ value: "all", label: "All" },
					],
					defaultValue: "opened",
				},
			],
		},
		{
			slug: "get-file",
			label: "Get File Contents",
			description: "Get the contents of a file from a GitLab project",
			category: "Developer",
			stepFunction: "executeGitLabGetFileStep",
			stepImportPath: "gitlab-get-file",
			outputFields: [
				{ field: "content", description: "File content (decoded)" },
				{ field: "sha", description: "Blob SHA" },
				{ field: "path", description: "File path" },
				{ field: "size", description: "File size in bytes" },
				{ field: "encoding", description: "Source encoding" },
			],
			outputConfig: { type: "json", field: "content" },
			configFields: [
				{
					key: "projectId",
					label: "Project ID or URL-encoded Path",
					type: "template-input",
					required: true,
					placeholder: "group%2Fproject",
				},
				{
					key: "filePath",
					label: "File Path",
					type: "template-input",
					required: true,
					placeholder: "path/to/file.ts",
				},
				{
					key: "ref",
					label: "Branch/Tag/SHA",
					type: "template-input",
					placeholder: "main",
					defaultValue: "main",
				},
			],
		},
	],
};

registerIntegration(gitlabPlugin);
