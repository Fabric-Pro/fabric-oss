import type { SyncCursor } from "../../../workflows/connector-sync/types";
import { convertHtmlToText, normalizeHttpsBaseUrl } from "./shared";
import type { ConnectorCredentials, Document, Resource } from "./types";

interface SalesforceSyncConfig {
	objectTypes?: Array<"Account" | "Opportunity" | "Contact" | "Case">;
}

interface HubSpotSyncConfig {
	objectTypes?: Array<"contacts" | "companies" | "deals" | "tickets">;
}

interface IntercomSyncConfig {
	includeArticles?: boolean;
	includeConversations?: boolean;
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

function buildIntercomHeaders(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
		"Intercom-Version": "2.11",
	};
}

async function fetchIntercomJson<T>(input: {
	token: string;
	path: string;
	query?: Record<string, string>;
}): Promise<T> {
	const queryString = input.query
		? `?${new URLSearchParams(input.query).toString()}`
		: "";
	const response = await fetch(
		`https://api.intercom.io${input.path}${queryString}`,
		{
			headers: buildIntercomHeaders(input.token),
		},
	);

	if (!response.ok) {
		throw new Error(
			`Intercom API error ${response.status} for ${input.path}`,
		);
	}

	return (await response.json()) as T;
}

export async function testSalesforceConnection(
	credentials: ConnectorCredentials,
) {
	if (
		typeof credentials.domain !== "string" ||
		(typeof credentials.apiToken !== "string" &&
			typeof credentials.accessToken !== "string")
	) {
		return false;
	}

	const accessToken =
		typeof credentials.apiToken === "string"
			? credentials.apiToken
			: (credentials.accessToken as string);
	const response = await fetch(
		`${normalizeHttpsBaseUrl(credentials.domain)}/services/data/v61.0/limits`,
		{
			headers: buildSalesforceHeaders(accessToken),
		},
	);
	return response.ok;
}

export async function testHubSpotConnection(credentials: ConnectorCredentials) {
	const token =
		typeof credentials.apiKey === "string"
			? credentials.apiKey
			: typeof credentials.accessToken === "string"
				? credentials.accessToken
				: null;
	if (!token) {
		return false;
	}
	const response = await fetch("https://api.hubapi.com/integrations/v1/me", {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
		},
	});
	return response.ok;
}

export async function testIntercomConnection(
	credentials: ConnectorCredentials,
) {
	if (
		typeof credentials.apiKey !== "string" &&
		typeof credentials.accessToken !== "string"
	) {
		return false;
	}
	const token =
		typeof credentials.apiKey === "string"
			? credentials.apiKey
			: (credentials.accessToken as string);
	const response = await fetch("https://api.intercom.io/me", {
		headers: buildIntercomHeaders(token),
	});
	return response.ok;
}

export async function discoverSalesforceResources(input: {
	credentials: ConnectorCredentials;
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

	const baseUrl = normalizeHttpsBaseUrl(domain);
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

export async function discoverHubSpotResources(input: {
	credentials: ConnectorCredentials;
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
				paging?: { next?: { after?: string } };
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

export async function discoverIntercomResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token =
		typeof input.credentials.apiKey === "string"
			? input.credentials.apiKey
			: typeof input.credentials.accessToken === "string"
				? input.credentials.accessToken
				: null;
	if (!token) {
		throw new Error("Intercom access token is required");
	}

	const config = input.providerConfig as IntercomSyncConfig;
	const resources: Resource[] = [];

	if (config.includeArticles !== false) {
		const articles = await fetchIntercomJson<{
			data?: Array<{
				id: string;
				title?: string;
				url?: string;
				updated_at?: number;
			}>;
		}>({
			token,
			path: "/articles",
			query: {
				per_page: "100",
			},
		});

		for (const article of articles.data ?? []) {
			resources.push({
				id: `intercom:article:${article.id}`,
				name: article.title ?? `Intercom Article ${article.id}`,
				type: "intercom-article",
				path: article.url,
				metadata: {
					sourceType: "article",
					articleId: article.id,
					updatedAt:
						typeof article.updated_at === "number"
							? new Date(article.updated_at * 1000).toISOString()
							: null,
				},
			});
		}
	}

	if (config.includeConversations !== false) {
		const conversations = await fetchIntercomJson<{
			conversations?: Array<{
				id: string;
				created_at?: number;
				updated_at?: number;
				source?: {
					body?: string;
					subject?: string;
					author?: { name?: string };
				};
			}>;
		}>({
			token,
			path: "/conversations",
			query: {
				per_page: "100",
			},
		});

		for (const conversation of conversations.conversations ?? []) {
			resources.push({
				id: `intercom:conversation:${conversation.id}`,
				name:
					conversation.source?.subject?.trim() ||
					`Intercom Conversation ${conversation.id}`,
				type: "intercom-conversation",
				metadata: {
					sourceType: "conversation",
					conversationId: conversation.id,
					updatedAt:
						typeof conversation.updated_at === "number"
							? new Date(
									conversation.updated_at * 1000,
								).toISOString()
							: null,
				},
			});
		}
	}

	return resources;
}

export async function fetchSalesforceResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
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

	const baseUrl = normalizeHttpsBaseUrl(domain);
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

export async function fetchHubSpotResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
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

export async function fetchIntercomResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token =
		typeof input.credentials.apiKey === "string"
			? input.credentials.apiKey
			: typeof input.credentials.accessToken === "string"
				? input.credentials.accessToken
				: null;
	if (!token) {
		throw new Error("Intercom access token is required");
	}

	if (input.resource.type === "intercom-conversation") {
		const conversationId =
			(typeof input.resource.metadata?.conversationId === "string" &&
				input.resource.metadata.conversationId) ||
			input.resource.id.replace(/^intercom:conversation:/, "");
		const conversation = await fetchIntercomJson<{
			id: string;
			created_at?: number;
			updated_at?: number;
			source?: {
				body?: string;
				subject?: string;
				author?: { name?: string };
			};
			conversation_parts?: {
				conversation_parts?: Array<{
					created_at?: number;
					body?: string;
					author?: { name?: string };
				}>;
			};
		}>({
			token,
			path: `/conversations/${conversationId}`,
		});

		const parts = conversation.conversation_parts?.conversation_parts ?? [];
		const updatedAt =
			typeof conversation.updated_at === "number"
				? new Date(conversation.updated_at * 1000).toISOString()
				: null;
		const title =
			conversation.source?.subject?.trim() ||
			`Intercom Conversation ${conversation.id}`;
		const body = convertHtmlToText(conversation.source?.body ?? "");
		const partText = parts
			.map((part) =>
				[
					part.author?.name ? `Author: ${part.author.name}` : null,
					part.created_at
						? `At: ${new Date(part.created_at * 1000).toISOString()}`
						: null,
					convertHtmlToText(part.body ?? "") || "(No message body)",
				]
					.filter((value): value is string => Boolean(value))
					.join("\n"),
			)
			.join("\n\n---\n\n");
		const content = [
			`# ${title}`,
			"",
			body || "(No conversation body)",
			partText ? `\n## Replies\n\n${partText}` : null,
		]
			.filter((value): value is string => Boolean(value))
			.join("\n");

		return {
			documents: [
				{
					id: `intercom-conversation-${conversation.id}`,
					externalId: `intercom:conversation:${conversation.id}`,
					title,
					content,
					contentHash: updatedAt ?? undefined,
					metadata: {
						resourceType: "conversation",
						conversationId: conversation.id,
						url: input.resource.path ?? null,
						updatedAt,
						replyCount: parts.length,
					},
					sizeBytes: Buffer.byteLength(content, "utf8"),
					textLength: content.length,
				},
			],
			newCursor: updatedAt
				? {
						connectorId: input.connectorId,
						provider: "INTERCOM",
						cursorType: "incremental",
						cursor: updatedAt,
						lastSyncedAt: updatedAt,
					}
				: undefined,
		};
	}

	const articleId =
		(typeof input.resource.metadata?.articleId === "string" &&
			input.resource.metadata.articleId) ||
		input.resource.id.replace(/^intercom:article:/, "");
	const article = await fetchIntercomJson<{
		id: string;
		title?: string;
		description?: string;
		body?: string;
		url?: string;
		updated_at?: number;
	}>({
		token,
		path: `/articles/${articleId}`,
	});

	const updatedAt =
		typeof article.updated_at === "number"
			? new Date(article.updated_at * 1000).toISOString()
			: null;
	const bodyText = convertHtmlToText(
		article.body ?? article.description ?? "",
	);
	const title = article.title ?? `Intercom Article ${article.id}`;
	const content = `# ${title}\n\n${bodyText || "(Content could not be extracted)"}`;

	return {
		documents: [
			{
				id: `intercom-article-${article.id}`,
				externalId: `intercom:article:${article.id}`,
				title,
				content,
				contentHash: updatedAt ?? undefined,
				metadata: {
					resourceType: "article",
					articleId: article.id,
					url: article.url ?? input.resource.path ?? null,
					updatedAt,
				},
				sizeBytes: Buffer.byteLength(
					article.body ?? article.description ?? "",
					"utf8",
				),
				textLength: bodyText.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "INTERCOM",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}
