import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { ZendeskIcon } from "./icon";

const zendeskPlugin: IntegrationPlugin = {
	type: "ZENDESK",
	category: "tool",
	label: "Zendesk",
	description: "Create and search Zendesk tickets live",
	icon: ZendeskIcon,
	color: "text-emerald-700",
	brandColor: "#03363D",
	formFields: [
		{
			id: "subdomain",
			label: "Zendesk Subdomain",
			type: "text",
			placeholder: "your-company",
			configKey: "subdomain",
			envVar: "ZENDESK_SUBDOMAIN",
			required: true,
		},
		{
			id: "email",
			label: "Zendesk Email",
			type: "email",
			placeholder: "agent@company.com",
			configKey: "email",
			envVar: "ZENDESK_EMAIL",
			required: true,
		},
		{
			id: "token",
			label: "Zendesk Token",
			type: "password",
			placeholder: "Zendesk API token",
			configKey: "token",
			envVar: "ZENDESK_TOKEN",
			required: true,
		},
	],
	testConfig: {
		getTestFunction: async () => {
			const { testZendeskConnection } = await import("./test");
			return testZendeskConnection;
		},
	},
	actions: [
		{
			slug: "create-ticket",
			label: "Create Zendesk Ticket",
			description: "Create a support ticket in Zendesk",
			category: "Support",
			stepFunction: "executeZendeskCreateTicketStep",
			stepImportPath: "zendesk-create-ticket",
			outputFields: [
				{ field: "ticketId", description: "Created ticket id" },
				{ field: "ticketUrl", description: "Ticket URL" },
			],
			outputConfig: { type: "url", field: "ticketUrl" },
			configFields: [
				{
					key: "subject",
					label: "Subject",
					type: "template-input",
					required: true,
					placeholder: "{{NodeName.title}}",
				},
				{
					key: "description",
					label: "Description",
					type: "template-textarea",
					rows: 4,
					placeholder: "Ticket details",
				},
				{
					key: "requesterEmail",
					label: "Requester Email",
					type: "template-input",
					placeholder: "customer@example.com",
				},
				{
					key: "priority",
					label: "Priority",
					type: "select",
					options: [
						{ value: "low", label: "Low" },
						{ value: "normal", label: "Normal" },
						{ value: "high", label: "High" },
						{ value: "urgent", label: "Urgent" },
					],
					defaultValue: "normal",
				},
			],
		},
		{
			slug: "search-tickets",
			label: "Search Zendesk Tickets",
			description: "Search Zendesk tickets live",
			category: "Support",
			stepFunction: "executeZendeskSearchTicketsStep",
			stepImportPath: "zendesk-search-tickets",
			outputFields: [
				{ field: "tickets", description: "Matching tickets" },
				{ field: "count", description: "Number of tickets returned" },
			],
			outputConfig: { type: "json", field: "tickets" },
			configFields: [
				{
					key: "query",
					label: "Search Query",
					type: "template-input",
					required: true,
					placeholder: "status:open printer problem",
				},
			],
		},
	],
};

registerIntegration(zendeskPlugin);
