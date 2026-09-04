/**
 * Connector Sync Activities
 *
 * Activities for the connector sync workflow.
 * These handle external API calls, database operations, and embedding generation.
 */

import { getSystemRAGProviderConfig } from "@repo/ai";
import {
	createDocumentChunks,
	createSyncJob,
	type DataConnectionProvider,
	type DataConnectionStatus,
	db,
	getConnectionWithCredentials,
	getSyncedResourceByExternalId,
	type Prisma,
	type ResourceSyncStatus,
	type SyncJobStatus,
	updateDataConnection,
	updateSyncJob,
	updateWorkspaceDocument,
	upsertSyncedResource,
	upsertSyncSchedule,
} from "@repo/database";
import {
	chunkText,
	deleteWorkspaceDocumentChunks,
	enrichChunksWithTenantContext,
	generateEmbeddings as generateTextEmbeddings,
	storeWorkspaceChunksBatch,
} from "@repo/rag";
import { decryptApiKey } from "@repo/utils";
import type { SyncCursor } from "../workflows/connector-sync/types";
import {
	discoverBitbucketResources as discoverCollabBitbucketResources,
	discoverGitHubResources as discoverCollabGitHubResources,
	discoverGitLabResources as discoverCollabGitLabResources,
	discoverSlackResources as discoverCollabSlackResources,
	fetchBitbucketResourceDocuments as fetchCollabBitbucketResourceDocuments,
	fetchGitHubResourceDocuments as fetchCollabGitHubResourceDocuments,
	fetchGitLabResourceDocuments as fetchCollabGitLabResourceDocuments,
	fetchSlackResourceDocuments as fetchCollabSlackResourceDocuments,
	testBitbucketConnection,
	testGitLabConnection,
	testSlackConnection,
} from "./connector-sync/providers/collaboration";
import {
	discoverHubSpotResources as discoverCrmHubSpotResources,
	discoverSalesforceResources as discoverCrmSalesforceResources,
	discoverIntercomResources,
	fetchHubSpotResourceDocuments as fetchCrmHubSpotResourceDocuments,
	fetchSalesforceResourceDocuments as fetchCrmSalesforceResourceDocuments,
	fetchIntercomResourceDocuments,
	testHubSpotConnection,
	testIntercomConnection,
	testSalesforceConnection,
} from "./connector-sync/providers/crm";
import {
	discoverAirtableResources as discoverKnowledgeAirtableResources,
	discoverCodaResources as discoverKnowledgeCodaResources,
	discoverConfluenceResources as discoverKnowledgeConfluenceResources,
	discoverDropboxResources as discoverKnowledgeDropboxResources,
	discoverGitBookResources as discoverKnowledgeGitBookResources,
	discoverGmailResources as discoverKnowledgeGmailResources,
	discoverGoogleDriveResources as discoverKnowledgeGoogleDriveResources,
	discoverGoogleStorageResources as discoverKnowledgeGoogleStorageResources,
	discoverMicrosoftResources as discoverKnowledgeMicrosoftResources,
	discoverNotionResources as discoverKnowledgeNotionResources,
	discoverR2Resources as discoverKnowledgeR2Resources,
	discoverS3Resources as discoverKnowledgeS3Resources,
	discoverTeamsResources as discoverKnowledgeTeamsResources,
	fetchAirtableResourceDocuments as fetchKnowledgeAirtableResourceDocuments,
	fetchCodaResourceDocuments as fetchKnowledgeCodaResourceDocuments,
	fetchConfluenceResourceDocuments as fetchKnowledgeConfluenceResourceDocuments,
	fetchDropboxResourceDocuments as fetchKnowledgeDropboxResourceDocuments,
	fetchGitBookResourceDocuments as fetchKnowledgeGitBookResourceDocuments,
	fetchGmailResourceDocuments as fetchKnowledgeGmailResourceDocuments,
	fetchGoogleDriveResourceDocuments as fetchKnowledgeGoogleDriveResourceDocuments,
	fetchGoogleStorageResourceDocuments as fetchKnowledgeGoogleStorageResourceDocuments,
	fetchMicrosoftResourceDocuments as fetchKnowledgeMicrosoftResourceDocuments,
	fetchNotionResourceDocuments as fetchKnowledgeNotionResourceDocuments,
	fetchR2ResourceDocuments as fetchKnowledgeR2ResourceDocuments,
	fetchS3ResourceDocuments as fetchKnowledgeS3ResourceDocuments,
	fetchTeamsResourceDocuments as fetchKnowledgeTeamsResourceDocuments,
	testAirtableConnection as testKnowledgeAirtableConnection,
	testConfluenceConnection as testKnowledgeConfluenceConnection,
	testGoogleDriveConnection as testKnowledgeGoogleDriveConnection,
	testGoogleStorageConnection as testKnowledgeGoogleStorageConnection,
	testMicrosoftConnection as testKnowledgeMicrosoftConnection,
	testNotionConnection as testKnowledgeNotionConnection,
	testR2Connection as testKnowledgeR2Connection,
	testS3Connection as testKnowledgeS3Connection,
	testTeamsConnection as testKnowledgeTeamsConnection,
} from "./connector-sync/providers/knowledge";
import {
	discoverBigQueryResources,
	discoverSnowflakeResources,
	fetchBigQueryResourceDocuments,
	fetchSnowflakeResourceDocuments,
	testBigQueryConnection,
	testSnowflakeConnection,
} from "./connector-sync/providers/warehouse";
import {
	discoverAsanaResources as discoverWorkAsanaResources,
	discoverClickUpResources as discoverWorkClickUpResources,
	discoverJiraResources as discoverWorkJiraResources,
	discoverLinearResources as discoverWorkLinearResources,
	discoverZendeskResources as discoverWorkZendeskResources,
	fetchAsanaResourceDocuments as fetchWorkAsanaResourceDocuments,
	fetchClickUpResourceDocuments as fetchWorkClickUpResourceDocuments,
	fetchJiraResourceDocuments as fetchWorkJiraResourceDocuments,
	fetchLinearResourceDocuments as fetchWorkLinearResourceDocuments,
	fetchZendeskResourceDocuments as fetchWorkZendeskResourceDocuments,
	testAsanaConnection,
	testClickUpConnection,
	testJiraConnection,
	testLinearConnection,
	testZendeskConnection,
} from "./connector-sync/providers/work";

// =============================================================================
// Types
// =============================================================================

export interface ConnectorConfig {
	id: string;
	provider: string;
	name: string;
	status: DataConnectionStatus;
	credentials: {
		accessToken?: string | null;
		refreshToken?: string | null;
		apiKey?: string;
		[key: string]: unknown;
	};
	providerConfig: Record<string, unknown>;
	syncConfig: {
		incrementalSyncIntervalMinutes?: number;
	};
	lastSyncAt?: Date | null;
}

export interface Resource {
	id: string;
	name: string;
	type: string;
	path?: string;
	metadata?: Record<string, unknown>;
}

export interface Document {
	id: string;
	externalId: string;
	title: string;
	content: string;
	contentHash?: string;
	metadata: Record<string, unknown>;
	sizeBytes?: number;
	textLength?: number;
}

interface SalesforceSyncConfig {
	objectTypes?: Array<"Account" | "Opportunity" | "Contact" | "Case">;
}

interface HubSpotSyncConfig {
	objectTypes?: Array<"contacts" | "companies" | "deals" | "tickets">;
}

function normalizeSalesforceBaseUrl(domain: string): string {
	const normalizedDomain = domain
		.trim()
		.replace(/^https?:\/\//, "")
		.replace(/\/+$/, "");
	return `https://${normalizedDomain}`;
}

function buildSalesforceHeaders(accessToken: string) {
	return {
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
	};
}

async function fetchSalesforceJson<T>(input: {
	baseUrl: string;
	accessToken: string;
	path: string;
	query?: Record<string, string>;
}): Promise<T> {
	const queryString = input.query
		? `?${new URLSearchParams(input.query).toString()}`
		: "";
	const response = await fetch(
		`${input.baseUrl}${input.path}${queryString}`,
		{
			headers: buildSalesforceHeaders(input.accessToken),
		},
	);

	if (!response.ok) {
		throw new Error(
			`Salesforce API error ${response.status} for ${input.path}`,
		);
	}

	return (await response.json()) as T;
}

function getSalesforceObjectTypes(
	config: SalesforceSyncConfig,
): Array<"Account" | "Opportunity" | "Contact" | "Case"> {
	return config.objectTypes?.length
		? config.objectTypes
		: ["Account", "Opportunity", "Contact", "Case"];
}

function getSalesforceDiscoveryQuery(objectType: string): string {
	switch (objectType) {
		case "Account":
			return "SELECT Id, Name, LastModifiedDate FROM Account ORDER BY LastModifiedDate DESC LIMIT 100";
		case "Opportunity":
			return "SELECT Id, Name, StageName, Amount, LastModifiedDate FROM Opportunity ORDER BY LastModifiedDate DESC LIMIT 100";
		case "Contact":
			return "SELECT Id, Name, Email, LastModifiedDate FROM Contact ORDER BY LastModifiedDate DESC LIMIT 100";
		case "Case":
			return "SELECT Id, CaseNumber, Subject, Status, LastModifiedDate FROM Case ORDER BY LastModifiedDate DESC LIMIT 100";
		default:
			return `SELECT Id, Name, LastModifiedDate FROM ${objectType} ORDER BY LastModifiedDate DESC LIMIT 100`;
	}
}

function getSalesforceFetchQuery(objectType: string, recordId: string): string {
	switch (objectType) {
		case "Account":
			return `SELECT Id, Name, Type, Industry, Description, OwnerId, LastModifiedDate FROM Account WHERE Id = '${recordId}' LIMIT 1`;
		case "Opportunity":
			return `SELECT Id, Name, StageName, Amount, CloseDate, Description, LastModifiedDate FROM Opportunity WHERE Id = '${recordId}' LIMIT 1`;
		case "Contact":
			return `SELECT Id, Name, Email, Phone, Title, Department, Description, LastModifiedDate FROM Contact WHERE Id = '${recordId}' LIMIT 1`;
		case "Case":
			return `SELECT Id, CaseNumber, Subject, Description, Status, Priority, Origin, LastModifiedDate FROM Case WHERE Id = '${recordId}' LIMIT 1`;
		default:
			return `SELECT Id, Name, LastModifiedDate FROM ${objectType} WHERE Id = '${recordId}' LIMIT 1`;
	}
}

function buildSalesforceTitle(
	objectType: string,
	record: Record<string, unknown>,
	recordId: string,
): string {
	if (objectType === "Case") {
		return `Case ${String(record.CaseNumber ?? recordId)}: ${String(record.Subject ?? "Untitled Case")}`;
	}

	return String(record.Name ?? record.Subject ?? `${objectType} ${recordId}`);
}

function buildSalesforceContent(
	objectType: string,
	record: Record<string, unknown>,
): string {
	const entries = Object.entries(record).filter(
		([key, value]) =>
			key !== "attributes" &&
			value !== null &&
			value !== undefined &&
			String(value).trim() !== "",
	);

	return [
		`${objectType} record`,
		"",
		...entries.map(([key, value]) => `${key}: ${String(value)}`),
	].join("\n");
}

async function fetchHubSpotJson<T>(input: {
	token: string;
	path: string;
	query?: Record<string, string>;
}): Promise<T> {
	const queryString = input.query
		? `?${new URLSearchParams(input.query).toString()}`
		: "";
	const response = await fetch(
		`https://api.hubapi.com${input.path}${queryString}`,
		{
			headers: {
				Authorization: `Bearer ${input.token}`,
				Accept: "application/json",
			},
		},
	);

	if (!response.ok) {
		throw new Error(
			`HubSpot API error ${response.status} for ${input.path}`,
		);
	}

	return (await response.json()) as T;
}

function getHubSpotObjectTypes(
	config: HubSpotSyncConfig,
): Array<"contacts" | "companies" | "deals" | "tickets"> {
	return config.objectTypes?.length
		? config.objectTypes
		: ["contacts", "companies", "deals", "tickets"];
}

function getHubSpotProperties(
	objectType: "contacts" | "companies" | "deals" | "tickets",
): string[] {
	switch (objectType) {
		case "contacts":
			return [
				"firstname",
				"lastname",
				"email",
				"jobtitle",
				"hs_lastmodifieddate",
			];
		case "companies":
			return [
				"name",
				"domain",
				"industry",
				"description",
				"hs_lastmodifieddate",
			];
		case "deals":
			return [
				"dealname",
				"amount",
				"dealstage",
				"description",
				"hs_lastmodifieddate",
			];
		case "tickets":
			return [
				"subject",
				"content",
				"hs_pipeline_stage",
				"hs_lastmodifieddate",
			];
	}
}

function buildHubSpotTitle(
	objectType: "contacts" | "companies" | "deals" | "tickets",
	properties: Record<string, unknown>,
	recordId: string,
): string {
	switch (objectType) {
		case "contacts":
			return (
				`${String(properties.firstname ?? "")} ${String(properties.lastname ?? "")}`.trim() ||
				String(properties.email ?? `Contact ${recordId}`)
			);
		case "companies":
			return String(properties.name ?? `Company ${recordId}`);
		case "deals":
			return String(properties.dealname ?? `Deal ${recordId}`);
		case "tickets":
			return String(properties.subject ?? `Ticket ${recordId}`);
	}
}

function buildHubSpotContent(
	objectType: "contacts" | "companies" | "deals" | "tickets",
	properties: Record<string, unknown>,
): string {
	const entries = Object.entries(properties).filter(
		([, value]) =>
			value !== null &&
			value !== undefined &&
			String(value).trim() !== "",
	);

	return [
		`${objectType.slice(0, -1)} record`,
		"",
		...entries.map(([key, value]) => `${key}: ${String(value)}`),
	].join("\n");
}

function slugifyFilename(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

async function _discoverSalesforceResources(input: {
	credentials: ConnectorConfig["credentials"];
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const domain =
		typeof input.credentials.domain === "string"
			? input.credentials.domain
			: null;
	const accessToken =
		typeof input.credentials.apiToken === "string"
			? input.credentials.apiToken
			: typeof input.credentials.accessToken === "string"
				? input.credentials.accessToken
				: null;

	if (!domain || !accessToken) {
		throw new Error(
			"Salesforce instance URL and access token are required",
		);
	}

	const baseUrl = normalizeSalesforceBaseUrl(domain);
	const config = input.providerConfig as SalesforceSyncConfig;
	const resources: Resource[] = [];

	for (const objectType of getSalesforceObjectTypes(config)) {
		const result = await fetchSalesforceJson<{
			records?: Array<Record<string, unknown>>;
		}>({
			baseUrl,
			accessToken,
			path: "/services/data/v61.0/query",
			query: {
				q: getSalesforceDiscoveryQuery(objectType),
			},
		});

		for (const record of result.records ?? []) {
			const recordId = typeof record.Id === "string" ? record.Id : null;
			if (!recordId) {
				continue;
			}

			resources.push({
				id: `salesforce:${objectType}:${recordId}`,
				name: buildSalesforceTitle(objectType, record, recordId),
				type: "salesforce-record",
				path: `${baseUrl}/lightning/r/${objectType}/${recordId}/view`,
				metadata: {
					objectType,
					recordId,
					lastModifiedDate:
						typeof record.LastModifiedDate === "string"
							? record.LastModifiedDate
							: null,
				},
			});
		}
	}

	return resources;
}

async function _discoverHubSpotResources(input: {
	credentials: ConnectorConfig["credentials"];
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token =
		typeof input.credentials.apiKey === "string"
			? input.credentials.apiKey
			: typeof input.credentials.accessToken === "string"
				? input.credentials.accessToken
				: null;

	if (!token) {
		throw new Error("HubSpot private app token is required");
	}

	const config = input.providerConfig as HubSpotSyncConfig;
	const resources: Resource[] = [];

	for (const objectType of getHubSpotObjectTypes(config)) {
		let after: string | null = null;

		do {
			const response: {
				results?: Array<{
					id: string;
					properties?: Record<string, unknown>;
					updatedAt?: string;
				}>;
				paging?: {
					next?: {
						after?: string;
					};
				};
			} = await fetchHubSpotJson({
				token,
				path: `/crm/v3/objects/${objectType}`,
				query: {
					limit: "100",
					properties: getHubSpotProperties(objectType).join(","),
					...(after ? { after } : {}),
				},
			});

			for (const record of response.results ?? []) {
				resources.push({
					id: `hubspot:${objectType}:${record.id}`,
					name: buildHubSpotTitle(
						objectType,
						record.properties ?? {},
						record.id,
					),
					type: "hubspot-record",
					metadata: {
						objectType,
						recordId: record.id,
						updatedAt:
							typeof record.updatedAt === "string"
								? record.updatedAt
								: null,
					},
				});
			}

			after = response.paging?.next?.after ?? null;
		} while (after);
	}

	return resources;
}

async function _fetchSalesforceResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorConfig["credentials"];
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const domain =
		typeof input.credentials.domain === "string"
			? input.credentials.domain
			: null;
	const accessToken =
		typeof input.credentials.apiToken === "string"
			? input.credentials.apiToken
			: typeof input.credentials.accessToken === "string"
				? input.credentials.accessToken
				: null;

	if (!domain || !accessToken) {
		throw new Error(
			"Salesforce instance URL and access token are required",
		);
	}

	const objectType =
		typeof input.resource.metadata?.objectType === "string"
			? input.resource.metadata.objectType
			: null;
	const recordId =
		typeof input.resource.metadata?.recordId === "string"
			? input.resource.metadata.recordId
			: (input.resource.id.split(":").slice(-1)[0] ?? null);

	if (!objectType || !recordId) {
		throw new Error("Salesforce resource metadata is incomplete");
	}

	const baseUrl = normalizeSalesforceBaseUrl(domain);
	const result = await fetchSalesforceJson<{
		records?: Array<Record<string, unknown>>;
	}>({
		baseUrl,
		accessToken,
		path: "/services/data/v61.0/query",
		query: {
			q: getSalesforceFetchQuery(objectType, recordId),
		},
	});

	const record = result.records?.[0];
	if (!record) {
		return { documents: [] };
	}

	const updatedAt =
		typeof record.LastModifiedDate === "string"
			? record.LastModifiedDate
			: null;
	const title = buildSalesforceTitle(objectType, record, recordId);
	const content = buildSalesforceContent(objectType, record);

	return {
		documents: [
			{
				id: `salesforce-${objectType}-${recordId}`,
				externalId: `salesforce:${objectType}:${recordId}`,
				title,
				content,
				contentHash: updatedAt ?? undefined,
				metadata: {
					resourceType: objectType,
					recordId,
					url:
						input.resource.path ??
						`${baseUrl}/lightning/r/${objectType}/${recordId}/view`,
					updatedAt,
				},
				sizeBytes: Buffer.byteLength(content, "utf8"),
				textLength: content.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "SALESFORCE",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}

async function _fetchHubSpotResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorConfig["credentials"];
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token =
		typeof input.credentials.apiKey === "string"
			? input.credentials.apiKey
			: typeof input.credentials.accessToken === "string"
				? input.credentials.accessToken
				: null;

	if (!token) {
		throw new Error("HubSpot private app token is required");
	}

	const objectType =
		typeof input.resource.metadata?.objectType === "string"
			? (input.resource.metadata.objectType as
					| "contacts"
					| "companies"
					| "deals"
					| "tickets")
			: null;
	const recordId =
		typeof input.resource.metadata?.recordId === "string"
			? input.resource.metadata.recordId
			: (input.resource.id.split(":").slice(-1)[0] ?? null);

	if (!objectType || !recordId) {
		throw new Error("HubSpot resource metadata is incomplete");
	}

	const result = await fetchHubSpotJson<{
		id: string;
		properties?: Record<string, unknown>;
		updatedAt?: string;
	}>({
		token,
		path: `/crm/v3/objects/${objectType}/${recordId}`,
		query: {
			properties: getHubSpotProperties(objectType).join(","),
		},
	});

	const properties = result.properties ?? {};
	const updatedAt =
		typeof result.updatedAt === "string" ? result.updatedAt : null;
	const title = buildHubSpotTitle(objectType, properties, recordId);
	const content = buildHubSpotContent(objectType, properties);

	return {
		documents: [
			{
				id: `hubspot-${objectType}-${recordId}`,
				externalId: `hubspot:${objectType}:${recordId}`,
				title,
				content,
				contentHash: updatedAt ?? undefined,
				metadata: {
					resourceType: objectType,
					recordId,
					updatedAt,
				},
				sizeBytes: Buffer.byteLength(content, "utf8"),
				textLength: content.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "HUBSPOT",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}

// =============================================================================
// Configuration Activities
// =============================================================================

export async function loadConnectorConfig(input: {
	connectorId: string;
	userId: string;
	organizationId?: string;
}): Promise<ConnectorConfig | null> {
	const connection = await getConnectionWithCredentials({
		id: input.connectorId,
		userId: input.userId,
		organizationId: input.organizationId,
	});

	if (!connection) {
		return null;
	}

	// Parse credentials from the encrypted JSON field
	const inlineCredentials = connection.credentials as Record<
		string,
		unknown
	> | null;
	let reusableCredentialPayload: Record<string, unknown> | null = null;
	if (connection.credential?.encryptedPayload) {
		try {
			reusableCredentialPayload = JSON.parse(
				decryptApiKey(connection.credential.encryptedPayload),
			) as Record<string, unknown>;
		} catch (error) {
			throw new Error(
				`Failed to load saved credentials for connector ${connection.id}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	const config = connection.config as Record<string, unknown> | null;

	return {
		id: connection.id,
		provider: connection.provider,
		name: connection.name,
		status: connection.status,
		credentials: {
			accessToken: connection.accessToken,
			refreshToken: connection.refreshToken,
			...(reusableCredentialPayload || {}),
			...(inlineCredentials || {}),
		},
		providerConfig: config || {},
		syncConfig: {
			incrementalSyncIntervalMinutes: 60, // Default 1 hour
		},
		lastSyncAt: connection.lastSyncAt,
	};
}

export async function testConnection(input: {
	connectorId: string;
	provider: string;
	credentials: ConnectorConfig["credentials"];
}): Promise<boolean> {
	// Test connection based on provider
	// This is a stub - actual implementation would call provider APIs
	try {
		switch (
			input.provider as
				| DataConnectionProvider
				| "BITBUCKET"
				| "S3"
				| "GOOGLE_STORAGE"
				| "R2"
				| "DROPBOX"
				| "AIRTABLE"
				| "CODA"
				| "GITBOOK"
				| "TEAMS"
				| "ASANA"
				| "CLICKUP"
		) {
			case "GOOGLE_DRIVE":
				return testKnowledgeGoogleDriveConnection(input.credentials);

			case "S3":
				return testKnowledgeS3Connection(input.credentials);
			case "GOOGLE_STORAGE":
				return testKnowledgeGoogleStorageConnection(input.credentials);
			case "R2":
				return testKnowledgeR2Connection(input.credentials);

			case "AIRTABLE":
				return testKnowledgeAirtableConnection(input.credentials);

			case "DROPBOX":
				return !!(
					input.credentials.accessToken ?? input.credentials.apiKey
				);

			case "CODA":
				return !!(
					input.credentials.accessToken ?? input.credentials.apiKey
				);

			case "GITBOOK":
				return !!(
					input.credentials.accessToken ?? input.credentials.apiKey
				);
			case "TEAMS":
				return testKnowledgeTeamsConnection(input.credentials);

			case "NOTION":
				return testKnowledgeNotionConnection(input.credentials);

			case "CONFLUENCE":
				return testKnowledgeConfluenceConnection(input.credentials);

			case "JIRA":
				return testJiraConnection(input.credentials);

			case "SLACK":
				return testSlackConnection(input.credentials);

			case "GITHUB":
				// Test GitHub API access
				return !!input.credentials.accessToken;

			case "GITLAB":
				return testGitLabConnection(input.credentials);

			case "BITBUCKET":
				return testBitbucketConnection(input.credentials);

			case "LINEAR":
				return testLinearConnection(input.credentials);
			case "ASANA":
				return testAsanaConnection(input.credentials);
			case "CLICKUP":
				return testClickUpConnection(input.credentials);

			case "MICROSOFT_365":
				return testKnowledgeMicrosoftConnection(input.credentials);

			case "SNOWFLAKE":
				return testSnowflakeConnection(input.credentials);

			case "BIGQUERY":
				return testBigQueryConnection(input.credentials);

			case "INTERCOM":
				return testIntercomConnection(input.credentials);

			case "GONG":
				// Test SaaS API access
				return !!input.credentials.accessToken;

			case "ZENDESK":
				return testZendeskConnection(input.credentials);

			case "SALESFORCE":
				return testSalesforceConnection(input.credentials);

			case "HUBSPOT":
				return testHubSpotConnection(input.credentials);

			default:
				return false;
		}
	} catch {
		return false;
	}
}

export async function updateConnectorStatus(input: {
	connectorId: string;
	status: string;
	lastSyncAt?: string;
	lastError?: string;
	userId: string;
	organizationId?: string;
}): Promise<void> {
	const normalizedStatus: DataConnectionStatus =
		input.status === "ACTIVE"
			? "CONNECTED"
			: input.status === "SYNCING"
				? "SYNCING"
				: input.status === "ERROR"
					? "ERROR"
					: input.status === "PAUSED"
						? "PAUSED"
						: input.status === "EXPIRED"
							? "EXPIRED"
							: "CONNECTED";

	await updateDataConnection({
		id: input.connectorId,
		userId: input.userId,
		organizationId: input.organizationId,
		data: {
			status: normalizedStatus,
			...(input.lastSyncAt && { lastSyncAt: new Date(input.lastSyncAt) }),
			...(input.lastError !== undefined && {
				lastSyncError: input.lastError,
			}),
		},
	});
}

// =============================================================================
// Sync Job Activities
// =============================================================================

export async function createSyncJobActivity(input: {
	connectionId: string;
	type: "FULL" | "INCREMENTAL" | "SELECTIVE";
	workflowId?: string;
	runId?: string;
}): Promise<{ jobId: string }> {
	const job = await createSyncJob({
		connectionId: input.connectionId,
		type: input.type,
		workflowId: input.workflowId,
		runId: input.runId,
	});

	return { jobId: job.id };
}

export async function updateSyncJobActivity(input: {
	jobId: string;
	status?: SyncJobStatus;
	totalItems?: number;
	processedItems?: number;
	failedItems?: number;
	startedAt?: string;
	completedAt?: string;
	error?: string | null;
	stats?: Record<string, unknown>;
}): Promise<void> {
	await updateSyncJob({
		id: input.jobId,
		data: {
			...(input.status && { status: input.status }),
			...(input.totalItems !== undefined && {
				totalItems: input.totalItems,
			}),
			...(input.processedItems !== undefined && {
				processedItems: input.processedItems,
			}),
			...(input.failedItems !== undefined && {
				failedItems: input.failedItems,
			}),
			...(input.startedAt && { startedAt: new Date(input.startedAt) }),
			...(input.completedAt && {
				completedAt: new Date(input.completedAt),
			}),
			...(input.error !== undefined && { error: input.error }),
			...(input.stats && { stats: input.stats as Prisma.InputJsonValue }),
		},
	});
}

// =============================================================================
// Discovery Activities
// =============================================================================

export async function discoverResources(_input: {
	connectorId: string;
	provider: string;
	providerConfig: Record<string, unknown>;
	credentials: ConnectorConfig["credentials"];
}): Promise<Resource[]> {
	switch (
		_input.provider as
			| DataConnectionProvider
			| "BITBUCKET"
			| "S3"
			| "GOOGLE_STORAGE"
			| "R2"
			| "DROPBOX"
			| "AIRTABLE"
			| "CODA"
			| "GITBOOK"
			| "TEAMS"
			| "ASANA"
			| "CLICKUP"
	) {
		case "GITHUB":
			return discoverCollabGitHubResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "GITLAB":
			return discoverCollabGitLabResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "BITBUCKET":
			return discoverCollabBitbucketResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "GMAIL":
			return discoverKnowledgeGmailResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "S3":
			return discoverKnowledgeS3Resources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "GOOGLE_STORAGE":
			return discoverKnowledgeGoogleStorageResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "R2":
			return discoverKnowledgeR2Resources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "AIRTABLE":
			return discoverKnowledgeAirtableResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "CODA":
			return discoverKnowledgeCodaResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "GITBOOK":
			return discoverKnowledgeGitBookResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "TEAMS":
			return discoverKnowledgeTeamsResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "DROPBOX":
			return discoverKnowledgeDropboxResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "SALESFORCE":
			return discoverCrmSalesforceResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "HUBSPOT":
			return discoverCrmHubSpotResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "INTERCOM":
			return discoverIntercomResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "LINEAR":
			return discoverWorkLinearResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "ASANA":
			return discoverWorkAsanaResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "CLICKUP":
			return discoverWorkClickUpResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "ZENDESK":
			return discoverWorkZendeskResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "JIRA":
			return discoverWorkJiraResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "CONFLUENCE":
			return discoverKnowledgeConfluenceResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "SNOWFLAKE":
			return discoverSnowflakeResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "BIGQUERY":
			return discoverBigQueryResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "SLACK":
			return discoverCollabSlackResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "NOTION":
			return discoverKnowledgeNotionResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "GOOGLE_DRIVE":
			return discoverKnowledgeGoogleDriveResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "MICROSOFT_365":
			return discoverKnowledgeMicrosoftResources({
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		default:
			return [];
	}
}

// =============================================================================
// Fetch Activities
// =============================================================================

export async function fetchResourceDocuments(_input: {
	connectorId: string;
	provider: string;
	resource: Resource;
	credentials: ConnectorConfig["credentials"];
	providerConfig?: Record<string, unknown>;
	syncType: "full" | "incremental" | "gc";
	cursor?: SyncCursor;
	batchSize: number;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	switch (
		_input.provider as
			| DataConnectionProvider
			| "BITBUCKET"
			| "S3"
			| "GOOGLE_STORAGE"
			| "R2"
			| "DROPBOX"
			| "AIRTABLE"
			| "CODA"
			| "GITBOOK"
			| "TEAMS"
			| "ASANA"
			| "CLICKUP"
	) {
		case "GITHUB":
			return fetchCollabGitHubResourceDocuments({
				resource: _input.resource,
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
				cursor: _input.cursor,
				batchSize: _input.batchSize,
				syncType: _input.syncType,
			});
		case "GITLAB":
			return fetchCollabGitLabResourceDocuments({
				resource: _input.resource,
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
				cursor: _input.cursor,
				batchSize: _input.batchSize,
				syncType: _input.syncType,
			});
		case "BITBUCKET":
			return fetchCollabBitbucketResourceDocuments({
				resource: _input.resource,
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
				cursor: _input.cursor,
				batchSize: _input.batchSize,
				syncType: _input.syncType,
			});
		case "GMAIL":
			return fetchKnowledgeGmailResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "S3":
			return fetchKnowledgeS3ResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "GOOGLE_STORAGE":
			return fetchKnowledgeGoogleStorageResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "R2":
			return fetchKnowledgeR2ResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "AIRTABLE":
			return fetchKnowledgeAirtableResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
				batchSize: _input.batchSize,
			});
		case "CODA":
			return fetchKnowledgeCodaResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "GITBOOK":
			return fetchKnowledgeGitBookResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "TEAMS":
			return fetchKnowledgeTeamsResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "DROPBOX":
			return fetchKnowledgeDropboxResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "SALESFORCE":
			return fetchCrmSalesforceResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "HUBSPOT":
			return fetchCrmHubSpotResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "INTERCOM":
			return fetchIntercomResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "LINEAR":
			return fetchWorkLinearResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "ASANA":
			return fetchWorkAsanaResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "CLICKUP":
			return fetchWorkClickUpResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "ZENDESK":
			return fetchWorkZendeskResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "JIRA":
			return fetchWorkJiraResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "CONFLUENCE":
			return fetchKnowledgeConfluenceResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "SNOWFLAKE":
			return fetchSnowflakeResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "BIGQUERY":
			return fetchBigQueryResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
			});
		case "SLACK":
			return fetchCollabSlackResourceDocuments({
				resource: _input.resource,
				credentials: _input.credentials,
				providerConfig: _input.providerConfig,
				cursor: _input.cursor,
				batchSize: _input.batchSize,
				syncType: _input.syncType,
			});
		case "NOTION":
			return fetchKnowledgeNotionResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "GOOGLE_DRIVE":
			return fetchKnowledgeGoogleDriveResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		case "MICROSOFT_365":
			return fetchKnowledgeMicrosoftResourceDocuments({
				connectorId: _input.connectorId,
				resource: _input.resource,
				credentials: _input.credentials,
			});
		default:
			return { documents: [] };
	}
}

// =============================================================================
// Storage Activities
// =============================================================================

export async function storeDocuments(input: {
	connectorId: string;
	documents: Document[];
	userId: string;
	organizationId?: string;
}): Promise<{ added: number; updated: number }> {
	let added = 0;
	let updated = 0;

	for (const doc of input.documents) {
		try {
			const existingResource = await getSyncedResourceByExternalId({
				connectionId: input.connectorId,
				externalId: doc.externalId,
			});

			// Store a content preview (first 2000 chars) so the UI can show
			// something even before embeddings are generated
			const contentPreview = doc.content
				? doc.content.slice(0, 2000)
				: undefined;
			const metadataWithPreview = {
				...doc.metadata,
				...(contentPreview ? { contentPreview } : {}),
			};

			await upsertSyncedResource({
				connectionId: input.connectorId,
				externalId: doc.externalId,
				data: {
					resourceType:
						(doc.metadata.resourceType as string) || "document",
					title: doc.title,
					contentHash: doc.contentHash,
					metadata: metadataWithPreview as Prisma.InputJsonValue,
					lastSyncedAt: new Date(),
					syncStatus: "SYNCED" as ResourceSyncStatus,
					sizeBytes: doc.sizeBytes,
					textLength: doc.textLength,
				},
			});

			if (existingResource) {
				updated++;
			} else {
				added++;
			}
		} catch (error) {
			console.error("Error storing document:", doc.externalId, error);
		}
	}

	return { added, updated };
}

export async function generateEmbeddings(_input: {
	connectorId: string;
	documents: Document[];
	workspaceIds: string[];
	model: string;
	userId: string;
	organizationId?: string;
}): Promise<{ created: number; updated: number }> {
	if (_input.workspaceIds.length === 0 || _input.documents.length === 0) {
		return { created: 0, updated: 0 };
	}

	// Synced resources currently hold a single workspace/document link.
	// Use the primary workspace until the model supports many-to-many attachment.
	const workspaceId = _input.workspaceIds[0];
	let created = 0;
	let updated = 0;
	const providerConfig = await getSystemRAGProviderConfig({
		userId: _input.userId,
		organizationId: _input.organizationId,
	});

	for (const doc of _input.documents) {
		const existingResource = await getSyncedResourceByExternalId({
			connectionId: _input.connectorId,
			externalId: doc.externalId,
		});

		// Skip re-embedding if content hash hasn't changed
		if (
			doc.contentHash &&
			existingResource?.contentHash === doc.contentHash &&
			existingResource?.documentId
		) {
			continue;
		}

		let documentId = existingResource?.documentId ?? null;
		const metadata = {
			...(doc.metadata ?? {}),
			source: "data-connection",
			connectionId: _input.connectorId,
			externalId: doc.externalId,
		};

		// Canonical s3Path for this resource — unique per (connectorId, externalId)
		const s3Path = `data-connections/${_input.connectorId}/${encodeURIComponent(doc.externalId)}.md`;

		if (!documentId) {
			// Before creating a new document, check if an orphaned one already
			// exists at the canonical s3Path (left over from a previous buggy sync
			// where documentId was never written back to SyncedResource).
			const orphan = await db.workspaceDocument.findFirst({
				where: { workspaceId, s3Path, s3Bucket: "external-sync" },
				select: { id: true },
			});
			if (orphan) {
				documentId = orphan.id;
			}
		}

		if (documentId) {
			// Clean up any other orphaned documents at the same path that aren't
			// the one we're about to update (shouldn't normally exist, but defensive).
			await db.workspaceDocument.deleteMany({
				where: {
					workspaceId,
					s3Path,
					s3Bucket: "external-sync",
					id: { not: documentId },
				},
			});

			await deleteWorkspaceDocumentChunks(documentId, workspaceId);
			await db.workspaceDocumentChunk.deleteMany({
				where: { documentId },
			});
			await updateWorkspaceDocument(documentId, {
				status: "EMBEDDING",
				extractedText: doc.content,
				extractorUsed: "connector-sync",
				wordCount: doc.content.split(/\s+/).filter(Boolean).length,
				processingError: null,
				metadata,
				qdrantPointIds: [],
				chunkCount: 0,
			});
			updated++;
		} else {
			const createdDocument = await db.workspaceDocument.create({
				data: {
					workspaceId,
					filename: `${slugifyFilename(doc.title || doc.externalId) || "external-resource"}.md`,
					originalFilename: doc.title || doc.externalId,
					mimeType: "text/markdown",
					size:
						doc.sizeBytes ?? Buffer.byteLength(doc.content, "utf8"),
					s3Bucket: "external-sync",
					s3Path,
					status: "EMBEDDING",
					extractedText: doc.content,
					extractorUsed: "connector-sync",
					wordCount: doc.content.split(/\s+/).filter(Boolean).length,
					uploadedBy: _input.userId,
					qdrantPointIds: [],
					metadata,
				},
			});
			documentId = createdDocument.id;
			created++;
		}

		const chunks = chunkText(doc.content, doc.title, {});
		const enrichedChunks = await enrichChunksWithTenantContext(chunks, {
			documentContent: doc.content,
			documentTitle: doc.title,
			userId: _input.userId,
			organizationId: _input.organizationId,
		});
		const embeddings = await generateTextEmbeddings(
			enrichedChunks.map((chunk) => chunk.enrichedContent),
			{
				userId: _input.userId,
				organizationId: _input.organizationId,
				tags: ["connector-sync", "rag-embedding"],
			},
			providerConfig,
		);

		const pointIds = await storeWorkspaceChunksBatch({
			chunks: enrichedChunks.map((chunk, index) => ({
				chunkId: `${documentId}-${chunk.index}`,
				documentId,
				workspaceId,
				userId: _input.userId,
				organizationId: _input.organizationId,
				content: chunk.originalContent,
				chunkIndex: chunk.index,
				embedding: embeddings.embeddings[index],
				filename: doc.title,
				headings: chunk.metadata?.headings || [],
			})),
			wait: true,
		});

		await createDocumentChunks(
			documentId,
			enrichedChunks.map((chunk) => ({
				chunkIndex: chunk.index,
				content: chunk.originalContent,
				headings: chunk.metadata?.headings || [],
			})),
		);

		await updateWorkspaceDocument(documentId, {
			status: "READY",
			extractedText: doc.content,
			extractorUsed: "connector-sync",
			wordCount: doc.content.split(/\s+/).filter(Boolean).length,
			qdrantPointIds: pointIds,
			embeddedAt: new Date(),
			chunkCount: enrichedChunks.length,
			processingError: null,
			metadata,
		});

		await upsertSyncedResource({
			connectionId: _input.connectorId,
			externalId: doc.externalId,
			data: {
				resourceType:
					(doc.metadata.resourceType as string) || "document",
				title: doc.title,
				contentHash: doc.contentHash,
				metadata: doc.metadata as Prisma.InputJsonValue,
				workspaceId,
				documentId,
				lastSyncedAt: new Date(),
				syncStatus: "SYNCED",
				sizeBytes: doc.sizeBytes,
				textLength: doc.textLength,
			},
		});
	}

	return { created, updated };
}

// =============================================================================
// Cursor Activities
// =============================================================================

// In-memory cursor storage (would be replaced with database storage in production)
const cursorStorage = new Map<string, SyncCursor>();

export async function loadSyncCursor(input: {
	connectorId: string;
	cursorType: "incremental" | "gc";
}): Promise<SyncCursor | undefined> {
	const key = `${input.connectorId}-${input.cursorType}`;
	return cursorStorage.get(key);
}

export async function saveSyncCursor(input: {
	cursor: SyncCursor;
}): Promise<void> {
	const key = `${input.cursor.connectorId}-${input.cursor.cursorType}`;
	cursorStorage.set(key, input.cursor);
}

// =============================================================================
// Garbage Collection Activities
// =============================================================================

export async function garbageCollect(_input: {
	connectorId: string;
	provider: string;
	credentials: ConnectorConfig["credentials"];
	userId: string;
	organizationId?: string;
}): Promise<{ deleted: number; vectorsDeleted: number }> {
	// Get current resource IDs from the provider
	// Compare with stored resources
	// Mark missing resources as deleted

	// For now, return stub values
	// Actual implementation would:
	// 1. Fetch current list of resource IDs from provider
	// 2. Call markDeletedResources with current IDs
	// 3. Optionally delete embeddings from vector database

	return { deleted: 0, vectorsDeleted: 0 };
}

// =============================================================================
// Scheduling Activities
// =============================================================================

export async function scheduleNextSync(input: {
	connectorId: string;
	syncType: "full" | "incremental" | "gc";
	scheduledAt: string;
	userId: string;
	organizationId?: string;
}): Promise<void> {
	// Update the sync schedule with the next run time
	await upsertSyncSchedule({
		connectionId: input.connectorId,
		frequency: "HOURLY", // Default frequency
		nextRunAt: new Date(input.scheduledAt),
	});
}
