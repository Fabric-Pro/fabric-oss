/**
 * Google Drive Integration Plugin
 * Provides document access and knowledge retrieval from Google Drive
 *
 * Uses OAuth 2.0 for authentication - credentials are managed server-side.
 */

import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";
import { GoogleDriveSettings } from "./GoogleDriveSettings";
import { GoogleDriveIcon } from "./icon";

const googleDrivePlugin: IntegrationPlugin = {
	type: "GOOGLE_DRIVE",
	category: "knowledge",
	label: "Google Drive",
	description:
		"Connect documents and folders from Google Drive as knowledge sources",
	icon: GoogleDriveIcon,
	color: "text-yellow-600",
	brandColor: "#4285F4",

	// OAuth-based integration - uses custom settings component instead of form fields
	formFields: [],

	// Custom settings component for OAuth flow
	SettingsComponent: GoogleDriveSettings,

	// OAuth integrations use server-side token validation
	testConfig: {
		// Skip client-side test - OAuth status is checked via the settings component
		skipClientTest: true,
	},

	actions: [
		{
			slug: "list-files",
			label: "List Drive Files",
			description: "List files and folders from Google Drive",
			category: "Knowledge",
			outputFields: [
				{ field: "files", description: "Array of file objects" },
				{ field: "nextPageToken", description: "Token for pagination" },
			],
			configFields: [
				{
					key: "folderId",
					label: "Folder ID (optional)",
					type: "text",
					placeholder: "root or specific folder ID",
					description: "Leave empty for root folder",
				},
				{
					key: "mimeType",
					label: "File Type Filter",
					type: "select",
					options: [
						{ value: "all", label: "All files" },
						{
							value: "application/vnd.google-apps.document",
							label: "Google Docs",
						},
						{
							value: "application/vnd.google-apps.spreadsheet",
							label: "Google Sheets",
						},
						{ value: "application/pdf", label: "PDFs" },
					],
					defaultValue: "all",
				},
			],
		},
		{
			slug: "get-document",
			label: "Get Document Content",
			description: "Retrieve content from a Google Drive document",
			category: "Knowledge",
			outputFields: [
				{ field: "content", description: "Document content as text" },
				{ field: "title", description: "Document title" },
				{ field: "mimeType", description: "Document MIME type" },
			],
			configFields: [
				{
					key: "fileId",
					label: "File ID",
					type: "template-input",
					required: true,
					placeholder: "Document ID or {{NodeName.fileId}}",
				},
			],
		},
		{
			slug: "search-files",
			label: "Search Drive",
			description: "Search for files in Google Drive",
			category: "Knowledge",
			outputFields: [
				{ field: "files", description: "Array of matching files" },
				{ field: "totalCount", description: "Total matches found" },
			],
			configFields: [
				{
					key: "query",
					label: "Search Query",
					type: "template-input",
					required: true,
					placeholder: "Search term or {{NodeName.query}}",
				},
			],
		},
	],
};

// Auto-register the plugin
registerIntegration(googleDrivePlugin);
