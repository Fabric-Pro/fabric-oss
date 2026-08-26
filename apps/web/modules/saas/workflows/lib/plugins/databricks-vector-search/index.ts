/**
 * Databricks Vector Search Integration Plugin
 * Queries vector search indexes in a Databricks workspace as agent knowledge (RAG)
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { DatabricksVectorSearchIcon } from "./icon";

const databricksVectorSearchPlugin: IntegrationPlugin = {
	type: "DATABRICKS_VECTOR_SEARCH",
	category: "knowledge",
	label: "Databricks Vector Search",
	description:
		"Query vector search indexes in your Databricks workspace as agent knowledge (RAG)",
	icon: DatabricksVectorSearchIcon,
	color: "text-red-600",
	brandColor: "#FF3621",

	formFields: [
		{
			id: "host",
			label: "Workspace URL",
			type: "url",
			placeholder: "https://adb-1234567890123456.7.azuredatabricks.net",
			helpText: "Your Databricks workspace URL (https)",
			configKey: "host",
			envVar: "DATABRICKS_HOST",
			required: true,
		},
		{
			id: "clientId",
			label: "Service Principal Client ID",
			type: "text",
			placeholder: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			helpText:
				"OAuth M2M service principal with access to your vector search endpoints",
			helpLink: {
				text: "Create a service principal",
				url: "https://docs.databricks.com/en/dev-tools/auth/oauth-m2m.html",
			},
			configKey: "clientId",
			envVar: "DATABRICKS_CLIENT_ID",
			required: true,
		},
		{
			id: "clientSecret",
			label: "Service Principal Secret",
			type: "password",
			placeholder: "dose...",
			configKey: "clientSecret",
			envVar: "DATABRICKS_CLIENT_SECRET",
			required: true,
		},
	],

	// Connection test must run server-side (workspace CORS blocks the browser);
	// the settings page falls back to the testConnection procedure.
	testConfig: { skipClientTest: true },

	actions: [
		{
			slug: "query-index",
			label: "Query Vector Index",
			description:
				"Semantic + keyword (hybrid) search over a Databricks vector search index",
			category: "Knowledge",
			outputFields: [
				{ field: "chunks", description: "Matching chunks with scores" },
			],
			configFields: [
				{
					key: "query",
					label: "Query",
					type: "template-input",
					required: true,
					placeholder:
						"What does the onboarding flow do? or {{NodeName.query}}",
				},
				{
					key: "indexName",
					label: "Index name",
					type: "text",
					required: true,
					placeholder: "catalog.schema.index_name",
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(databricksVectorSearchPlugin);
