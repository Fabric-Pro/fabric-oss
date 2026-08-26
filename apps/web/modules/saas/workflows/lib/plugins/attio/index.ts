/**
 * Attio CRM Integration Plugin
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { AttioIcon } from "./icon";

const attioPlugin: IntegrationPlugin = {
	type: "ATTIO",
	category: "tool",
	label: "Attio",
	description: "Create and search records in Attio CRM",
	icon: AttioIcon,
	color: "text-purple-500",
	brandColor: "#7C3AED",

	formFields: [
		{
			id: "apiKey",
			label: "API Key",
			type: "password",
			placeholder: "Your Attio API key",
			helpText: "Get your API key from Attio Settings → API",
			helpLink: {
				text: "Attio API docs",
				url: "https://developers.attio.com/reference/get_v2-self",
			},
			configKey: "apiKey",
			envVar: "ATTIO_API_KEY",
			required: true,
		},
	],

	testConfig: {
		getTestFunction: async () => {
			const { testAttioConnection } = await import("./test");
			return testAttioConnection;
		},
	},

	actions: [
		{
			slug: "create-record",
			label: "Create Attio Record",
			description: "Create a new record in Attio (person, company, deal)",
			category: "CRM",
			stepFunction: "executeAttioCreateRecordStep",
			stepImportPath: "attio-create-record",
			outputFields: [
				{ field: "recordId", description: "Created record ID" },
			],
			outputConfig: { type: "json", field: "recordId" },
			configFields: [
				{
					key: "objectType",
					label: "Object Type",
					type: "select",
					required: true,
					options: [
						{ value: "people", label: "Person" },
						{ value: "companies", label: "Company" },
						{ value: "deals", label: "Deal" },
					],
				},
				{
					key: "attributes",
					label: "Attributes (JSON)",
					type: "template-textarea",
					placeholder:
						'{"name": "{{NodeName.name}}", "email_addresses": [{"email_address": "{{NodeName.email}}"}]}',
					rows: 4,
				},
			],
		},
		{
			slug: "search-records",
			label: "Search Attio Records",
			description: "Search for records in Attio CRM",
			category: "CRM",
			stepFunction: "executeAttioSearchRecordsStep",
			stepImportPath: "attio-search-records",
			outputFields: [
				{ field: "records", description: "Matching records" },
				{ field: "count", description: "Number found" },
			],
			outputConfig: { type: "json", field: "records" },
			configFields: [
				{
					key: "objectType",
					label: "Object Type",
					type: "select",
					required: true,
					options: [
						{ value: "people", label: "People" },
						{ value: "companies", label: "Companies" },
						{ value: "deals", label: "Deals" },
					],
				},
				{
					key: "query",
					label: "Search Query",
					type: "template-input",
					required: true,
					placeholder: "Search term or {{NodeName.name}}",
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(attioPlugin);
