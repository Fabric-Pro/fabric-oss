/**
 * Microsoft Teams Integration Plugin
 * Provides access to Teams messages, channels, and shared files
 *
 * Uses OAuth 2.0 for authentication - credentials are managed server-side.
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { MicrosoftTeamsIcon } from "./icon";
import { MicrosoftTeamsSettings } from "./MicrosoftTeamsSettings";

const microsoftTeamsPlugin: IntegrationPlugin = {
	type: "MICROSOFT_GRAPH",
	category: "knowledge",
	label: "Microsoft Teams",
	description:
		"Access Microsoft Teams messages, channels, and shared files for AI-powered workflows",
	icon: MicrosoftTeamsIcon,
	color: "text-purple-600",
	brandColor: "#6264A7",

	// OAuth-based integration - uses custom settings component instead of form fields
	formFields: [],

	// Custom settings component for OAuth flow
	SettingsComponent: MicrosoftTeamsSettings,

	// OAuth integrations use server-side token validation
	testConfig: {
		// Skip client-side test - OAuth status is checked via the settings component
		skipClientTest: true,
	},

	actions: [
		{
			slug: "list-teams",
			label: "List Teams",
			description: "List all Teams the user has joined",
			category: "Communication",
			outputFields: [
				{ field: "teams", description: "Array of team objects" },
				{ field: "count", description: "Number of teams" },
			],
			configFields: [],
		},
		{
			slug: "list-channels",
			label: "List Channels",
			description: "List channels in a specific team",
			category: "Communication",
			outputFields: [
				{ field: "channels", description: "Array of channel objects" },
				{ field: "count", description: "Number of channels" },
			],
			configFields: [
				{
					key: "teamId",
					label: "Team ID",
					type: "template-input",
					required: true,
					placeholder: "Team ID or {{NodeName.teamId}}",
					description: "The ID of the team to list channels from",
				},
			],
		},
		{
			slug: "search-messages",
			label: "Search Messages",
			description:
				"Search for messages across all Teams channels and chats",
			category: "Communication",
			outputFields: [
				{
					field: "messages",
					description: "Array of matching messages",
				},
				{ field: "count", description: "Number of results" },
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
					key: "limit",
					label: "Maximum Results",
					type: "number",
					defaultValue: "20",
					description: "Maximum number of messages to return",
				},
			],
		},
		{
			slug: "list-messages",
			label: "List Channel Messages",
			description: "List recent messages in a channel",
			category: "Communication",
			outputFields: [
				{ field: "messages", description: "Array of message objects" },
				{ field: "count", description: "Number of messages" },
			],
			configFields: [
				{
					key: "teamId",
					label: "Team ID",
					type: "template-input",
					required: true,
					placeholder: "Team ID",
				},
				{
					key: "channelId",
					label: "Channel ID",
					type: "template-input",
					required: true,
					placeholder: "Channel ID or {{NodeName.channelId}}",
				},
				{
					key: "limit",
					label: "Maximum Messages",
					type: "number",
					defaultValue: "50",
					description: "Maximum number of messages to return",
				},
			],
		},
		{
			slug: "get-shared-files",
			label: "Get Shared Files",
			description: "Get files shared in a Teams channel",
			category: "Knowledge",
			outputFields: [
				{ field: "files", description: "Array of file objects" },
				{ field: "count", description: "Number of files" },
			],
			configFields: [
				{
					key: "teamId",
					label: "Team ID",
					type: "template-input",
					required: true,
					placeholder: "Team ID",
				},
				{
					key: "channelId",
					label: "Channel ID",
					type: "template-input",
					required: true,
					placeholder: "Channel ID",
				},
			],
		},
		{
			slug: "list-chats",
			label: "List Chats",
			description: "List direct and group chats for the user",
			category: "Communication",
			outputFields: [
				{ field: "chats", description: "Array of chat objects" },
				{ field: "count", description: "Number of chats" },
			],
			configFields: [
				{
					key: "limit",
					label: "Maximum Chats",
					type: "number",
					defaultValue: "50",
					description: "Maximum number of chats to return",
				},
			],
		},
		{
			slug: "get-chat-messages",
			label: "Get Chat Messages",
			description: "Get messages from a direct or group chat",
			category: "Communication",
			outputFields: [
				{ field: "messages", description: "Array of message objects" },
				{ field: "count", description: "Number of messages" },
			],
			configFields: [
				{
					key: "chatId",
					label: "Chat ID",
					type: "template-input",
					required: true,
					placeholder: "Chat ID or {{NodeName.chatId}}",
				},
				{
					key: "limit",
					label: "Maximum Messages",
					type: "number",
					defaultValue: "50",
					description: "Maximum number of messages to return",
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(microsoftTeamsPlugin);
