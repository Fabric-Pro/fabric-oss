/**
 * Data Connection Provider Metadata
 *
 * Contains product-facing display metadata for each supported provider.
 * Capability and freshness policy fields come from the shared
 * `@repo/connectors/types` source of truth.
 */

import {
	type ConnectionMode,
	type ConnectorCapabilities,
	type DataConnectionProvider,
	getDataConnectionCapabilities,
} from "@repo/connectors/types";

export type {
	ConnectionMode,
	DataConnectionProvider,
} from "@repo/connectors/types";

export type DataConnectionStatus =
	| "PENDING"
	| "CONNECTED"
	| "SYNCING"
	| "ERROR"
	| "PAUSED"
	| "EXPIRED";

interface ProviderDisplayMetadata {
	id: DataConnectionProvider;
	name: string;
	description: string;
	category:
		| "cloud-storage"
		| "knowledge-docs"
		| "development"
		| "communication"
		| "data-warehouses"
		| "sales-revenue";
	dataTypes: string[];
	requiresOAuth: boolean;
	supportsOptionalOAuth?: boolean;
	docsUrl?: string;
	logoPath?: string;

	/** Search-first onboarding prompt shown during setup */
	searchFirstPrompt: string;
}

export type ProviderMetadata = ProviderDisplayMetadata &
	Pick<
		ConnectorCapabilities,
		| "actionDescription"
		| "actionable"
		| "defaultSyncCadenceHours"
		| "indexedContentDescription"
		| "mode"
		| "searchable"
		| "staleThresholdHours"
	> & {
		connectionMode: ConnectionMode;
		syncFrequency: string;
	};

const PROVIDER_DISPLAY_METADATA: Record<
	DataConnectionProvider,
	ProviderDisplayMetadata
> = {
	GOOGLE_DRIVE: {
		id: "GOOGLE_DRIVE",
		name: "Google Drive",
		description:
			"Sync documents, spreadsheets, and presentations from Google Drive",
		category: "cloud-storage",
		dataTypes: ["GDocs", "GSlides", "Sheets", "PDFs", "Word docs"],
		requiresOAuth: true,
		docsUrl: "https://developers.google.com/drive",
		searchFirstPrompt:
			"Connect so your agents can search your Google Drive documents",
	},
	S3: {
		id: "S3",
		name: "Amazon S3",
		description: "Sync text files and exported documents from an S3 bucket",
		category: "cloud-storage",
		dataTypes: ["Text files", "Markdown", "JSON", "PDF exports"],
		requiresOAuth: false,
		docsUrl: "https://docs.aws.amazon.com/AmazonS3/latest/API/Welcome.html",
		searchFirstPrompt:
			"Connect so your agents can search documents in your S3 bucket",
	},
	GOOGLE_STORAGE: {
		id: "GOOGLE_STORAGE",
		name: "Google Storage",
		description:
			"Sync text files and exported documents from a Google Cloud Storage bucket",
		category: "cloud-storage",
		dataTypes: ["Text files", "Markdown", "JSON", "PDF exports"],
		requiresOAuth: false,
		docsUrl: "https://cloud.google.com/storage/docs/apis",
		searchFirstPrompt:
			"Connect so your agents can search documents in your Google Storage bucket",
	},
	R2: {
		id: "R2",
		name: "Cloudflare R2",
		description:
			"Sync text files and exported documents from a Cloudflare R2 bucket",
		category: "cloud-storage",
		dataTypes: ["Text files", "Markdown", "JSON", "PDF exports"],
		requiresOAuth: false,
		docsUrl: "https://developers.cloudflare.com/r2/",
		searchFirstPrompt:
			"Connect so your agents can search documents in your R2 bucket",
	},
	DROPBOX: {
		id: "DROPBOX",
		name: "Dropbox",
		description:
			"Sync documents and text files from Dropbox for searchable knowledge",
		category: "cloud-storage",
		dataTypes: ["Docs", "Text files", "Markdown", "Paper docs"],
		requiresOAuth: false,
		supportsOptionalOAuth: true,
		docsUrl:
			"https://www.dropbox.com/developers/documentation/http/documentation",
		searchFirstPrompt:
			"Connect so your agents can search your Dropbox documents",
	},
	AIRTABLE: {
		id: "AIRTABLE",
		name: "Airtable",
		description: "Sync tables and records from your Airtable base",
		category: "knowledge-docs",
		dataTypes: ["Bases", "Tables", "Records"],
		requiresOAuth: false,
		supportsOptionalOAuth: true,
		docsUrl: "https://airtable.com/developers/web/api/introduction",
		searchFirstPrompt:
			"Connect so your agents can search your Airtable records",
	},
	CODA: {
		id: "CODA",
		name: "Coda",
		description: "Sync docs and pages from your Coda workspace",
		category: "knowledge-docs",
		dataTypes: ["Docs", "Pages"],
		requiresOAuth: false,
		docsUrl: "https://coda.io/developers/apis/v1",
		searchFirstPrompt: "Connect so your agents can search your Coda docs",
	},
	GITBOOK: {
		id: "GITBOOK",
		name: "GitBook",
		description: "Sync pages from a GitBook space",
		category: "knowledge-docs",
		dataTypes: ["Pages", "Docs"],
		requiresOAuth: false,
		docsUrl: "https://developer.gitbook.com",
		searchFirstPrompt:
			"Connect so your agents can search your GitBook space",
	},
	NOTION: {
		id: "NOTION",
		name: "Notion",
		description: "Sync pages from your Notion workspace",
		category: "knowledge-docs",
		dataTypes: ["Pages"],
		requiresOAuth: true,
		docsUrl: "https://developers.notion.com",
		searchFirstPrompt:
			"Connect so your agents can search your Notion pages",
	},
	CONFLUENCE: {
		id: "CONFLUENCE",
		name: "Confluence",
		description: "Sync wiki pages and spaces from Atlassian Confluence",
		category: "knowledge-docs",
		dataTypes: ["Pages", "Spaces"],
		requiresOAuth: false,
		docsUrl: "https://developer.atlassian.com/cloud/confluence",
		searchFirstPrompt:
			"Connect so your agents can search your Confluence wiki",
	},
	TEAMS: {
		id: "TEAMS",
		name: "Teams",
		description: "Sync team channel conversations from Microsoft Teams",
		category: "communication",
		dataTypes: ["Teams", "Channels", "Messages"],
		requiresOAuth: true,
		docsUrl:
			"https://learn.microsoft.com/en-us/graph/teams-concept-overview",
		searchFirstPrompt:
			"Connect so your agents can search your Microsoft Teams channels",
	},
	INTERCOM: {
		id: "INTERCOM",
		name: "Intercom",
		description:
			"Sync conversations and Help Center articles from Intercom",
		category: "communication",
		dataTypes: ["Conversations", "Help Center articles"],
		requiresOAuth: false,
		supportsOptionalOAuth: true,
		docsUrl: "https://developers.intercom.com",
		searchFirstPrompt:
			"Connect so your agents can search your Intercom help center",
	},
	GITHUB: {
		id: "GITHUB",
		name: "GitHub",
		description:
			"Sync issues, PRs, discussions, and code from GitHub repositories",
		category: "development",
		dataTypes: ["Issues", "Pull Requests", "Discussions", "Code"],
		requiresOAuth: true,
		docsUrl: "https://docs.github.com/en/rest",
		searchFirstPrompt:
			"Connect so your agents can search your code and issues",
	},
	GITLAB: {
		id: "GITLAB",
		name: "GitLab",
		description:
			"Sync issues, merge requests, and project metadata from GitLab",
		category: "development",
		dataTypes: ["Issues", "Merge Requests", "Projects"],
		requiresOAuth: false,
		supportsOptionalOAuth: true,
		docsUrl: "https://docs.gitlab.com/ee/api/",
		searchFirstPrompt:
			"Connect so your agents can search your GitLab projects and issues",
	},
	BITBUCKET: {
		id: "BITBUCKET",
		name: "Bitbucket",
		description:
			"Sync issues, pull requests, and repository metadata from Bitbucket",
		category: "development",
		dataTypes: ["Issues", "Pull Requests", "Repositories"],
		requiresOAuth: false,
		supportsOptionalOAuth: true,
		docsUrl: "https://developer.atlassian.com/cloud/bitbucket/rest/",
		searchFirstPrompt:
			"Connect so your agents can search your Bitbucket repositories and issues",
	},
	LINEAR: {
		id: "LINEAR",
		name: "Linear",
		description: "Sync issues and comments from your Linear workspace",
		category: "development",
		dataTypes: ["Issues", "Comments", "Projects"],
		requiresOAuth: false,
		supportsOptionalOAuth: true,
		docsUrl:
			"https://developers.linear.app/docs/graphql/working-with-the-graphql-api",
		searchFirstPrompt:
			"Connect so your agents can search your Linear issues",
	},
	ASANA: {
		id: "ASANA",
		name: "Asana",
		description: "Sync tasks and comments from your Asana workspace",
		category: "development",
		dataTypes: ["Tasks", "Comments", "Projects"],
		requiresOAuth: false,
		supportsOptionalOAuth: true,
		docsUrl: "https://developers.asana.com/reference/rest-api-reference",
		searchFirstPrompt: "Connect so your agents can search your Asana tasks",
	},
	CLICKUP: {
		id: "CLICKUP",
		name: "ClickUp",
		description: "Sync tasks and comments from your ClickUp workspace",
		category: "development",
		dataTypes: ["Tasks", "Comments", "Lists"],
		requiresOAuth: false,
		docsUrl: "https://developer.clickup.com/docs",
		searchFirstPrompt:
			"Connect so your agents can search your ClickUp tasks",
	},
	SLACK: {
		id: "SLACK",
		name: "Slack",
		description: "Sync public channel messages from your Slack workspace",
		category: "communication",
		dataTypes: ["Public channel messages"],
		requiresOAuth: true,
		docsUrl: "https://api.slack.com",
		searchFirstPrompt:
			"Connect so your agents can search your Slack messages",
	},
	SNOWFLAKE: {
		id: "SNOWFLAKE",
		name: "Snowflake",
		description:
			"Sync table snapshots from Snowflake for searchable analytics context",
		category: "data-warehouses",
		dataTypes: ["Tables", "Schemas", "Sample rows"],
		requiresOAuth: false,
		docsUrl: "https://docs.snowflake.com",
		searchFirstPrompt:
			"Connect so your agents can search indexed Snowflake table snapshots",
	},
	BIGQUERY: {
		id: "BIGQUERY",
		name: "BigQuery",
		description:
			"Sync table snapshots from BigQuery for searchable analytics context",
		category: "data-warehouses",
		dataTypes: ["Datasets", "Tables", "Sample rows"],
		requiresOAuth: false,
		docsUrl: "https://cloud.google.com/bigquery/docs",
		searchFirstPrompt:
			"Connect so your agents can search indexed BigQuery table snapshots",
	},
	ZENDESK: {
		id: "ZENDESK",
		name: "Zendesk",
		description: "Sync tickets and Help Center articles from Zendesk",
		category: "communication",
		dataTypes: ["Tickets", "Help Center articles"],
		requiresOAuth: false,
		docsUrl: "https://developer.zendesk.com",
		searchFirstPrompt:
			"Connect so your agents can search your Zendesk knowledge base",
	},
	JIRA: {
		id: "JIRA",
		name: "Jira",
		description: "Sync issues and comments from Jira projects",
		category: "development",
		dataTypes: ["Issues", "Comments", "Projects"],
		requiresOAuth: false,
		docsUrl: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/",
		searchFirstPrompt: "Connect so your agents can search your Jira issues",
	},
	GONG: {
		id: "GONG",
		name: "Gong",
		description: "Sync call transcripts and meeting recordings metadata",
		category: "sales-revenue",
		dataTypes: ["Call transcripts", "Meeting metadata"],
		requiresOAuth: false,
		docsUrl: "https://us-14321.api.gong.io/v2/api-docs",
		searchFirstPrompt:
			"Connect so your agents can search your call transcripts",
	},
	GMAIL: {
		id: "GMAIL",
		name: "Gmail",
		description:
			"Sync emails and threads from your Gmail / Google Workspace account",
		category: "communication",
		dataTypes: ["Emails", "Threads", "Attachments"],
		requiresOAuth: true,
		docsUrl: "https://developers.google.com/gmail/api",
		searchFirstPrompt:
			"Connect so your agents can search your email history",
	},
	MICROSOFT_365: {
		id: "MICROSOFT_365",
		name: "Microsoft 365",
		description:
			"Sync SharePoint docs and OneDrive files from Microsoft 365",
		category: "cloud-storage",
		dataTypes: ["SharePoint docs", "OneDrive files"],
		requiresOAuth: true,
		docsUrl: "https://learn.microsoft.com/en-us/graph/",
		searchFirstPrompt:
			"Connect so your agents can search your Microsoft 365 content",
	},
	SALESFORCE: {
		id: "SALESFORCE",
		name: "Salesforce",
		description:
			"Sync accounts, opportunities, contacts, and cases from Salesforce CRM",
		category: "sales-revenue",
		dataTypes: ["Accounts", "Opportunities", "Contacts", "Cases"],
		requiresOAuth: false,
		docsUrl: "https://developer.salesforce.com/docs/apis",
		searchFirstPrompt:
			"Connect so your agents can search your Salesforce data",
	},
	HUBSPOT: {
		id: "HUBSPOT",
		name: "HubSpot",
		description:
			"Sync contacts, companies, deals, and tickets from HubSpot",
		category: "sales-revenue",
		dataTypes: ["Contacts", "Companies", "Deals", "Tickets"],
		requiresOAuth: false,
		supportsOptionalOAuth: true,
		docsUrl: "https://developers.hubspot.com/docs/api/overview",
		searchFirstPrompt:
			"Connect so your agents can search your HubSpot CRM data",
	},
};

export const PROVIDER_CATEGORIES = [
	{
		id: "cloud-storage" as const,
		name: "Cloud Storage",
		description: "Sync files from cloud storage services",
		providers: [
			"GOOGLE_DRIVE",
			"S3",
			"GOOGLE_STORAGE",
			"R2",
			"DROPBOX",
			"MICROSOFT_365",
		] as DataConnectionProvider[],
	},
	{
		id: "knowledge-docs" as const,
		name: "Knowledge & Docs",
		description: "Sync from documentation and wiki platforms",
		providers: [
			"NOTION",
			"CONFLUENCE",
			"AIRTABLE",
			"CODA",
			"GITBOOK",
		] as DataConnectionProvider[],
	},
	{
		id: "development" as const,
		name: "Development",
		description: "Sync from code repositories and development tools",
		providers: [
			"GITHUB",
			"GITLAB",
			"BITBUCKET",
			"JIRA",
			"LINEAR",
			"ASANA",
			"CLICKUP",
		] as DataConnectionProvider[],
	},
	{
		id: "communication" as const,
		name: "Communication",
		description: "Sync from communication and support platforms",
		providers: [
			"SLACK",
			"TEAMS",
			"GMAIL",
			"INTERCOM",
			"ZENDESK",
		] as DataConnectionProvider[],
	},
	{
		id: "data-warehouses" as const,
		name: "Data Warehouses",
		description: "Connect to data warehouses for analytics",
		providers: ["SNOWFLAKE", "BIGQUERY"] as DataConnectionProvider[],
	},
	{
		id: "sales-revenue" as const,
		name: "Sales & Revenue",
		description: "Sync from sales and revenue intelligence platforms",
		providers: [
			"GONG",
			"SALESFORCE",
			"HUBSPOT",
		] as DataConnectionProvider[],
	},
];

export function getProviderMetadata(
	provider: DataConnectionProvider,
): ProviderMetadata {
	const display = PROVIDER_DISPLAY_METADATA[provider];
	const capabilities = getDataConnectionCapabilities(provider);

	return {
		...display,
		...capabilities,
		connectionMode: capabilities.mode,
		syncFrequency:
			capabilities.defaultSyncCadenceHours >= 24 &&
			capabilities.defaultSyncCadenceHours % 24 === 0
				? capabilities.defaultSyncCadenceHours === 24
					? "Daily"
					: `Every ${capabilities.defaultSyncCadenceHours / 24} days`
				: capabilities.defaultSyncCadenceHours === 1
					? "Every hour"
					: `Every ${capabilities.defaultSyncCadenceHours} hours`,
	};
}

export const STATUS_CONFIG: Record<
	DataConnectionStatus,
	{ label: string; color: string; bgColor: string }
> = {
	PENDING: {
		label: "Pending",
		color: "text-highlight",
		bgColor: "bg-highlight/10",
	},
	CONNECTED: {
		label: "Connected",
		color: "text-success",
		bgColor: "bg-success/10",
	},
	SYNCING: {
		label: "Syncing",
		color: "text-primary",
		bgColor: "bg-primary/10",
	},
	ERROR: {
		label: "Error",
		color: "text-destructive",
		bgColor: "bg-destructive/10",
	},
	PAUSED: {
		label: "Paused",
		color: "text-muted-foreground",
		bgColor: "bg-muted",
	},
	EXPIRED: {
		label: "Expired",
		color: "text-highlight",
		bgColor: "bg-highlight/10",
	},
};

// =============================================================================
// Connection Mode Display
// =============================================================================

export const CONNECTION_MODE_CONFIG: Record<
	ConnectionMode,
	{ label: string; description: string; color: string; bgColor: string }
> = {
	knowledge: {
		label: "Knowledge",
		description: "Synced & searchable — agents can search this content",
		color: "text-success",
		bgColor: "bg-success/10",
	},
	action: {
		label: "Action",
		description: "Live tool access — agents can call APIs directly",
		color: "text-highlight",
		bgColor: "bg-highlight/10",
	},
	hybrid: {
		label: "Hybrid",
		description:
			"Synced knowledge + live actions — agents can search and act",
		color: "text-primary",
		bgColor: "bg-primary/10",
	},
};

// =============================================================================
// Freshness Helpers
// =============================================================================

/** Check if a connection's data is stale based on provider freshness policy. */
export function isConnectionStale(
	lastSyncAt: Date | string | null | undefined,
	provider: DataConnectionProvider,
): boolean {
	if (!lastSyncAt) {
		return true;
	}
	const metadata = getProviderMetadata(provider);
	if (!metadata) {
		return false;
	}
	const staleAfterMs = metadata.staleThresholdHours * 60 * 60 * 1000;
	return Date.now() - new Date(lastSyncAt).getTime() > staleAfterMs;
}
