/**
 * Vercel Blob Integration Plugin
 *
 * Ported from vercel-labs/workflow-builder-template.
 *
 * Note this overlaps fabric's own storage (`@repo/storage`, S3-backed): it is
 * here for workflows that need to read or write a customer's Vercel Blob
 * store, not as fabric's storage layer.
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { BlobIcon } from "./icon";

const blobPlugin: IntegrationPlugin = {
	type: "BLOB",
	category: "tool",
	label: "Vercel Blob",
	description: "Store and list files in Vercel Blob",
	icon: BlobIcon,
	color: "text-neutral-700",
	brandColor: "#000000",

	formFields: [
		{
			id: "apiKey",
			label: "Read/Write Token",
			type: "password",
			placeholder: "vercel_blob_rw_...",
			configKey: "apiKey",
			envVar: "BLOB_READ_WRITE_TOKEN",
			helpText:
				"Create a token in the Vercel dashboard under Storage → Blob",
			required: true,
		},
	],

	testConfig: {
		getTestFunction: async () => {
			const { testBlobConnection } = await import("./test");
			return testBlobConnection;
		},
	},

	actions: [
		{
			slug: "put",
			label: "Upload to Blob",
			description: "Write a file to Vercel Blob",
			category: "Data",
			stepFunction: "executeBlobPutStep",
			stepImportPath: "blob-put",
			outputFields: [
				{ field: "url", description: "Public URL" },
				{ field: "downloadUrl", description: "Download URL" },
				{ field: "pathname", description: "Stored path" },
			],
			outputConfig: { type: "url", field: "url" },
			configFields: [
				{
					key: "pathname",
					label: "Path",
					type: "template-input",
					placeholder: "reports/summary.txt",
					required: true,
				},
				{
					key: "body",
					label: "Content",
					type: "template-textarea",
					placeholder: "File contents, or {{NodeName.field}}",
					rows: 4,
					required: true,
				},
				{
					key: "contentType",
					label: "Content Type",
					type: "template-input",
					placeholder: "text/plain",
				},
				{
					key: "access",
					label: "Access",
					type: "select",
					defaultValue: "public",
					options: [{ value: "public", label: "Public" }],
				},
				{
					key: "addRandomSuffix",
					label: "Add Random Suffix",
					type: "select",
					defaultValue: "true",
					options: [
						{ value: "true", label: "Yes" },
						{ value: "false", label: "No (exact path)" },
					],
				},
			],
		},
		{
			slug: "list",
			label: "List Blobs",
			description: "List stored files",
			category: "Data",
			stepFunction: "executeBlobListStep",
			stepImportPath: "blob-list",
			outputFields: [
				{ field: "blobs", description: "Array of blobs" },
				{ field: "hasMore", description: "Whether more results exist" },
				{ field: "cursor", description: "Cursor for the next page" },
			],
			outputConfig: { type: "json", field: "blobs" },
			configFields: [
				{
					key: "prefix",
					label: "Prefix",
					type: "template-input",
					placeholder: "reports/",
				},
				{
					key: "limit",
					label: "Limit",
					type: "number",
					defaultValue: "100",
					min: 1,
				},
			],
		},
	],
};

registerIntegration(blobPlugin);
