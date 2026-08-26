import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { HubSpotSettings } from "./HubSpotSettings";
import { HubSpotIcon } from "./icon";

const hubspotPlugin: IntegrationPlugin = {
	type: "HUBSPOT",
	category: "tool",
	label: "HubSpot",
	description: "Create and search HubSpot contacts live",
	icon: HubSpotIcon,
	color: "text-orange-500",
	brandColor: "#FF7A59",
	SettingsComponent: HubSpotSettings,
	formFields: [
		{
			id: "apiKey",
			label: "HubSpot Access Token",
			type: "password",
			placeholder: "pat-na1-...",
			configKey: "apiKey",
			envVar: "HUBSPOT_ACCESS_TOKEN",
			required: true,
		},
	],
	testConfig: {
		getTestFunction: async () => {
			const { testHubSpotConnection } = await import("./test");
			return testHubSpotConnection;
		},
	},
	actions: [
		{
			slug: "create-contact",
			label: "Create HubSpot Contact",
			description: "Create a contact record in HubSpot",
			category: "CRM",
			stepFunction: "executeHubSpotCreateContactStep",
			stepImportPath: "hubspot-create-contact",
			outputFields: [
				{ field: "contactId", description: "Created contact id" },
				{ field: "contactUrl", description: "HubSpot contact URL" },
			],
			outputConfig: { type: "url", field: "contactUrl" },
			configFields: [
				{
					key: "email",
					label: "Email",
					type: "template-input",
					required: true,
					placeholder: "customer@example.com",
				},
				{
					key: "firstname",
					label: "First Name",
					type: "template-input",
					placeholder: "Taylor",
				},
				{
					key: "lastname",
					label: "Last Name",
					type: "template-input",
					placeholder: "Reed",
				},
				{
					key: "phone",
					label: "Phone",
					type: "template-input",
					placeholder: "+1 555 123 4567",
				},
				{
					key: "company",
					label: "Company",
					type: "template-input",
					placeholder: "Tech Fabric",
				},
			],
		},
		{
			slug: "search-contacts",
			label: "Search HubSpot Contacts",
			description: "Search HubSpot contacts live",
			category: "CRM",
			stepFunction: "executeHubSpotSearchContactsStep",
			stepImportPath: "hubspot-search-contacts",
			outputFields: [
				{ field: "contacts", description: "Matching contacts" },
				{ field: "count", description: "Number of contacts returned" },
			],
			outputConfig: { type: "json", field: "contacts" },
			configFields: [
				{
					key: "query",
					label: "Search Query",
					type: "template-input",
					required: true,
					placeholder: "customer@example.com",
				},
			],
		},
	],
};

registerIntegration(hubspotPlugin);
