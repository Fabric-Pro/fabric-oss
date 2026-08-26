/**
 * Firecrawl Integration Plugin
 * Web scraping and search capabilities
 *
 * Aligned with Vercel workflow-builder-template patterns
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { FirecrawlIcon } from "./icon";

const firecrawlPlugin: IntegrationPlugin = {
	type: "FIRECRAWL",
	category: "tool",
	label: "Firecrawl",
	description: "Scrape websites and search the web",
	icon: FirecrawlIcon,
	color: "text-orange-500",
	brandColor: "#FA5D19",

	formFields: [
		{
			id: "apiKey",
			label: "Firecrawl API Key",
			type: "password",
			placeholder: "Your Firecrawl API key",
			configKey: "apiKey",
			envVar: "FIRECRAWL_API_KEY",
			helpText: "Get your API key from Firecrawl",
			helpLink: {
				text: "firecrawl.dev",
				url: "https://firecrawl.dev",
			},
			required: true,
		},
	],

	testConfig: {
		getTestFunction: async () => {
			const { testFirecrawlConnection } = await import("./test");
			return testFirecrawlConnection;
		},
	},

	actions: [
		{
			slug: "scrape",
			label: "Scrape URL",
			description: "Scrape content from a URL",
			category: "Web",
			stepFunction: "executeFirecrawlScrapeStep",
			stepImportPath: "firecrawl-scrape",
			outputFields: [
				{
					field: "markdown",
					description: "Scraped content in Markdown",
				},
				{ field: "title", description: "Page title" },
				{ field: "url", description: "Resolved source URL" },
			],
			outputConfig: { type: "json", field: "markdown" },
			configFields: [
				{
					key: "url",
					label: "URL",
					type: "template-input",
					placeholder: "https://example.com",
					required: true,
					example: "https://example.com/page",
				},
				{
					key: "formats",
					label: "Output Formats",
					type: "select",
					defaultValue: "markdown",
					options: [
						{ value: "markdown", label: "Markdown" },
						{ value: "html", label: "HTML" },
						{ value: "links", label: "Links Only" },
						{ value: "screenshot", label: "Screenshot" },
					],
				},
			],
		},
		{
			slug: "search",
			label: "Search Web",
			description: "Search the web and get results",
			category: "Web",
			stepFunction: "executeFirecrawlSearchStep",
			stepImportPath: "firecrawl-search",
			outputFields: [
				{ field: "results", description: "Array of search results" },
				{ field: "count", description: "Number of results" },
			],
			outputConfig: { type: "json", field: "results" },
			configFields: [
				{
					key: "query",
					label: "Search Query",
					type: "template-input",
					placeholder: "Enter your search query",
					required: true,
					example: "latest AI news",
				},
				{
					key: "limit",
					label: "Max Results",
					type: "number",
					defaultValue: "5",
					min: 1,
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(firecrawlPlugin);
