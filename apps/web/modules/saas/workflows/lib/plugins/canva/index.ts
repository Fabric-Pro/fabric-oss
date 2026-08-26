/**
 * Canva Integration Plugin
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { CanvaIcon } from "./icon";

const canvaPlugin: IntegrationPlugin = {
	type: "CANVA",
	category: "tool",
	label: "Canva",
	description: "Connect with Canva to manage and create designs",
	icon: CanvaIcon,
	color: "text-teal-500",
	brandColor: "#00C4CC",

	formFields: [
		{
			id: "apiKey",
			label: "API Token",
			type: "password",
			placeholder: "Your Canva API token",
			helpText: "Get your API token from Canva Developer Portal",
			helpLink: {
				text: "Canva Developer Portal",
				url: "https://www.canva.com/developers",
			},
			configKey: "apiKey",
			envVar: "CANVA_ACCESS_TOKEN",
			required: true,
		},
	],

	testConfig: {
		getTestFunction: async () => {
			const { testCanvaConnection } = await import("./test");
			return testCanvaConnection;
		},
	},

	actions: [
		{
			slug: "list-designs",
			label: "List Canva Designs",
			description: "List designs from your Canva account",
			category: "Design",
			stepFunction: "executeCanvaListDesignsStep",
			stepImportPath: "canva-list-designs",
			outputFields: [
				{ field: "designs", description: "Array of designs" },
				{ field: "count", description: "Number of designs" },
			],
			outputConfig: { type: "json", field: "designs" },
			configFields: [
				{
					key: "query",
					label: "Search Query (optional)",
					type: "template-input",
					placeholder: "Search designs by name",
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(canvaPlugin);
