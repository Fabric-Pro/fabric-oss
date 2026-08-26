/**
 * Clerk Integration Plugin — manage users in a Clerk instance.
 *
 * Ported from vercel-labs/workflow-builder-template. This is for acting on a
 * customer's own Clerk instance from a workflow; fabric's own authentication
 * is unrelated and unaffected.
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { ClerkIcon } from "./icon";

/** Shared by get/create/update — Clerk returns the same user shape. */
const USER_OUTPUT_FIELDS = [
	{ field: "id", description: "User ID" },
	{ field: "firstName", description: "First name" },
	{ field: "lastName", description: "Last name" },
	{
		field: "primaryEmailAddress",
		description: "Primary email address",
	},
];

const clerkPlugin: IntegrationPlugin = {
	type: "CLERK",
	category: "tool",
	label: "Clerk",
	description: "Manage users in a Clerk instance",
	icon: ClerkIcon,
	color: "text-violet-500",
	brandColor: "#6C47FF",

	formFields: [
		{
			id: "apiKey",
			label: "Secret Key",
			type: "password",
			placeholder: "sk_live_... or sk_test_...",
			configKey: "apiKey",
			envVar: "CLERK_SECRET_KEY",
			helpText: "Find it in the Clerk dashboard under API Keys",
			helpLink: {
				text: "dashboard.clerk.com",
				url: "https://dashboard.clerk.com",
			},
			required: true,
		},
	],

	testConfig: {
		getTestFunction: async () => {
			const { testClerkConnection } = await import("./test");
			return testClerkConnection;
		},
	},

	actions: [
		{
			slug: "get-user",
			label: "Get Clerk User",
			description: "Fetch a user by ID",
			category: "Developer",
			stepFunction: "executeClerkGetUserStep",
			stepImportPath: "clerk-get-user",
			outputFields: USER_OUTPUT_FIELDS,
			configFields: [
				{
					key: "userId",
					label: "User ID",
					type: "template-input",
					placeholder: "user_... or {{NodeName.id}}",
					required: true,
				},
			],
		},
		{
			slug: "create-user",
			label: "Create Clerk User",
			description: "Create a user in Clerk",
			category: "Developer",
			stepFunction: "executeClerkCreateUserStep",
			stepImportPath: "clerk-create-user",
			outputFields: USER_OUTPUT_FIELDS,
			configFields: [
				{
					key: "emailAddress",
					label: "Email Address",
					type: "template-input",
					placeholder: "user@example.com or {{NodeName.email}}",
					required: true,
				},
				{
					key: "firstName",
					label: "First Name",
					type: "template-input",
				},
				{ key: "lastName", label: "Last Name", type: "template-input" },
				{
					key: "password",
					label: "Password",
					type: "template-input",
					placeholder: "Leave blank to require a sign-up flow",
				},
				{
					key: "publicMetadata",
					label: "Public Metadata (JSON)",
					type: "template-textarea",
					placeholder: '{"plan": "pro"}',
					rows: 3,
				},
				{
					key: "privateMetadata",
					label: "Private Metadata (JSON)",
					type: "template-textarea",
					rows: 3,
				},
			],
		},
		{
			slug: "update-user",
			label: "Update Clerk User",
			description: "Update an existing user",
			category: "Developer",
			stepFunction: "executeClerkUpdateUserStep",
			stepImportPath: "clerk-update-user",
			outputFields: USER_OUTPUT_FIELDS,
			configFields: [
				{
					key: "userId",
					label: "User ID",
					type: "template-input",
					required: true,
				},
				{
					key: "firstName",
					label: "First Name",
					type: "template-input",
				},
				{ key: "lastName", label: "Last Name", type: "template-input" },
				{
					key: "publicMetadata",
					label: "Public Metadata (JSON)",
					type: "template-textarea",
					rows: 3,
				},
				{
					key: "privateMetadata",
					label: "Private Metadata (JSON)",
					type: "template-textarea",
					rows: 3,
				},
			],
		},
		{
			slug: "delete-user",
			label: "Delete Clerk User",
			description: "Permanently delete a user",
			category: "Developer",
			stepFunction: "executeClerkDeleteUserStep",
			stepImportPath: "clerk-delete-user",
			outputFields: [
				{
					field: "deleted",
					description: "Whether the user was deleted",
				},
			],
			configFields: [
				{
					key: "userId",
					label: "User ID",
					type: "template-input",
					required: true,
				},
			],
		},
	],
};

registerIntegration(clerkPlugin);
