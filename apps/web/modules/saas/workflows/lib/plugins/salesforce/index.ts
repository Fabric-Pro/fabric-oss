import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { SalesforceIcon } from "./icon";

const salesforcePlugin: IntegrationPlugin = {
	type: "SALESFORCE",
	category: "tool",
	label: "Salesforce",
	description: "Create leads and query CRM records in Salesforce",
	icon: SalesforceIcon,
	color: "text-sky-600",
	brandColor: "#00A1E0",
	formFields: [
		{
			id: "domain",
			label: "Salesforce Domain",
			type: "url",
			placeholder: "your-instance.my.salesforce.com",
			configKey: "domain",
			envVar: "SALESFORCE_DOMAIN",
			required: true,
		},
		{
			id: "username",
			label: "Salesforce Username",
			type: "text",
			placeholder: "user@example.com",
			configKey: "username",
			envVar: "SALESFORCE_USERNAME",
		},
		{
			id: "apiToken",
			label: "Salesforce Access Token",
			type: "password",
			placeholder: "00D...",
			configKey: "apiToken",
			envVar: "SALESFORCE_ACCESS_TOKEN",
			required: true,
		},
	],
	testConfig: {
		getTestFunction: async () => {
			const { testSalesforceConnection } = await import("./test");
			return testSalesforceConnection;
		},
	},
	actions: [
		{
			slug: "create-lead",
			label: "Create Salesforce Lead",
			description: "Create a lead in Salesforce",
			category: "CRM",
			stepFunction: "executeSalesforceCreateLeadStep",
			stepImportPath: "salesforce-create-lead",
			outputFields: [
				{ field: "leadId", description: "Created lead id" },
				{ field: "leadUrl", description: "Salesforce record URL" },
			],
			outputConfig: { type: "url", field: "leadUrl" },
			configFields: [
				{
					key: "lastName",
					label: "Last Name",
					type: "template-input",
					required: true,
					placeholder: "Reed",
				},
				{
					key: "company",
					label: "Company",
					type: "template-input",
					required: true,
					placeholder: "Tech Fabric",
				},
				{
					key: "firstName",
					label: "First Name",
					type: "template-input",
					placeholder: "Taylor",
				},
				{
					key: "email",
					label: "Email",
					type: "template-input",
					placeholder: "taylor@example.com",
				},
				{
					key: "phone",
					label: "Phone",
					type: "template-input",
					placeholder: "+1 555 123 4567",
				},
			],
		},
		{
			slug: "query-records",
			label: "Query Salesforce Records",
			description: "Run a SOQL query against Salesforce",
			category: "CRM",
			stepFunction: "executeSalesforceQueryRecordsStep",
			stepImportPath: "salesforce-query-records",
			outputFields: [
				{ field: "records", description: "Query result records" },
				{ field: "count", description: "Number of records returned" },
			],
			outputConfig: { type: "json", field: "records" },
			configFields: [
				{
					key: "query",
					label: "SOQL Query",
					type: "template-textarea",
					required: true,
					rows: 4,
					placeholder: "SELECT Id, Name FROM Account LIMIT 10",
				},
			],
		},
	],
};

registerIntegration(salesforcePlugin);
