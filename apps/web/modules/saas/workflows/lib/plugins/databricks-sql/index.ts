import { DatabricksVectorSearchIcon } from "../databricks-vector-search/icon";
import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { DatabricksAiConfig, DatabricksSqlConfig } from "./DatabricksSqlConfig";

const outputFields = [
	{ field: "statementId", description: "Databricks statement ID" },
	{ field: "workspaceUrl", description: "Databricks workspace" },
	{ field: "columns", description: "Result column names and types" },
	{ field: "rows", description: "Bounded result rows" },
	{ field: "truncated", description: "Whether the result limit was reached" },
];
const connectionFields = [
	{
		key: "integrationId",
		label: "Connection",
		type: "text" as const,
		required: true,
	},
	{
		key: "warehouseId",
		label: "SQL warehouse",
		type: "text" as const,
		required: true,
	},
];
const plugin: IntegrationPlugin = {
	type: "DATABRICKS_SQL",
	category: "tool",
	label: "Databricks SQL & AI",
	description:
		"Query Unity Catalog tables and run Databricks AI functions using your selected SQL connection",
	icon: DatabricksVectorSearchIcon,
	brandColor: "#FF3621",
	formFields: [
		{
			id: "host",
			label: "Workspace URL",
			type: "url",
			placeholder: "https://example.cloud.databricks.com",
			configKey: "host",
			envVar: "DATABRICKS_HOST",
			required: true,
		},
		{
			id: "clientId",
			label: "Service principal client ID",
			type: "text",
			configKey: "clientId",
			envVar: "DATABRICKS_CLIENT_ID",
			helpText:
				"Requires CAN USE on the selected warehouse and access to the tables or model endpoint you query.",
			required: true,
		},
		{
			id: "clientSecret",
			label: "Service principal secret",
			type: "password",
			configKey: "clientSecret",
			envVar: "DATABRICKS_CLIENT_SECRET",
			required: true,
		},
	],
	testConfig: { skipClientTest: true },
	actions: [
		{
			slug: "query",
			label: "Run Databricks SQL",
			description:
				"Read tables or execute parameterized SQL on an existing running warehouse",
			category: "Data",
			stepFunction: "executeDatabricksSqlStep",
			stepImportPath: "databricks-sql-query",
			configComponent: DatabricksSqlConfig,
			configFields: [
				...connectionFields,
				{
					key: "statement",
					label: "SQL statement",
					type: "textarea",
					required: true,
				},
				{
					key: "rowLimit",
					label: "Result row limit",
					type: "number",
					defaultValue: "100",
				},
			],
			outputFields,
		},
		{
			slug: "ai-query",
			label: "Databricks AI query",
			description:
				"Send one bounded request to an authorized model endpoint using ai_query",
			category: "AI",
			stepFunction: "executeDatabricksAiQueryStep",
			stepImportPath: "databricks-sql-ai-query",
			configComponent: DatabricksAiConfig,
			configFields: [
				...connectionFields,
				{
					key: "endpoint",
					label: "Model serving endpoint",
					type: "text",
					required: true,
				},
				{
					key: "request",
					label: "Request",
					type: "template-textarea",
					required: true,
				},
			],
			outputFields,
		},
	],
};
registerIntegration(plugin);
