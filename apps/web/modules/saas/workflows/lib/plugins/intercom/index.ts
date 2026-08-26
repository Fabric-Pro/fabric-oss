import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { IntercomSettings } from "./IntercomSettings";
import { IntercomIcon } from "./icon";

const intercomPlugin: IntegrationPlugin = {
	type: "INTERCOM",
	category: "tool",
	label: "Intercom",
	description: "Create customers and search conversations in Intercom",
	icon: IntercomIcon,
	color: "text-sky-500",
	brandColor: "#1F8DED",
	SettingsComponent: IntercomSettings,
	formFields: [
		{
			id: "apiKey",
			label: "Intercom Access Token",
			type: "password",
			placeholder: "intercom_pat_...",
			configKey: "apiKey",
			envVar: "INTERCOM_ACCESS_TOKEN",
			required: true,
		},
	],
	testConfig: {
		getTestFunction: async () => {
			const { testIntercomConnection } = await import("./test");
			return testIntercomConnection;
		},
	},
	actions: [
		{
			slug: "create-contact",
			label: "Create Intercom Contact",
			description: "Create a contact record in Intercom",
			category: "Support",
			stepFunction: "executeIntercomCreateContactStep",
			stepImportPath: "intercom-create-contact",
			outputFields: [
				{
					field: "contactId",
					description: "Created Intercom contact id",
				},
			],
			outputConfig: { type: "json", field: "contact" },
			configFields: [
				{
					key: "email",
					label: "Email",
					type: "template-input",
					required: true,
					placeholder: "customer@example.com",
				},
				{
					key: "name",
					label: "Name",
					type: "template-input",
					placeholder: "Taylor Reed",
				},
				{
					key: "phone",
					label: "Phone",
					type: "template-input",
					placeholder: "+1 555 123 4567",
				},
			],
		},
		{
			slug: "search-conversations",
			label: "Search Intercom Conversations",
			description: "Search Intercom conversations live",
			category: "Support",
			stepFunction: "executeIntercomSearchConversationsStep",
			stepImportPath: "intercom-search-conversations",
			outputFields: [
				{
					field: "conversations",
					description: "Matching conversations",
				},
				{
					field: "count",
					description: "Number of conversations returned",
				},
			],
			outputConfig: { type: "json", field: "conversations" },
			configFields: [
				{
					key: "query",
					label: "Search Query",
					type: "template-input",
					required: true,
					placeholder: "refund request",
				},
			],
		},
	],
};

registerIntegration(intercomPlugin);
