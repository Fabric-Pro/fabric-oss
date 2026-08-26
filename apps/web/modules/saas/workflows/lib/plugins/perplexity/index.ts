/**
 * Perplexity Integration Plugin
 * AI-powered search and research
 *
 * Aligned with Vercel workflow-builder-template patterns
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { PerplexityIcon } from "./icon";

const perplexityPlugin: IntegrationPlugin = {
	type: "PERPLEXITY",
	category: "tool",
	label: "Perplexity",
	description: "AI-powered search and research",
	icon: PerplexityIcon,
	color: "text-teal-500",
	brandColor: "#20808D",

	formFields: [
		{
			id: "apiKey",
			label: "Perplexity API Key",
			type: "password",
			placeholder: "pplx-xxxxxxxxxxxx",
			configKey: "apiKey",
			envVar: "PERPLEXITY_API_KEY",
			helpText: "Get your API key from Perplexity",
			helpLink: {
				text: "perplexity.ai/settings/api",
				url: "https://www.perplexity.ai/settings/api",
			},
			required: true,
		},
	],

	testConfig: {
		getTestFunction: async () => {
			const { testPerplexityConnection } = await import("./test");
			return testPerplexityConnection;
		},
	},

	actions: [
		{
			slug: "search",
			label: "Search",
			description: "Search the web with AI-powered answers",
			category: "AI",
			stepFunction: "executePerplexitySearchStep",
			stepImportPath: "perplexity-search",
			outputFields: [
				{ field: "answer", description: "AI-generated answer" },
				{ field: "citations", description: "Source citations" },
			],
			outputConfig: { type: "json", field: "answer" },
			configFields: [
				{
					key: "query",
					label: "Query",
					type: "template-textarea",
					placeholder: "What would you like to search for?",
					rows: 3,
					required: true,
					example: "What are the latest developments in AI?",
				},
				{
					key: "model",
					label: "Model",
					type: "select",
					defaultValue: "llama-3.1-sonar-small-128k-online",
					options: [
						{
							value: "llama-3.1-sonar-small-128k-online",
							label: "Sonar Small (Online)",
						},
						{
							value: "llama-3.1-sonar-large-128k-online",
							label: "Sonar Large (Online)",
						},
						{
							value: "llama-3.1-sonar-huge-128k-online",
							label: "Sonar Huge (Online)",
						},
					],
				},
				{
					key: "searchRecency",
					label: "Search Recency",
					type: "select",
					options: [
						{ value: "", label: "Any time" },
						{ value: "day", label: "Past day" },
						{ value: "week", label: "Past week" },
						{ value: "month", label: "Past month" },
						{ value: "year", label: "Past year" },
					],
				},
				{
					// The step reads this; it was offered by the old
					// hand-written palette but never declared here.
					key: "systemPrompt",
					label: "System Prompt (Optional)",
					type: "textarea",
					placeholder: "Customize the research approach",
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(perplexityPlugin);
