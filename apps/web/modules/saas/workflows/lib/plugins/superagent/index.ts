/**
 * Superagent Integration Plugin — prompt-injection guarding and PII redaction.
 *
 * Ported from vercel-labs/workflow-builder-template.
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { SuperagentIcon } from "./icon";

const superagentPlugin: IntegrationPlugin = {
	type: "SUPERAGENT",
	category: "tool",
	label: "Superagent",
	description: "Guard text against prompt injection and redact PII",
	icon: SuperagentIcon,
	color: "text-sky-500",
	brandColor: "#0EA5E9",

	formFields: [
		{
			id: "apiKey",
			label: "API Key",
			type: "password",
			placeholder: "Your Superagent API key",
			configKey: "apiKey",
			envVar: "SUPERAGENT_API_KEY",
			helpText: "Get your API key from app.superagent.sh",
			helpLink: {
				text: "app.superagent.sh",
				url: "https://app.superagent.sh",
			},
			required: true,
		},
	],

	testConfig: {
		getTestFunction: async () => {
			const { testSuperagentConnection } = await import("./test");
			return testSuperagentConnection;
		},
	},

	actions: [
		{
			slug: "guard",
			label: "Guard Text",
			description:
				"Classify text for prompt injection and policy violations",
			category: "AI",
			stepFunction: "executeSuperagentGuardStep",
			stepImportPath: "superagent-guard",
			outputFields: [
				{
					field: "classification",
					description: "Overall classification",
				},
				{ field: "violationTypes", description: "Violation types" },
				{ field: "cweCodes", description: "Matching CWE codes" },
				{ field: "reasoning", description: "Model reasoning" },
			],
			configFields: [
				{
					key: "text",
					label: "Text",
					type: "template-textarea",
					placeholder: "Text to check, or {{NodeName.field}}",
					rows: 4,
					required: true,
				},
			],
		},
		{
			slug: "redact",
			label: "Redact Text",
			description: "Remove personal data from text",
			category: "AI",
			stepFunction: "executeSuperagentRedactStep",
			stepImportPath: "superagent-redact",
			outputFields: [
				{ field: "redactedText", description: "Redacted text" },
				{ field: "reasoning", description: "Model reasoning" },
			],
			outputConfig: { type: "json", field: "redactedText" },
			configFields: [
				{
					key: "text",
					label: "Text",
					type: "template-textarea",
					placeholder: "Text to redact, or {{NodeName.field}}",
					rows: 4,
					required: true,
				},
				{
					key: "entities",
					label: "Entity Types",
					type: "text",
					placeholder: "EMAIL, PHONE, SSN (comma-separated)",
				},
			],
		},
	],
};

registerIntegration(superagentPlugin);
