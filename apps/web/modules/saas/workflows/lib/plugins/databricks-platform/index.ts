import { DatabricksVectorSearchIcon } from "../databricks-vector-search/icon";
import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";

const plugin: IntegrationPlugin = {
	type: "DATABRICKS_PLATFORM",
	category: "tool",
	label: "Databricks Platform",
	description:
		"Run approved context evaluations with Jobs, MLflow and Unity Catalog volumes using an organization service principal.",
	icon: DatabricksVectorSearchIcon,
	color: "text-primary",
	brandColor: "var(--primary)",
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
			required: true,
			helpText:
				"Use a principal dedicated to this organization and its approved evaluation resources.",
		},
		{
			id: "clientSecret",
			label: "OAuth machine secret",
			type: "password",
			configKey: "clientSecret",
			envVar: "DATABRICKS_CLIENT_SECRET",
			required: true,
		},
	],
	testConfig: { skipClientTest: true },
	actions: [],
};
registerIntegration(plugin);
