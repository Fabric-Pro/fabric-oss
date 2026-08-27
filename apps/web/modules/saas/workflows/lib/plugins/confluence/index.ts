/**
 * Confluence Integration Plugin
 * Provides document access and knowledge retrieval from Atlassian Confluence
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { ConfluenceIcon } from "./icon";

const confluencePlugin: IntegrationPlugin = {
	type: "CONFLUENCE",
	category: "knowledge",
	label: "Confluence",
	description:
		"Connect wikis and documentation from Atlassian Confluence as knowledge sources",
	icon: ConfluenceIcon,
	color: "text-blue-600",
	brandColor: "#0052CC",

	formFields: [
		{
			id: "domain",
			label: "Confluence Domain",
			type: "url",
			placeholder: "your-domain.atlassian.net",
			helpText: "Your Atlassian Cloud domain (without https://)",
			configKey: "domain",
			envVar: "CONFLUENCE_DOMAIN",
			required: true,
		},
		{
			id: "email",
			label: "Email Address",
			type: "email",
			placeholder: "user@example.com",
			helpText: "Email associated with your Atlassian account",
			configKey: "email",
			envVar: "CONFLUENCE_EMAIL",
			required: true,
		},
		{
			id: "apiToken",
			label: "API Token",
			type: "password",
			placeholder: "Your API token",
			helpText: "Create an API token in your Atlassian account settings",
			helpLink: {
				text: "Create API token",
				url: "https://id.atlassian.com/manage-profile/security/api-tokens",
			},
			configKey: "apiToken",
			envVar: "CONFLUENCE_API_TOKEN",
			required: true,
		},
	],

	testConfig: {
		getTestFunction: async () => {
			return async (credentials: Record<string, string>) => {
				const {
					CONFLUENCE_DOMAIN,
					CONFLUENCE_EMAIL,
					CONFLUENCE_API_TOKEN,
				} = credentials;

				if (
					!CONFLUENCE_DOMAIN ||
					!CONFLUENCE_EMAIL ||
					!CONFLUENCE_API_TOKEN
				) {
					return {
						success: false,
						error: "All Confluence credentials are required",
					};
				}

				try {
					const domain = CONFLUENCE_DOMAIN.replace(
						/^https?:\/\//,
						"",
					).replace(/\/$/, "");
					const auth = Buffer.from(
						`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`,
					).toString("base64");

					const response = await fetch(
						`https://${domain}/wiki/rest/api/user/current`,
						{
							headers: {
								Authorization: `Basic ${auth}`,
								Accept: "application/json",
							},
						},
					);

					if (response.ok) {
						const user = await response.json();
						return {
							success: true,
							message: `Connected as ${user.displayName || user.username}`,
						};
					}

					return {
						success: false,
						error: "Invalid credentials or insufficient permissions",
					};
				} catch {
					return {
						success: false,
						error: "Failed to connect to Confluence API",
					};
				}
			};
		},
	},

	actions: [
		{
			slug: "search-content",
			label: "Search Confluence",
			description: "Search for pages and content in Confluence",
			category: "Knowledge",
			outputFields: [
				{ field: "results", description: "Array of matching content" },
				{ field: "totalSize", description: "Total number of results" },
			],
			configFields: [
				{
					key: "cql",
					label: "Search Query (CQL)",
					type: "template-input",
					required: true,
					placeholder: "text ~ 'search term' or {{NodeName.query}}",
					description: "Confluence Query Language expression",
				},
				{
					key: "spaceKey",
					label: "Space Key (optional)",
					type: "text",
					placeholder: "ENGINEERING",
					description: "Limit search to specific space",
				},
			],
		},
		{
			slug: "get-page",
			label: "Get Page Content",
			description: "Retrieve content from a Confluence page",
			category: "Knowledge",
			outputFields: [
				{
					field: "content",
					description: "Page content (HTML or storage format)",
				},
				{ field: "title", description: "Page title" },
				{ field: "spaceKey", description: "Space key" },
				{ field: "version", description: "Page version" },
			],
			configFields: [
				{
					key: "pageId",
					label: "Page ID",
					type: "template-input",
					required: true,
					placeholder: "Page ID or {{NodeName.pageId}}",
				},
				{
					key: "expand",
					label: "Expand",
					type: "select",
					options: [
						{ value: "body.storage", label: "Storage format" },
						{ value: "body.view", label: "View format (HTML)" },
						{ value: "body.export_view", label: "Export format" },
					],
					defaultValue: "body.storage",
				},
			],
		},
		{
			slug: "list-pages",
			label: "List Space Pages",
			description: "List all pages in a Confluence space",
			category: "Knowledge",
			outputFields: [
				{ field: "results", description: "Array of pages" },
				{ field: "totalSize", description: "Total number of pages" },
			],
			configFields: [
				{
					key: "spaceKey",
					label: "Space Key",
					type: "template-input",
					required: true,
					placeholder: "ENGINEERING or {{NodeName.spaceKey}}",
				},
				{
					key: "limit",
					label: "Limit",
					type: "number",
					defaultValue: "25",
					min: 1,
				},
			],
		},
		{
			slug: "create-page",
			label: "Create Page",
			description: "Create a new page in Confluence",
			category: "Actions",
			outputFields: [
				{ field: "id", description: "Created page ID" },
				{ field: "title", description: "Page title" },
				{ field: "webLink", description: "Page URL" },
			],
			configFields: [
				{
					key: "spaceKey",
					label: "Space Key",
					type: "template-input",
					required: true,
					placeholder: "ENGINEERING",
				},
				{
					key: "title",
					label: "Page Title",
					type: "template-input",
					required: true,
					placeholder: "Page title or {{NodeName.title}}",
				},
				{
					key: "content",
					label: "Content (Storage Format)",
					type: "template-textarea",
					required: true,
					placeholder:
						"<p>Page content in Confluence storage format</p>",
					rows: 6,
				},
				{
					key: "parentId",
					label: "Parent Page ID (optional)",
					type: "text",
					placeholder: "Parent page ID for hierarchy",
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(confluencePlugin);
