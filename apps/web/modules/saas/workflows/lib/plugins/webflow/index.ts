/**
 * Webflow Integration Plugin
 *
 * Ported from vercel-labs/workflow-builder-template, adapted to fabric's
 * plugin contract.
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { WebflowIcon } from "./icon";

const webflowPlugin: IntegrationPlugin = {
	type: "WEBFLOW",
	category: "tool",
	label: "Webflow",
	description: "Manage and publish Webflow sites",
	icon: WebflowIcon,
	color: "text-blue-500",
	brandColor: "#146EF5",

	formFields: [
		{
			id: "apiKey",
			label: "API Token",
			type: "password",
			placeholder: "Your Webflow site or workspace token",
			configKey: "apiKey",
			envVar: "WEBFLOW_API_KEY",
			helpText:
				"Create a token in Webflow → Site settings → Apps & integrations",
			required: true,
		},
	],

	testConfig: {
		getTestFunction: async () => {
			const { testWebflowConnection } = await import("./test");
			return testWebflowConnection;
		},
	},

	actions: [
		{
			slug: "list-sites",
			label: "List Webflow Sites",
			description: "List the sites this token can access",
			category: "Design",
			stepFunction: "executeWebflowListSitesStep",
			stepImportPath: "webflow-list-sites",
			outputFields: [
				{ field: "sites", description: "Array of sites" },
				{ field: "count", description: "Number of sites" },
			],
			outputConfig: { type: "json", field: "sites" },
			configFields: [],
		},
		{
			slug: "get-site",
			label: "Get Webflow Site",
			description: "Fetch a single site's details",
			category: "Design",
			stepFunction: "executeWebflowGetSiteStep",
			stepImportPath: "webflow-get-site",
			outputFields: [
				{ field: "id", description: "Site ID" },
				{ field: "displayName", description: "Site name" },
				{ field: "shortName", description: "Site short name" },
				{ field: "previewUrl", description: "Preview URL" },
				{ field: "lastPublished", description: "Last published at" },
				{ field: "customDomains", description: "Custom domains" },
			],
			configFields: [
				{
					key: "siteId",
					label: "Site ID",
					type: "template-input",
					placeholder: "Site ID or {{NodeName.id}}",
					required: true,
				},
			],
		},
		{
			slug: "publish-site",
			label: "Publish Webflow Site",
			description: "Publish a site to its domains",
			category: "Design",
			stepFunction: "executeWebflowPublishSiteStep",
			stepImportPath: "webflow-publish-site",
			outputFields: [
				{
					field: "publishedDomains",
					description: "Domains published to",
				},
				{
					field: "publishedToSubdomain",
					description: "Whether the Webflow subdomain was published",
				},
			],
			configFields: [
				{
					key: "siteId",
					label: "Site ID",
					type: "template-input",
					placeholder: "Site ID or {{NodeName.id}}",
					required: true,
				},
				{
					key: "publishToWebflowSubdomain",
					label: "Publish to Webflow Subdomain",
					type: "select",
					defaultValue: "true",
					options: [
						{ value: "true", label: "Yes" },
						{ value: "false", label: "No" },
					],
				},
				{
					key: "customDomainIds",
					label: "Custom Domain IDs (comma-separated)",
					type: "template-input",
					placeholder: "domain-id-1, domain-id-2",
				},
			],
		},
	],
};

registerIntegration(webflowPlugin);
