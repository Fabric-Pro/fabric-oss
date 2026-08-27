/**
 * Freshservice Integration Plugin
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { FreshserviceIcon } from "./icon";

const freshservicePlugin: IntegrationPlugin = {
	type: "FRESHSERVICE",
	category: "tool",
	label: "Freshservice",
	description: "Create and manage IT service tickets in Freshservice",
	icon: FreshserviceIcon,
	color: "text-green-500",
	brandColor: "#24AA4C",

	formFields: [
		{
			id: "apiKey",
			label: "API Key",
			type: "password",
			placeholder: "Your Freshservice API key",
			helpText:
				"Get your API key from Freshservice Admin → Profile Settings",
			helpLink: {
				text: "How to get API key",
				url: "https://support.freshservice.com/en/support/solutions/articles/50000000306-where-do-i-find-my-api-key-",
			},
			configKey: "apiKey",
			envVar: "FRESHSERVICE_API_KEY",
			required: true,
		},
		{
			id: "domain",
			label: "Domain",
			type: "text",
			placeholder: "yourcompany.freshservice.com",
			helpText:
				"Your Freshservice domain (e.g., yourcompany.freshservice.com)",
			configKey: "domain",
			envVar: "FRESHSERVICE_DOMAIN",
			required: true,
		},
	],

	testConfig: {
		getTestFunction: async () => {
			const { testFreshserviceConnection } = await import("./test");
			return testFreshserviceConnection;
		},
	},

	actions: [
		{
			slug: "create-ticket",
			label: "Create Freshservice Ticket",
			description: "Create a new IT service ticket in Freshservice",
			category: "Support",
			stepFunction: "executeFreshserviceCreateTicketStep",
			stepImportPath: "freshservice-create-ticket",
			outputFields: [
				{ field: "ticketId", description: "Ticket ID" },
				{ field: "ticketUrl", description: "URL to the ticket" },
			],
			outputConfig: { type: "url", field: "ticketUrl" },
			configFields: [
				{
					key: "subject",
					label: "Subject",
					type: "template-input",
					required: true,
					placeholder: "Issue summary or {{NodeName.title}}",
				},
				{
					key: "description",
					label: "Description",
					type: "template-textarea",
					placeholder:
						"Detailed description or {{NodeName.description}}",
					rows: 4,
				},
				{
					key: "priority",
					label: "Priority",
					type: "select",
					options: [
						{ value: "1", label: "Low" },
						{ value: "2", label: "Medium" },
						{ value: "3", label: "High" },
						{ value: "4", label: "Urgent" },
					],
					defaultValue: "2",
				},
				{
					key: "email",
					label: "Requester Email",
					type: "template-input",
					placeholder: "requester@example.com",
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(freshservicePlugin);
