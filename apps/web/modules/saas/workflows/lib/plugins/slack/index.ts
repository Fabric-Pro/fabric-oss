/**
 * Slack Integration Plugin
 *
 * Uses OAuth 2.0 for authentication - credentials are managed server-side.
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { SlackIcon } from "./icon";
import { SlackSettings } from "./SlackSettings";

export const slackPlugin: IntegrationPlugin = {
	type: "SLACK",
	category: "both",
	label: "Slack",
	description: "Send messages to Slack channels",
	icon: SlackIcon,
	color: "text-purple-600",
	brandColor: "#4A154B",

	// OAuth-based integration - uses custom settings component instead of form fields
	formFields: [],

	// Custom settings component for OAuth flow
	SettingsComponent: SlackSettings,

	// OAuth integrations use server-side token validation
	testConfig: {
		skipClientTest: true,
	},

	actions: [
		{
			slug: "send-message",
			// Pinned: predates the <type>-<slug> convention. Renaming it
			// would orphan every saved workflow using this node.
			nodeType: "slack-send",
			label: "Send Slack Message",
			description: "Send a message to a Slack channel",
			category: "Communication",
			stepFunction: "executeSlackSendStep",
			stepImportPath: "slack-send",
			outputFields: [
				{ field: "ok", description: "Success status" },
				{ field: "ts", description: "Message timestamp" },
				{
					field: "timestamp",
					description: "Message timestamp (alias of ts)",
				},
				{ field: "channel", description: "Channel ID" },
			],
			configFields: [
				{
					key: "slackChannel",
					label: "Channel",
					type: "template-input",
					required: true,
					placeholder: "#general or {{NodeName.channel}}",
				},
				{
					key: "slackMessage",
					label: "Message",
					type: "template-textarea",
					required: true,
					placeholder: "Your message or {{NodeName.field}}",
					rows: 4,
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(slackPlugin);
