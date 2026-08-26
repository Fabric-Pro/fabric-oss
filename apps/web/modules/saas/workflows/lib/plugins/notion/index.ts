/**
 * Notion Integration Plugin
 * Provides document access and knowledge retrieval from Notion workspaces
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { NotionIcon } from "./icon";
import { NotionSettings } from "./NotionSettings";

const notionPlugin: IntegrationPlugin = {
	type: "NOTION",
	category: "knowledge",
	label: "Notion",
	description:
		"Connect pages, databases, and wikis from Notion as knowledge sources",
	icon: NotionIcon,
	color: "text-neutral-900 dark:text-neutral-100",
	brandColor: "#1a1a1a",

	formFields: [],
	SettingsComponent: NotionSettings,
	testConfig: {
		skipClientTest: true,
	},

	actions: [
		{
			slug: "search-pages",
			label: "Search Notion",
			description: "Search for pages and databases in Notion",
			category: "Knowledge",
			outputFields: [
				{
					field: "results",
					description: "Array of matching pages/databases",
				},
				{ field: "hasMore", description: "Whether more results exist" },
			],
			configFields: [
				{
					key: "query",
					label: "Search Query",
					type: "template-input",
					required: true,
					placeholder: "Search term or {{NodeName.query}}",
				},
				{
					key: "filter",
					label: "Filter Type",
					type: "select",
					options: [
						{ value: "all", label: "All" },
						{ value: "page", label: "Pages only" },
						{ value: "database", label: "Databases only" },
					],
					defaultValue: "all",
				},
			],
		},
		{
			slug: "get-page",
			label: "Get Page Content",
			description: "Retrieve content from a Notion page",
			category: "Knowledge",
			outputFields: [
				{ field: "content", description: "Page content as text" },
				{ field: "title", description: "Page title" },
				{ field: "properties", description: "Page properties" },
			],
			configFields: [
				{
					key: "pageId",
					label: "Page ID",
					type: "template-input",
					required: true,
					placeholder: "Page ID or {{NodeName.pageId}}",
				},
			],
		},
		{
			slug: "query-database",
			label: "Query Database",
			description: "Query a Notion database",
			category: "Knowledge",
			outputFields: [
				{ field: "results", description: "Array of database entries" },
				{ field: "hasMore", description: "Whether more results exist" },
			],
			configFields: [
				{
					key: "databaseId",
					label: "Database ID",
					type: "template-input",
					required: true,
					placeholder: "Database ID or {{NodeName.databaseId}}",
				},
				{
					key: "filterJson",
					label: "Filter (JSON)",
					type: "template-textarea",
					placeholder:
						'{"property": "Status", "select": {"equals": "Done"}}',
					description: "Optional Notion filter object in JSON format",
				},
			],
		},
		{
			slug: "create-page",
			label: "Create Page",
			description: "Create a new page in Notion",
			category: "Actions",
			outputFields: [
				{ field: "id", description: "Created page ID" },
				{ field: "url", description: "Page URL" },
			],
			configFields: [
				{
					key: "parentId",
					label: "Parent Page/Database ID",
					type: "template-input",
					required: true,
					placeholder: "Parent ID or {{NodeName.parentId}}",
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
					label: "Content",
					type: "template-textarea",
					placeholder: "Page content (Markdown supported)",
					rows: 4,
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(notionPlugin);
