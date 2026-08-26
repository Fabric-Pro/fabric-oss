/**
 * Connector Types
 *
 * Type definitions for the connector system that syncs external data sources
 * (Slack, Notion, GitHub, etc.) for agent knowledge access.
 */

// =============================================================================
// Connection Modes & Capabilities
// =============================================================================

/**
 * Connection mode taxonomy — every integration declares what it gives the user.
 *
 * - knowledge: Synced + searchable. Documents indexed into Qdrant for RAG.
 * - action:    Live tool access only. Agents call APIs, no indexed content.
 * - hybrid:    Both synced knowledge AND live tool access.
 */
export type ConnectionMode = "knowledge" | "action" | "hybrid";

/**
 * All product-facing data connection providers.
 * This superset includes both fully implemented connector backends and
 * providers that currently exist as connection product objects in the UI/API.
 */
export type DataConnectionProvider =
	| "GOOGLE_DRIVE"
	| "S3"
	| "GOOGLE_STORAGE"
	| "R2"
	| "DROPBOX"
	| "AIRTABLE"
	| "CODA"
	| "GITBOOK"
	| "NOTION"
	| "CONFLUENCE"
	| "TEAMS"
	| "INTERCOM"
	| "GITHUB"
	| "GITLAB"
	| "BITBUCKET"
	| "JIRA"
	| "LINEAR"
	| "ASANA"
	| "CLICKUP"
	| "SLACK"
	| "SNOWFLAKE"
	| "BIGQUERY"
	| "ZENDESK"
	| "GONG"
	// Phase 5 expansion
	| "GMAIL"
	| "MICROSOFT_365"
	| "SALESFORCE"
	| "HUBSPOT";

/**
 * Connector capabilities — declared per connector, drives UI and behavior.
 */
export interface ConnectorCapabilities {
	/** Whether this connector indexes documents for RAG search */
	searchable: boolean;

	/** Whether this connector provides live MCP/tool access */
	actionable: boolean;

	/** Derived connection mode */
	mode: ConnectionMode;

	/** Default sync cadence in hours (e.g. 4 = every 4 hours) */
	defaultSyncCadenceHours: number;

	/** Default incremental sync cadence in minutes */
	defaultIncrementalCadenceMinutes: number;

	/** How long before data is considered stale, in hours */
	staleThresholdHours: number;

	/** Human-readable description of what gets indexed */
	indexedContentDescription?: string;

	/** Human-readable description of available actions */
	actionDescription?: string;
}

/**
 * Default freshness policies per provider.
 * Configurable by admin per connection, these are sensible defaults.
 */
export const DATA_CONNECTION_CAPABILITIES: Record<
	DataConnectionProvider,
	ConnectorCapabilities
> = {
	SLACK: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 1,
		defaultIncrementalCadenceMinutes: 15,
		staleThresholdHours: 3,
		indexedContentDescription:
			"Channel messages, threads, and file metadata",
		actionDescription: "Send messages, search channels in real-time",
	},
	NOTION: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 4,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 12,
		indexedContentDescription: "Pages",
		actionDescription: "Create and update pages",
	},
	GITHUB: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 2,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 6,
		indexedContentDescription: "Issues, PRs, discussions, and code files",
		actionDescription: "Create issues, PRs, and search code via API",
	},
	GITLAB: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 2,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 6,
		indexedContentDescription:
			"Issues, merge requests, and project metadata",
		actionDescription:
			"Create issues and search project work live in GitLab",
	},
	BITBUCKET: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 2,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 6,
		indexedContentDescription:
			"Issues, pull requests, and repository metadata",
		actionDescription:
			"Create issues and search repository work live in Bitbucket",
	},
	JIRA: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 2,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 6,
		indexedContentDescription: "Issues, comments, and project metadata",
		actionDescription:
			"Create issues, add comments, and search tickets live",
	},
	LINEAR: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 2,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 6,
		indexedContentDescription: "Issues, comments, and project metadata",
		actionDescription: "Create and update issues",
	},
	ASANA: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 2,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 6,
		indexedContentDescription: "Tasks, comments, and project metadata",
		actionDescription: "Create and update tasks",
	},
	CLICKUP: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 2,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 6,
		indexedContentDescription: "Tasks, comments, and list metadata",
		actionDescription: "Create and update tasks",
	},
	GOOGLE_DRIVE: {
		searchable: true,
		actionable: false,
		mode: "knowledge",
		defaultSyncCadenceHours: 4,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 12,
		indexedContentDescription:
			"Documents, spreadsheets, presentations, and PDFs",
	},
	S3: {
		searchable: true,
		actionable: false,
		mode: "knowledge",
		defaultSyncCadenceHours: 4,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 12,
		indexedContentDescription:
			"Text files, markdown, JSON, and exported documents from an S3 bucket",
	},
	GOOGLE_STORAGE: {
		searchable: true,
		actionable: false,
		mode: "knowledge",
		defaultSyncCadenceHours: 4,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 12,
		indexedContentDescription:
			"Text files, markdown, JSON, and exported documents from a Google Cloud Storage bucket",
	},
	R2: {
		searchable: true,
		actionable: false,
		mode: "knowledge",
		defaultSyncCadenceHours: 4,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 12,
		indexedContentDescription:
			"Text files, markdown, JSON, and exported documents from a Cloudflare R2 bucket",
	},
	DROPBOX: {
		searchable: true,
		actionable: false,
		mode: "knowledge",
		defaultSyncCadenceHours: 4,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 12,
		indexedContentDescription:
			"Documents, text files, markdown, and exported paper docs",
	},
	AIRTABLE: {
		searchable: true,
		actionable: false,
		mode: "knowledge",
		defaultSyncCadenceHours: 4,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 12,
		indexedContentDescription:
			"Tables, records, and field values from your Airtable base",
	},
	CODA: {
		searchable: true,
		actionable: false,
		mode: "knowledge",
		defaultSyncCadenceHours: 4,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 12,
		indexedContentDescription: "Docs and pages from your Coda workspace",
	},
	GITBOOK: {
		searchable: true,
		actionable: false,
		mode: "knowledge",
		defaultSyncCadenceHours: 6,
		defaultIncrementalCadenceMinutes: 60,
		staleThresholdHours: 24,
		indexedContentDescription: "Pages and docs from a GitBook space",
	},
	CONFLUENCE: {
		searchable: true,
		actionable: false,
		mode: "knowledge",
		defaultSyncCadenceHours: 6,
		defaultIncrementalCadenceMinutes: 60,
		staleThresholdHours: 24,
		indexedContentDescription: "Wiki pages and spaces",
	},
	TEAMS: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 2,
		defaultIncrementalCadenceMinutes: 20,
		staleThresholdHours: 6,
		indexedContentDescription: "Team channels and conversation threads",
		actionDescription: "Access channels and post team updates",
	},
	INTERCOM: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 2,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 6,
		indexedContentDescription: "Conversations and Help Center articles",
		actionDescription:
			"Create customers and search conversations in Intercom live",
	},
	SNOWFLAKE: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 12,
		defaultIncrementalCadenceMinutes: 60,
		staleThresholdHours: 24,
		indexedContentDescription:
			"Table snapshots from configured Snowflake schemas",
		actionDescription: "Query tables, views, and run analytics",
	},
	BIGQUERY: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 12,
		defaultIncrementalCadenceMinutes: 60,
		staleThresholdHours: 24,
		indexedContentDescription:
			"Table snapshots from configured BigQuery datasets",
		actionDescription: "Query datasets, tables, and run analytics",
	},
	ZENDESK: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 2,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 6,
		indexedContentDescription: "Tickets and Help Center articles",
		actionDescription:
			"Create tickets, add comments, and search support cases live",
	},
	GONG: {
		searchable: true,
		actionable: false,
		mode: "knowledge",
		defaultSyncCadenceHours: 24,
		defaultIncrementalCadenceMinutes: 120,
		staleThresholdHours: 48,
		indexedContentDescription: "Call transcripts and meeting metadata",
	},
	GMAIL: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 1,
		defaultIncrementalCadenceMinutes: 15,
		staleThresholdHours: 3,
		indexedContentDescription: "Email messages and threads",
		actionDescription: "Send emails, search inbox",
	},
	MICROSOFT_365: {
		searchable: true,
		actionable: false,
		mode: "knowledge",
		defaultSyncCadenceHours: 4,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 12,
		indexedContentDescription: "SharePoint documents and OneDrive files",
	},
	SALESFORCE: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 4,
		defaultIncrementalCadenceMinutes: 60,
		staleThresholdHours: 12,
		indexedContentDescription:
			"Accounts, opportunities, contacts, and case records",
		actionDescription:
			"Create leads and query CRM records in Salesforce live",
	},
	HUBSPOT: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 4,
		defaultIncrementalCadenceMinutes: 60,
		staleThresholdHours: 12,
		indexedContentDescription:
			"Contacts, companies, deals, and ticket records",
		actionDescription: "Create and search CRM contacts in HubSpot live",
	},
};

export const DEFAULT_CONNECTOR_CAPABILITIES: Record<
	ConnectorProvider,
	ConnectorCapabilities
> = {
	SLACK: DATA_CONNECTION_CAPABILITIES.SLACK,
	NOTION: DATA_CONNECTION_CAPABILITIES.NOTION,
	GITHUB: DATA_CONNECTION_CAPABILITIES.GITHUB,
	GITLAB: DATA_CONNECTION_CAPABILITIES.GITLAB,
	BITBUCKET: DATA_CONNECTION_CAPABILITIES.BITBUCKET,
	GOOGLE_DRIVE: DATA_CONNECTION_CAPABILITIES.GOOGLE_DRIVE,
	S3: DATA_CONNECTION_CAPABILITIES.S3,
	GOOGLE_STORAGE: DATA_CONNECTION_CAPABILITIES.GOOGLE_STORAGE,
	R2: DATA_CONNECTION_CAPABILITIES.R2,
	DROPBOX: DATA_CONNECTION_CAPABILITIES.DROPBOX,
	AIRTABLE: DATA_CONNECTION_CAPABILITIES.AIRTABLE,
	CODA: DATA_CONNECTION_CAPABILITIES.CODA,
	GITBOOK: DATA_CONNECTION_CAPABILITIES.GITBOOK,
	CONFLUENCE: DATA_CONNECTION_CAPABILITIES.CONFLUENCE,
	TEAMS: DATA_CONNECTION_CAPABILITIES.TEAMS,
	CLICKUP: DATA_CONNECTION_CAPABILITIES.CLICKUP,
	LINEAR: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 2,
		defaultIncrementalCadenceMinutes: 15,
		staleThresholdHours: 6,
		indexedContentDescription: "Issues, projects, and comments",
		actionDescription: "Create and update issues",
	},
	JIRA: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 2,
		defaultIncrementalCadenceMinutes: 15,
		staleThresholdHours: 6,
		indexedContentDescription: "Tickets, projects, and comments",
		actionDescription: "Create and update tickets",
	},
	GMAIL: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 1,
		defaultIncrementalCadenceMinutes: 15,
		staleThresholdHours: 3,
		indexedContentDescription: "Email messages and threads",
		actionDescription: "Send emails, search inbox",
	},
	MICROSOFT_365: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 4,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 12,
		indexedContentDescription: "SharePoint documents and OneDrive files",
		actionDescription: "Access Microsoft 365 files",
	},
	SALESFORCE: {
		searchable: true,
		actionable: false,
		mode: "knowledge",
		defaultSyncCadenceHours: 4,
		defaultIncrementalCadenceMinutes: 60,
		staleThresholdHours: 12,
		indexedContentDescription:
			"Accounts, opportunities, contacts, and case records",
	},
	HUBSPOT: {
		searchable: true,
		actionable: false,
		mode: "knowledge",
		defaultSyncCadenceHours: 4,
		defaultIncrementalCadenceMinutes: 60,
		staleThresholdHours: 12,
		indexedContentDescription:
			"Contacts, companies, deals, and ticket records",
	},
	ASANA: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 2,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 6,
		indexedContentDescription: "Tasks, comments, and project metadata",
		actionDescription: "Create and update tasks",
	},
	ZENDESK: {
		searchable: true,
		actionable: true,
		mode: "hybrid",
		defaultSyncCadenceHours: 2,
		defaultIncrementalCadenceMinutes: 30,
		staleThresholdHours: 6,
		indexedContentDescription: "Tickets and Help Center articles",
		actionDescription:
			"Create tickets, add comments, and search support cases live",
	},
};

// =============================================================================
// Federated Search (Real-Time, No Indexing)
// =============================================================================

/**
 * A federated search result from a live external source.
 * Returned by connectors that support real-time search without pre-indexing.
 */
export interface FederatedSearchResult {
	/** Unique result identifier */
	id: string;
	/** Result title */
	title: string;
	/** Result content / snippet */
	content: string;
	/** Link to original in external system */
	url?: string;
	/** Source connector provider */
	provider: ConnectorProvider;
	/** Human-readable source name (e.g. "#engineering channel") */
	sourceName: string;
	/** When the content was created/updated in the external system */
	externalTimestamp?: Date;
	/** Author name */
	author?: string;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Options for federated search
 */
export interface FederatedSearchOptions {
	/** Search query */
	query: string;
	/** Max results to return (default: 10) */
	maxResults?: number;
	/** Connector configuration with credentials */
	config: ConnectorConfig;
}

/**
 * Interface for connectors that support live federated search.
 * Implemented alongside IConnector — a connector can be both
 * indexable AND federated (hybrid mode).
 */
export interface IFederatedConnector {
	provider: ConnectorProvider;

	/** Execute a real-time search against the external service */
	federatedSearch(
		options: FederatedSearchOptions,
	): Promise<FederatedSearchResult[]>;
}

// =============================================================================
// Connector Configuration
// =============================================================================

export type ConnectorProvider =
	| "SLACK"
	| "NOTION"
	| "GITHUB"
	| "GITLAB"
	| "BITBUCKET"
	| "GOOGLE_DRIVE"
	| "S3"
	| "GOOGLE_STORAGE"
	| "R2"
	| "DROPBOX"
	| "AIRTABLE"
	| "CODA"
	| "GITBOOK"
	| "CONFLUENCE"
	| "TEAMS"
	| "CLICKUP"
	| "LINEAR"
	| "JIRA"
	| "ASANA"
	// Phase 5 expansion — scaffolded, implementations pending
	| "GMAIL"
	| "MICROSOFT_365"
	| "SALESFORCE"
	| "HUBSPOT"
	| "ZENDESK";

export type ConnectorStatus =
	| "PENDING"
	| "CONNECTING"
	| "ACTIVE"
	| "SYNCING"
	| "ERROR"
	| "PAUSED"
	| "DISCONNECTED";

export type SyncState =
	| "IDLE"
	| "FULL_SYNC"
	| "INCREMENTAL_SYNC"
	| "GARBAGE_COLLECTION"
	| "ERROR";

export interface ConnectorConfig {
	id: string;
	provider: ConnectorProvider;
	name: string;
	description?: string;

	/** OAuth credentials */
	credentials: ConnectorCredentials;

	/** Provider-specific configuration */
	providerConfig: Record<string, unknown>;

	/** Sync settings */
	syncConfig: SyncConfig;

	/** Status */
	status: ConnectorStatus;
	lastSyncAt?: Date;
	lastError?: string;

	/** Ownership */
	userId: string;
	organizationId?: string;

	createdAt: Date;
	updatedAt: Date;
}

export interface ConnectorCredentials {
	accessToken?: string;
	/** User token for user-scoped APIs (e.g. Slack search.messages) */
	userAccessToken?: string;
	refreshToken?: string;
	expiresAt?: Date;
	apiKey?: string;
	webhookSecret?: string;
}

export interface SyncConfig {
	/** Enable automatic sync */
	autoSync: boolean;

	/** Full sync interval in hours */
	fullSyncIntervalHours: number;

	/** Incremental sync interval in minutes */
	incrementalSyncIntervalMinutes: number;

	/** Garbage collection interval in hours */
	gcIntervalHours: number;

	/** Filter configuration */
	filters?: SyncFilters;
}

export interface SyncFilters {
	/** Include only specific channels/spaces/repos */
	include?: string[];

	/** Exclude specific channels/spaces/repos */
	exclude?: string[];

	/** Only sync content newer than this date */
	sinceDate?: Date;

	/** Content type filters */
	contentTypes?: string[];
}

// =============================================================================
// Sync State & Progress
// =============================================================================

export interface SyncProgress {
	connectorId: string;
	state: SyncState;
	phase: string;
	progress: number; // 0-100
	itemsProcessed: number;
	totalItems: number;
	startedAt: Date;
	estimatedCompletionAt?: Date;
	error?: string;
}

export interface SyncResult {
	connectorId: string;
	syncType: "full" | "incremental" | "gc";
	success: boolean;
	itemsProcessed: number;
	itemsAdded: number;
	itemsUpdated: number;
	itemsDeleted: number;
	durationMs: number;
	error?: string;
	nextSyncAt?: Date;
}

export interface SyncCursor {
	connectorId: string;
	provider: ConnectorProvider;
	cursorType: "incremental" | "gc";
	cursor: string;
	lastSyncedAt: Date;
	metadata?: Record<string, unknown>;
}

// =============================================================================
// Connector Documents
// =============================================================================

export interface ConnectorDocument {
	id: string;
	connectorId: string;

	/** External reference */
	externalId: string;
	externalUrl?: string;

	/** Content */
	title: string;
	content: string;
	contentType: string;

	/** Metadata */
	metadata: ConnectorDocumentMetadata;

	/** Timestamps */
	externalCreatedAt?: Date;
	externalUpdatedAt?: Date;
	syncedAt: Date;

	/** Vector status */
	embeddingStatus: "pending" | "processing" | "completed" | "error";
	qdrantPointId?: string;
}

export interface ConnectorDocumentMetadata {
	provider: ConnectorProvider;
	source: string; // channel name, page path, repo name, etc.
	author?: string;
	tags?: string[];
	[key: string]: unknown;
}

// =============================================================================
// Connector Interface
// =============================================================================

export interface IConnector {
	provider: ConnectorProvider;

	/** Test connection and credentials */
	testConnection(config: ConnectorConfig): Promise<boolean>;

	/** Perform full sync */
	fullSync(
		config: ConnectorConfig,
		onProgress: (progress: SyncProgress) => void,
	): Promise<SyncResult>;

	/** Perform incremental sync from cursor */
	incrementalSync(
		config: ConnectorConfig,
		cursor: SyncCursor | null,
		onProgress: (progress: SyncProgress) => void,
	): Promise<{ result: SyncResult; newCursor: SyncCursor }>;

	/** Garbage collection - remove deleted items */
	garbageCollect(
		config: ConnectorConfig,
		onProgress: (progress: SyncProgress) => void,
	): Promise<SyncResult>;

	/** Handle webhook from provider */
	handleWebhook?(
		config: ConnectorConfig,
		payload: unknown,
	): Promise<ConnectorDocument[]>;

	/** Get OAuth URL for connection */
	getOAuthUrl?(redirectUri: string, state: string): string;

	/** Exchange OAuth code for tokens */
	exchangeOAuthCode?(
		code: string,
		redirectUri: string,
	): Promise<ConnectorCredentials>;

	/** Refresh OAuth token */
	refreshToken?(
		credentials: ConnectorCredentials,
	): Promise<ConnectorCredentials>;
}

// =============================================================================
// Provider-Specific Types
// =============================================================================

// Slack
export interface SlackConfig {
	teamId: string;
	teamName: string;
	channels?: string[];
	excludeChannels?: string[];
	includeThreads: boolean;
	includeFiles: boolean;
}

export interface SlackMessage {
	ts: string;
	channel: string;
	user: string;
	text: string;
	threadTs?: string;
	files?: Array<{ id: string; name: string; url: string }>;
}

// Notion
export interface NotionConfig {
	workspaceId: string;
	workspaceName: string;
	rootPages?: string[];
	excludePages?: string[];
	includeComments: boolean;
}

export interface NotionPage {
	id: string;
	title: string;
	url: string;
	parentId?: string;
	content: string;
	lastEditedTime: string;
}

// GitHub
export interface GitHubConfig {
	owner: string;
	repos?: string[];
	excludeRepos?: string[];
	includeIssues: boolean;
	includePullRequests: boolean;
	includeDiscussions: boolean;
	includeCode: boolean;
	codePatterns?: string[];
}

export interface GitHubDocument {
	type: "issue" | "pull_request" | "discussion" | "file";
	number?: number;
	path?: string;
	title: string;
	content: string;
	url: string;
	author: string;
	createdAt: string;
	updatedAt: string;
}

// =============================================================================
// Workflow Types
// =============================================================================

export interface ConnectorSyncWorkflowInput {
	connectorId: string;
	syncType: "full" | "incremental" | "gc";
	userId: string;
	organizationId?: string;
	force?: boolean;
}

export interface ConnectorSyncWorkflowOutput {
	connectorId: string;
	syncType: "full" | "incremental" | "gc";
	result: SyncResult;
	nextScheduledSync?: Date;
}

// =============================================================================
// Capability Helpers
// =============================================================================

/** Get capabilities for a connector provider, with optional overrides. */
export function getConnectorCapabilities(
	provider: ConnectorProvider,
	overrides?: Partial<ConnectorCapabilities>,
): ConnectorCapabilities {
	const defaults = DEFAULT_CONNECTOR_CAPABILITIES[provider];
	if (!overrides) {
		return defaults;
	}
	return { ...defaults, ...overrides };
}

export function getDataConnectionCapabilities(
	provider: DataConnectionProvider,
	overrides?: Partial<ConnectorCapabilities>,
): ConnectorCapabilities {
	const defaults = DATA_CONNECTION_CAPABILITIES[provider];
	return { ...defaults, ...overrides };
}

/** Check if a connection is stale based on last sync time and freshness policy. */
export function isConnectionStale(
	lastSyncAt: Date | null | undefined,
	provider: ConnectorProvider,
	customStaleThresholdHours?: number,
): boolean {
	if (!lastSyncAt) {
		return true;
	}
	const thresholdHours =
		customStaleThresholdHours ??
		DEFAULT_CONNECTOR_CAPABILITIES[provider].staleThresholdHours;
	const staleAfterMs = thresholdHours * 60 * 60 * 1000;
	return Date.now() - new Date(lastSyncAt).getTime() > staleAfterMs;
}
