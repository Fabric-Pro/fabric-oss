/**
 * Stripe Integration Plugin
 *
 * Ported from vercel-labs/workflow-builder-template, adapted to fabric's
 * plugin contract: node types are pinned by convention (`<type>-<slug>`),
 * step bindings name the real Temporal exports, and credentials come from
 * `fetchCredentialsByProvider` rather than the template's per-project
 * credential fetcher.
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { StripeIcon } from "./icon";

const stripePlugin: IntegrationPlugin = {
	type: "STRIPE",
	category: "tool",
	label: "Stripe",
	description: "Payment processing and billing",
	icon: StripeIcon,
	color: "text-indigo-500",
	brandColor: "#635BFF",

	formFields: [
		{
			id: "apiKey",
			label: "Secret Key",
			type: "password",
			placeholder: "sk_live_... or sk_test_...",
			configKey: "apiKey",
			envVar: "STRIPE_SECRET_KEY",
			helpText: "Get your secret key from dashboard.stripe.com/apikeys",
			helpLink: {
				text: "dashboard.stripe.com/apikeys",
				url: "https://dashboard.stripe.com/apikeys",
			},
			required: true,
		},
	],

	testConfig: {
		getTestFunction: async () => {
			const { testStripeConnection } = await import("./test");
			return testStripeConnection;
		},
	},

	actions: [
		{
			slug: "create-customer",
			label: "Create Stripe Customer",
			description: "Create a new customer in Stripe",
			category: "Sales",
			stepFunction: "executeStripeCreateCustomerStep",
			stepImportPath: "stripe-create-customer",
			outputFields: [
				{ field: "id", description: "Customer ID" },
				{ field: "email", description: "Customer email" },
			],
			configFields: [
				{
					key: "email",
					label: "Email",
					type: "template-input",
					placeholder: "customer@example.com or {{NodeName.email}}",
					example: "customer@example.com",
					required: true,
				},
				{
					key: "name",
					label: "Name",
					type: "template-input",
					placeholder: "John Doe or {{NodeName.name}}",
					example: "John Doe",
				},
				{
					key: "phone",
					label: "Phone",
					type: "template-input",
					placeholder: "+1234567890",
				},
				{
					key: "description",
					label: "Description",
					type: "template-input",
					placeholder: "Internal notes about this customer",
				},
				{
					key: "metadata",
					label: "Metadata (JSON)",
					type: "template-textarea",
					placeholder: '{"key": "value"}',
					rows: 3,
				},
			],
		},
		{
			slug: "get-customer",
			label: "Get Stripe Customer",
			description: "Retrieve a customer by ID or email",
			category: "Sales",
			stepFunction: "executeStripeGetCustomerStep",
			stepImportPath: "stripe-get-customer",
			outputFields: [
				{ field: "id", description: "Customer ID" },
				{ field: "email", description: "Customer email" },
				{ field: "name", description: "Customer name" },
				{ field: "created", description: "Creation timestamp" },
			],
			outputConfig: { type: "json", field: "id" },
			configFields: [
				{
					key: "customerId",
					label: "Customer ID",
					type: "template-input",
					placeholder: "cus_... or {{NodeName.customerId}}",
				},
				{
					key: "email",
					label: "Email (alternative lookup)",
					type: "template-input",
					placeholder: "customer@example.com",
				},
			],
		},
		{
			slug: "create-invoice",
			label: "Create Stripe Invoice",
			description: "Create and optionally send an invoice",
			category: "Sales",
			stepFunction: "executeStripeCreateInvoiceStep",
			stepImportPath: "stripe-create-invoice",
			outputFields: [
				{ field: "id", description: "Invoice ID" },
				{ field: "number", description: "Invoice number" },
				{
					field: "hostedInvoiceUrl",
					description: "Hosted invoice URL",
				},
				{ field: "status", description: "Invoice status" },
			],
			outputConfig: { type: "url", field: "hostedInvoiceUrl" },
			configFields: [
				{
					key: "customerId",
					label: "Customer ID",
					type: "template-input",
					placeholder: "cus_... or {{NodeName.customerId}}",
					required: true,
				},
				{
					key: "description",
					label: "Description",
					type: "template-input",
					placeholder: "Invoice description",
				},
				{
					key: "lineItems",
					label: "Line Items (JSON array)",
					type: "template-textarea",
					placeholder:
						'[{"description": "Item", "amount": 1000, "quantity": 1}]',
					rows: 4,
					required: true,
				},
				{
					key: "daysUntilDue",
					label: "Days Until Due",
					type: "number",
					defaultValue: "30",
					min: 1,
				},
				{
					key: "autoAdvance",
					label: "Auto-finalize",
					type: "select",
					defaultValue: "true",
					options: [
						{ value: "true", label: "Yes" },
						{ value: "false", label: "No (draft)" },
					],
				},
				{
					key: "collectionMethod",
					label: "Collection Method",
					type: "select",
					defaultValue: "send_invoice",
					options: [
						{ value: "send_invoice", label: "Send Invoice" },
						{
							value: "charge_automatically",
							label: "Charge Automatically",
						},
					],
				},
			],
		},
	],
};

registerIntegration(stripePlugin);
