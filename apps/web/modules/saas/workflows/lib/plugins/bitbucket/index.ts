import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { BitbucketIcon } from "./icon";

const bitbucketPlugin: IntegrationPlugin = {
	type: "BITBUCKET",
	category: "tool",
	label: "Bitbucket",
	description: "Create and search Bitbucket issues live",
	icon: BitbucketIcon,
	color: "text-blue-500",
	brandColor: "#2684FF",
	formFields: [
		{
			id: "email",
			label: "Bitbucket Account Email",
			type: "email",
			placeholder: "you@example.com",
			configKey: "email",
			envVar: "BITBUCKET_EMAIL",
			required: true,
		},
		{
			id: "apiToken",
			label: "Bitbucket API Token",
			type: "password",
			placeholder: "Bitbucket app password",
			configKey: "apiToken",
			envVar: "BITBUCKET_API_TOKEN",
			required: true,
		},
	],
	testConfig: {
		getTestFunction: async () => {
			const { testBitbucketConnection } = await import("./test");
			return testBitbucketConnection;
		},
	},
	actions: [
		{
			slug: "create-issue",
			label: "Create Bitbucket Issue",
			description: "Create a new issue in a Bitbucket repository",
			category: "Developer",
			stepFunction: "executeBitbucketCreateIssueStep",
			stepImportPath: "bitbucket-create-issue",
			outputFields: [
				{ field: "issueId", description: "Created issue id" },
				{ field: "issueUrl", description: "Issue URL" },
			],
			outputConfig: { type: "url", field: "issueUrl" },
			configFields: [
				{
					key: "workspace",
					label: "Workspace",
					type: "template-input",
					required: true,
					placeholder: "team-slug",
				},
				{
					key: "repoSlug",
					label: "Repository Slug",
					type: "template-input",
					required: true,
					placeholder: "repo-name",
				},
				{
					key: "title",
					label: "Issue Title",
					type: "template-input",
					required: true,
					placeholder: "{{NodeName.title}}",
				},
				{
					key: "content",
					label: "Issue Content",
					type: "template-textarea",
					rows: 4,
					placeholder: "Issue details",
				},
				{
					key: "kind",
					label: "Kind",
					type: "select",
					options: [
						{ value: "bug", label: "Bug" },
						{ value: "enhancement", label: "Enhancement" },
						{ value: "proposal", label: "Proposal" },
						{ value: "task", label: "Task" },
					],
					defaultValue: "task",
				},
			],
		},
		{
			slug: "search-issues",
			label: "Search Bitbucket Issues",
			description: "Search issues in a Bitbucket repository",
			category: "Developer",
			stepFunction: "executeBitbucketSearchIssuesStep",
			stepImportPath: "bitbucket-search-issues",
			outputFields: [
				{ field: "issues", description: "Matching issues" },
				{ field: "count", description: "Number of issues returned" },
			],
			outputConfig: { type: "json", field: "issues" },
			configFields: [
				{
					key: "workspace",
					label: "Workspace",
					type: "template-input",
					required: true,
					placeholder: "team-slug",
				},
				{
					key: "repoSlug",
					label: "Repository Slug",
					type: "template-input",
					required: true,
					placeholder: "repo-name",
				},
				{
					key: "query",
					label: "Search Query",
					type: "template-input",
					required: true,
					placeholder: "auth, customer, {{NodeName.query}}",
				},
				{
					key: "state",
					label: "State",
					type: "select",
					options: [
						{ value: "new", label: "New" },
						{ value: "open", label: "Open" },
						{ value: "resolved", label: "Resolved" },
						{ value: "closed", label: "Closed" },
					],
					defaultValue: "open",
				},
			],
		},
	],
};

registerIntegration(bitbucketPlugin);
