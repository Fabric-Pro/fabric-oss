/**
 * Resend Integration Plugin
 * Aligned with Vercel workflow-builder-template patterns
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { ResendIcon } from "./icon";

export const resendPlugin: IntegrationPlugin = {
	type: "RESEND",
	category: "tool",
	label: "Resend",
	description: "Send transactional emails",
	icon: ResendIcon,
	color: "text-blue-500",
	brandColor: "#000000",

	formFields: [
		{
			id: "apiKey",
			label: "API Key",
			type: "password",
			placeholder: "re_...",
			helpText: "Get your API key from Resend Dashboard",
			configKey: "apiKey",
			envVar: "RESEND_API_KEY",
			required: true,
		},
		{
			id: "fromEmail",
			label: "From Email",
			type: "email",
			placeholder: "noreply@yourdomain.com",
			helpText:
				"The email address to send from (must be verified in Resend)",
			configKey: "fromEmail",
			envVar: "RESEND_FROM_EMAIL",
			required: true,
		},
	],

	testConfig: {
		getTestFunction: async () => {
			const { testResendConnection } = await import("./test");
			return testResendConnection;
		},
	},

	actions: [
		{
			slug: "send-email",
			// Pinned: predates the <type>-<slug> convention. Renaming it
			// would orphan every saved workflow using this node.
			nodeType: "email-send",
			label: "Send Email",
			description: "Send an email using Resend",
			category: "Communication",
			stepFunction: "executeEmailSendStep",
			stepImportPath: "email-send",
			outputFields: [{ field: "id", description: "Email ID" }],
			configFields: [
				{
					key: "to",
					label: "To (Email Address)",
					type: "template-input",
					required: true,
					placeholder: "user@example.com or {{NodeName.email}}",
				},
				{
					key: "subject",
					label: "Subject",
					type: "template-input",
					required: true,
					placeholder: "Email subject or {{NodeName.title}}",
				},
				{
					key: "body",
					label: "Body",
					type: "template-textarea",
					required: true,
					placeholder: "Email content or {{NodeName.description}}",
					rows: 6,
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(resendPlugin);
