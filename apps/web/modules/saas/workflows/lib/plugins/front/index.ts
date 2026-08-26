/**
 * Front Integration Plugin
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { FrontIcon } from "./icon";

const frontPlugin: IntegrationPlugin = {
	type: "FRONT",
	category: "tool",
	label: "Front",
	description: "Create and manage customer conversations in Front",
	icon: FrontIcon,
	color: "text-orange-500",
	brandColor: "#F25533",

	formFields: [
		{
			id: "apiKey",
			label: "API Token",
			type: "password",
			placeholder: "eyJ...",
			helpText:
				"Get your API token from Front Settings → Developers → API Tokens",
			helpLink: {
				text: "Front API docs",
				url: "https://dev.frontapp.com/docs/getting-started-with-the-api",
			},
			configKey: "apiKey",
			envVar: "FRONT_API_KEY",
			required: true,
		},
	],

	testConfig: {
		getTestFunction: async () => {
			const { testFrontConnection } = await import("./test");
			return testFrontConnection;
		},
	},

	actions: [
		{
			slug: "create-conversation",
			label: "Create Front Conversation",
			description: "Create a new email conversation in Front",
			category: "Support",
			stepFunction: "executeFrontCreateConversationStep",
			stepImportPath: "front-create-conversation",
			outputFields: [
				{ field: "conversationId", description: "Conversation ID" },
				{
					field: "conversationUrl",
					description: "URL to the conversation",
				},
			],
			outputConfig: { type: "url", field: "conversationUrl" },
			configFields: [
				{
					key: "subject",
					label: "Subject",
					type: "template-input",
					required: true,
					placeholder: "Support request or {{NodeName.subject}}",
				},
				{
					key: "body",
					label: "Message Body",
					type: "template-textarea",
					required: true,
					placeholder: "Message content or {{NodeName.body}}",
					rows: 5,
				},
				{
					key: "to",
					label: "To (comma-separated emails)",
					type: "template-input",
					required: true,
					placeholder: "customer@example.com",
				},
				{
					key: "channelId",
					label: "Channel ID (optional)",
					type: "template-input",
					placeholder: "cha_xxxxx",
				},
			],
		},
		{
			slug: "list-conversations",
			label: "List Front Conversations",
			description: "List conversations from a Front inbox",
			category: "Support",
			stepFunction: "executeFrontListConversationsStep",
			stepImportPath: "front-list-conversations",
			outputFields: [
				{
					field: "conversations",
					description: "Array of conversations",
				},
				{ field: "count", description: "Number of conversations" },
			],
			outputConfig: { type: "json", field: "conversations" },
			configFields: [
				{
					key: "inboxId",
					label: "Inbox ID (optional)",
					type: "template-input",
					placeholder: "inb_xxxxx",
				},
				{
					key: "status",
					label: "Status",
					type: "select",
					options: [
						{ value: "open", label: "Open" },
						{ value: "archived", label: "Archived" },
						{ value: "deleted", label: "Deleted" },
						{ value: "all", label: "All" },
					],
					defaultValue: "open",
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(frontPlugin);
