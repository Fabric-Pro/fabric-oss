/**
 * GitHub Integration Plugin
 * Create issues, PRs, and interact with repositories
 *
 * Supports both OAuth (recommended) and Personal Access Token authentication.
 * Aligned with Vercel workflow-builder-template patterns
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { GitHubSettings } from "./GitHubSettings";
import { GitHubIcon } from "./icon";

const githubPlugin: IntegrationPlugin = {
	type: "GITHUB",
	category: "both",
	label: "GitHub",
	description: "Create issues, PRs, and interact with repositories",
	icon: GitHubIcon,
	color: "text-gray-800 dark:text-gray-200",
	brandColor: "#24292e",

	// Custom settings component that supports OAuth and PAT
	settingsComponent: GitHubSettings,

	// Form fields are still defined for PAT fallback and credential mapping
	formFields: [
		{
			id: "apiKey",
			label: "GitHub Token",
			type: "password",
			placeholder: "ghp_xxxxxxxxxxxx",
			configKey: "apiKey",
			envVar: "GITHUB_TOKEN",
			helpText: "Create a personal access token with repo permissions",
			helpLink: {
				text: "github.com/settings/tokens",
				url: "https://github.com/settings/tokens",
			},
			required: false, // Not required when using OAuth
		},
	],

	testConfig: {
		getTestFunction: async () => {
			const { testGithubConnection } = await import("./test");
			return testGithubConnection;
		},
	},

	actions: [
		{
			slug: "create-issue",
			label: "Create Issue",
			description: "Create a new GitHub issue",
			category: "Developer",
			stepFunction: "executeGithubCreateIssueStep",
			stepImportPath: "github-create-issue",
			outputFields: [
				{ field: "issueNumber", description: "Issue number" },
				{ field: "issueUrl", description: "Issue URL" },
				{ field: "issueId", description: "Issue ID" },
			],
			outputConfig: { type: "url", field: "issueUrl" },
			configFields: [
				{
					key: "owner",
					label: "Repository Owner",
					type: "template-input",
					placeholder: "owner",
					required: true,
					example: "vercel",
				},
				{
					key: "repo",
					label: "Repository Name",
					type: "template-input",
					placeholder: "repository",
					required: true,
					example: "next.js",
				},
				{
					key: "issueTitle",
					label: "Issue Title",
					type: "template-input",
					placeholder: "Issue title",
					required: true,
					example: "Bug: Unexpected behavior in feature X",
				},
				{
					key: "issueBody",
					label: "Issue Body",
					type: "template-textarea",
					placeholder: "Issue description (Markdown supported)",
					rows: 6,
				},
				{
					key: "labels",
					label: "Labels",
					type: "template-input",
					placeholder: "bug, enhancement (comma-separated)",
				},
				{
					key: "assignees",
					label: "Assignees",
					type: "template-input",
					placeholder: "username1, username2 (comma-separated)",
				},
			],
		},
		{
			slug: "search-issues",
			label: "Search Issues",
			description: "Search for issues and PRs",
			category: "Developer",
			stepFunction: "executeGithubSearchIssuesStep",
			stepImportPath: "github-search-issues",
			outputFields: [
				{ field: "items", description: "Search results" },
				{ field: "totalCount", description: "Total number of matches" },
			],
			outputConfig: { type: "json", field: "items" },
			configFields: [
				{
					key: "query",
					label: "Search Query",
					type: "template-input",
					placeholder: "is:issue is:open label:bug",
					required: true,
					example: "repo:vercel/next.js is:issue is:open",
				},
				{
					key: "limit",
					label: "Max Results",
					type: "number",
					defaultValue: "10",
					min: 1,
				},
			],
		},
		{
			slug: "get-file",
			label: "Get File Contents",
			description: "Get the contents of a file from a repository",
			category: "Developer",
			stepFunction: "executeGithubGetFileStep",
			stepImportPath: "github-get-file",
			outputFields: [
				{ field: "content", description: "File content (decoded)" },
				{ field: "sha", description: "File SHA" },
				{ field: "path", description: "File path" },
			],
			outputConfig: { type: "json", field: "content" },
			configFields: [
				{
					key: "owner",
					label: "Repository Owner",
					type: "template-input",
					placeholder: "owner",
					required: true,
				},
				{
					key: "repo",
					label: "Repository Name",
					type: "template-input",
					placeholder: "repository",
					required: true,
				},
				{
					key: "filePath",
					label: "File Path",
					type: "template-input",
					placeholder: "path/to/file.ts",
					required: true,
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
		{
			slug: "get-diff",
			label: "Get Diff",
			description:
				"Get the diff between two commits/branches or for a pull request",
			category: "Developer",
			stepFunction: "executeGithubGetDiffStep",
			stepImportPath: "github-get-diff",
			outputFields: [
				{ field: "diff", description: "Unified diff output" },
				{ field: "additions", description: "Lines added (PR mode)" },
				{ field: "deletions", description: "Lines removed (PR mode)" },
				{
					field: "changedFiles",
					description: "Number of files changed (PR mode)",
				},
			],
			outputConfig: { type: "json", field: "diff" },
			configFields: [
				{
					key: "owner",
					label: "Repository Owner",
					type: "template-input",
					placeholder: "owner",
					required: true,
				},
				{
					key: "repo",
					label: "Repository Name",
					type: "template-input",
					placeholder: "repository",
					required: true,
				},
				{
					key: "prNumber",
					label: "Pull Request Number",
					type: "template-input",
					placeholder: "42",
					description:
						"Leave blank to compare branches/commits instead",
				},
				{
					key: "base",
					label: "Base Branch / Commit",
					type: "template-input",
					placeholder: "main",
					description: "Used when no PR number is provided",
				},
				{
					key: "head",
					label: "Head Branch / Commit",
					type: "template-input",
					placeholder: "feature/my-branch",
					description: "Used when no PR number is provided",
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(githubPlugin);
