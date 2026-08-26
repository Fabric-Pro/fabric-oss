import {
	GetObjectCommand,
	ListObjectsV2Command,
	S3Client,
} from "@aws-sdk/client-s3";
import type { SyncCursor } from "../../../workflows/connector-sync/types";
import {
	buildBasicAuthHeaders,
	convertHtmlToText,
	normalizeHttpsBaseUrl,
} from "./shared";
import type { ConnectorCredentials, Document, Resource } from "./types";

interface ConfluenceSyncConfig {
	spaceKeys?: string[];
	pageIds?: string[];
	cql?: string;
}

interface NotionSyncConfig {
	pageIds?: string[];
	includePages?: boolean;
}

interface GoogleDriveSyncConfig {
	fileIds?: string[];
	folderIds?: string[];
	includeSharedDrives?: boolean;
	includeSharedWithMe?: boolean;
}

interface DropboxSyncConfig {
	paths?: string[];
	includePaperDocs?: boolean;
}

interface AirtableSyncConfig {
	baseId?: string;
	tableIds?: string[];
	view?: string;
	maxRecordsPerTable?: number;
}

interface S3SyncConfig {
	bucket?: string;
	prefix?: string;
	region?: string;
	accessKeyId?: string;
	endpoint?: string;
	forcePathStyle?: boolean;
}

interface CodaSyncConfig {
	workspaceId?: string;
	docIds?: string[];
	includePages?: boolean;
}

interface GitBookSyncConfig {
	spaceId?: string;
}

interface TeamsSyncConfig {
	teamIds?: string[];
	channelIds?: string[];
}

interface MicrosoftSyncConfig {
	includeSharePoint?: boolean;
	includeOneDrive?: boolean;
	includeTeams?: boolean;
	siteIds?: string[];
}

interface GmailSyncConfig {
	labelIds?: string[];
	includeSpamTrash?: boolean;
	query?: string;
}

function buildConfluenceSearchCql(config: ConfluenceSyncConfig): string {
	if (config.cql?.trim()) {
		return config.cql.trim();
	}

	if (config.spaceKeys && config.spaceKeys.length > 0) {
		const escapedSpaceKeys = config.spaceKeys
			.map((spaceKey) => `'${spaceKey.replace(/'/g, "\\'")}'`)
			.join(",");
		return `type=page and space in (${escapedSpaceKeys})`;
	}

	return "type=page";
}

async function fetchConfluenceJson<T>(input: {
	baseUrl: string;
	email: string;
	apiToken: string;
	path: string;
}): Promise<T> {
	const response = await fetch(`${input.baseUrl}${input.path}`, {
		headers: buildBasicAuthHeaders(input.email, input.apiToken),
	});

	if (!response.ok) {
		throw new Error(
			`Confluence API error ${response.status} for ${input.path}`,
		);
	}

	return (await response.json()) as T;
}

function convertConfluenceXhtmlToMarkdown(xhtml: string): string {
	let md = xhtml;

	md = md.replace(/<\?xml[^>]*\?>/g, "");
	md = md.replace(/xmlns[^=]*="[^"]*"/g, "");
	md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n");
	md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n");
	md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n");
	md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, "#### $1\n");
	md = md.replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n");
	md = md.replace(/<br\s*\/?>/gi, "\n");
	md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");
	md = md.replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**");
	md = md.replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**");
	md = md.replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*");
	md = md.replace(/<i[^>]*>(.*?)<\/i>/gi, "*$1*");
	md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`");
	md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)");
	md = md.replace(/<[^>]+>/g, "");
	md = md.replace(/&nbsp;/g, " ");
	md = md.replace(/&amp;/g, "&");
	md = md.replace(/&lt;/g, "<");
	md = md.replace(/&gt;/g, ">");
	md = md.replace(/&quot;/g, '"');
	md = md.replace(/\n{3,}/g, "\n\n");
	return md.trim();
}

function buildConfluencePageDocument(params: {
	baseUrl: string;
	page: {
		id: string;
		title?: string;
		body?: {
			storage?: { value?: string };
			view?: { value?: string };
		};
		version?: { when?: string; number?: number };
		space?: { key?: string; name?: string };
		_links?: { webui?: string; self?: string };
	};
}): Document {
	const title = params.page.title ?? `Confluence Page ${params.page.id}`;
	const rawContent =
		params.page.body?.storage?.value ?? params.page.body?.view?.value ?? "";
	const content = convertConfluenceXhtmlToMarkdown(rawContent);
	const webPath = params.page._links?.webui;
	const url = webPath
		? `${params.baseUrl}${webPath.startsWith("/") ? webPath : `/${webPath}`}`
		: `${params.baseUrl}/wiki/pages/viewpage.action?pageId=${params.page.id}`;
	const updatedAt = params.page.version?.when ?? null;
	const versionNumber = params.page.version?.number ?? null;

	return {
		id: `confluence-page-${params.page.id}`,
		externalId: `confluence:page:${params.page.id}`,
		title,
		content: `# ${title}\n\n${content || "(Content could not be extracted)"}`,
		contentHash:
			updatedAt && versionNumber
				? `${updatedAt}:${versionNumber}`
				: versionNumber
					? `${versionNumber}`
					: undefined,
		metadata: {
			resourceType: "page",
			pageId: params.page.id,
			spaceKey: params.page.space?.key ?? null,
			spaceName: params.page.space?.name ?? null,
			url,
			updatedAt,
			version: versionNumber,
		},
		sizeBytes: Buffer.byteLength(rawContent, "utf8"),
		textLength: content.length,
	};
}

async function fetchNotionJson<T>(input: {
	token: string;
	path: string;
	method?: "GET" | "POST";
	body?: Record<string, unknown>;
}): Promise<T> {
	const response = await fetch(`https://api.notion.com/v1/${input.path}`, {
		method: input.method ?? "GET",
		headers: {
			Authorization: `Bearer ${input.token}`,
			"Content-Type": "application/json",
			"Notion-Version": "2022-06-28",
		},
		...(input.body ? { body: JSON.stringify(input.body) } : {}),
	});

	if (!response.ok) {
		throw new Error(
			`Notion API error ${response.status} for ${input.path}`,
		);
	}

	return (await response.json()) as T;
}

function extractNotionRichText(
	richText: Array<{ plain_text?: string }> | undefined,
): string {
	return (richText ?? [])
		.map((entry) => entry.plain_text ?? "")
		.join("")
		.trim();
}

function getNotionPageTitle(page: {
	id: string;
	properties?: Record<string, unknown>;
}): string {
	const properties = page.properties ?? {};
	for (const value of Object.values(properties)) {
		if (
			value &&
			typeof value === "object" &&
			"title" in value &&
			Array.isArray((value as { title?: unknown[] }).title)
		) {
			const title = extractNotionRichText(
				(value as { title?: Array<{ plain_text?: string }> }).title,
			);
			if (title) {
				return title;
			}
		}
	}

	return `Notion Page ${page.id}`;
}

function parseNotionBlocks(
	blocks: Array<Record<string, unknown>>,
	level = 0,
): string {
	const parts: string[] = [];

	for (const block of blocks) {
		const blockType =
			typeof block.type === "string" ? block.type : "unsupported";
		const payload =
			block[blockType] && typeof block[blockType] === "object"
				? (block[blockType] as Record<string, unknown>)
				: {};
		const richText = Array.isArray(payload.rich_text)
			? (payload.rich_text as Array<{ plain_text?: string }>)
			: [];
		const text = extractNotionRichText(richText);

		switch (blockType) {
			case "heading_1":
				parts.push(`# ${text}`);
				break;
			case "heading_2":
				parts.push(`## ${text}`);
				break;
			case "heading_3":
				parts.push(`### ${text}`);
				break;
			case "bulleted_list_item":
				parts.push(`${"  ".repeat(level)}- ${text}`);
				break;
			case "numbered_list_item":
				parts.push(`${"  ".repeat(level)}1. ${text}`);
				break;
			case "to_do":
				parts.push(
					`${"  ".repeat(level)}- [${payload.checked ? "x" : " "}] ${text}`,
				);
				break;
			case "code":
				parts.push(`\`\`\`\n${text}\n\`\`\``);
				break;
			case "quote":
				parts.push(`> ${text}`);
				break;
			case "callout":
				parts.push(`> ${text}`);
				break;
			default:
				if (text) {
					parts.push(text);
				}
				break;
		}

		if (Array.isArray(block.children) && block.children.length > 0) {
			parts.push(parseNotionBlocks(block.children, level + 1));
		}
	}

	return parts.filter(Boolean).join("\n\n");
}

async function fetchNotionBlockChildren(input: {
	token: string;
	blockId: string;
}): Promise<Array<Record<string, unknown>>> {
	const collected: Array<Record<string, unknown>> = [];
	let nextCursor: string | undefined;

	do {
		const data = await fetchNotionJson<{
			results?: Array<Record<string, unknown>>;
			next_cursor?: string | null;
			has_more?: boolean;
		}>({
			token: input.token,
			path: `blocks/${input.blockId}/children${nextCursor ? `?start_cursor=${encodeURIComponent(nextCursor)}&page_size=100` : "?page_size=100"}`,
		});

		for (const block of data.results ?? []) {
			const blockWithChildren = { ...block } as Record<
				string,
				unknown
			> & {
				has_children?: boolean;
				id?: string;
			};
			if (
				blockWithChildren.has_children &&
				typeof blockWithChildren.id === "string"
			) {
				blockWithChildren.children = await fetchNotionBlockChildren({
					token: input.token,
					blockId: blockWithChildren.id,
				});
			}
			collected.push(blockWithChildren);
		}

		nextCursor = data.has_more
			? (data.next_cursor ?? undefined)
			: undefined;
	} while (nextCursor);

	return collected;
}

async function fetchGoogleDriveJson<T>(input: {
	token: string;
	path: string;
	query?: Record<string, string>;
}): Promise<T> {
	const queryString = input.query
		? `?${new URLSearchParams(input.query).toString()}`
		: "";
	const response = await fetch(
		`https://www.googleapis.com/drive/v3/${input.path}${queryString}`,
		{
			headers: {
				Authorization: `Bearer ${input.token}`,
				Accept: "application/json",
			},
		},
	);

	if (!response.ok) {
		throw new Error(
			`Google Drive API error ${response.status} for ${input.path}`,
		);
	}

	return (await response.json()) as T;
}

async function fetchGoogleDriveText(input: {
	token: string;
	fileId: string;
	mimeType: string;
}): Promise<string> {
	const exportMimeType =
		input.mimeType === "application/vnd.google-apps.document"
			? "text/plain"
			: input.mimeType === "application/vnd.google-apps.spreadsheet"
				? "text/csv"
				: input.mimeType === "application/vnd.google-apps.presentation"
					? "text/plain"
					: null;

	const url = exportMimeType
		? `https://www.googleapis.com/drive/v3/files/${input.fileId}/export?mimeType=${encodeURIComponent(exportMimeType)}`
		: `https://www.googleapis.com/drive/v3/files/${input.fileId}?alt=media`;

	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${input.token}`,
		},
	});

	if (!response.ok) {
		throw new Error(
			`Google Drive content fetch error ${response.status} for ${input.fileId}`,
		);
	}

	return response.text();
}

async function fetchDropboxJson<T>(input: {
	token: string;
	path: string;
	body?: Record<string, unknown>;
}): Promise<T> {
	const response = await fetch(`https://api.dropboxapi.com/2/${input.path}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${input.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(input.body ?? {}),
	});

	if (!response.ok) {
		throw new Error(
			`Dropbox API error ${response.status} for ${input.path}`,
		);
	}

	return (await response.json()) as T;
}

async function fetchDropboxText(input: {
	token: string;
	pathLower: string;
}): Promise<string> {
	const response = await fetch(
		"https://content.dropboxapi.com/2/files/download",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${input.token}`,
				"Dropbox-API-Arg": JSON.stringify({
					path: input.pathLower,
				}),
			},
		},
	);

	if (!response.ok) {
		throw new Error(
			`Dropbox content fetch error ${response.status} for ${input.pathLower}`,
		);
	}

	return response.text();
}

async function fetchAirtableJson<T>(input: {
	token: string;
	path: string;
	query?: Record<string, string>;
}): Promise<T> {
	const queryString = input.query
		? `?${new URLSearchParams(input.query).toString()}`
		: "";
	const response = await fetch(
		`https://api.airtable.com/v0/${input.path}${queryString}`,
		{
			headers: {
				Authorization: `Bearer ${input.token}`,
				Accept: "application/json",
			},
		},
	);

	if (!response.ok) {
		throw new Error(
			`Airtable API error ${response.status} for ${input.path}`,
		);
	}

	return (await response.json()) as T;
}

function createS3Client(input: {
	config: S3SyncConfig;
	credentials: ConnectorCredentials;
}): S3Client {
	const secretAccessKey =
		input.credentials.apiKey ?? input.credentials.accessToken;
	const credentialConfig = (input.credentials.providerConfig ??
		{}) as S3SyncConfig;
	const accessKeyId =
		typeof input.config.accessKeyId === "string"
			? input.config.accessKeyId
			: typeof credentialConfig.accessKeyId === "string"
				? credentialConfig.accessKeyId
				: undefined;

	if (!secretAccessKey) {
		throw new Error("S3 secret access key is required");
	}
	if (!accessKeyId) {
		throw new Error("S3 accessKeyId is required in config");
	}

	return new S3Client({
		region: input.config.region ?? credentialConfig.region ?? "us-east-1",
		...((input.config.endpoint ?? credentialConfig.endpoint)
			? { endpoint: input.config.endpoint ?? credentialConfig.endpoint }
			: {}),
		...(typeof (
			input.config.forcePathStyle ?? credentialConfig.forcePathStyle
		) === "boolean"
			? {
					forcePathStyle:
						input.config.forcePathStyle ??
						credentialConfig.forcePathStyle,
				}
			: {}),
		credentials: {
			accessKeyId,
			secretAccessKey,
		},
	});
}

function getStorageSyncConfig(
	providerConfig: Record<string, unknown> | undefined,
	credentials: ConnectorCredentials,
): S3SyncConfig {
	return {
		...((credentials.providerConfig ?? {}) as S3SyncConfig),
		...((providerConfig ?? {}) as S3SyncConfig),
	};
}

function getStorageProviderDetails(provider: "S3" | "GOOGLE_STORAGE" | "R2") {
	switch (provider) {
		case "GOOGLE_STORAGE":
			return {
				resourceType: "google-storage-object",
				externalPrefix: "google-storage:object",
				defaultUrlPrefix: "gs://",
				updatedProvider: "GOOGLE_STORAGE" as const,
				emptyDecodeMessage: "Google Storage object",
			};
		case "R2":
			return {
				resourceType: "r2-object",
				externalPrefix: "r2:object",
				defaultUrlPrefix: "r2://",
				updatedProvider: "R2" as const,
				emptyDecodeMessage: "R2 object",
			};
		default:
			return {
				resourceType: "s3-object",
				externalPrefix: "s3:object",
				defaultUrlPrefix: "s3://",
				updatedProvider: "S3" as const,
				emptyDecodeMessage: "S3 object",
			};
	}
}

async function fetchCodaJson<T>(input: {
	token: string;
	path: string;
	query?: Record<string, string>;
}): Promise<T> {
	const queryString = input.query
		? `?${new URLSearchParams(input.query).toString()}`
		: "";
	const response = await fetch(
		`https://coda.io/apis/v1/${input.path}${queryString}`,
		{
			headers: {
				Authorization: `Bearer ${input.token}`,
				Accept: "application/json",
			},
		},
	);

	if (!response.ok) {
		throw new Error(`Coda API error ${response.status} for ${input.path}`);
	}

	return (await response.json()) as T;
}

async function fetchGitBookJson<T>(input: {
	token: string;
	path: string;
	query?: Record<string, string>;
}): Promise<T> {
	const queryString = input.query
		? `?${new URLSearchParams(input.query).toString()}`
		: "";
	const response = await fetch(
		`https://api.gitbook.com/v1/${input.path}${queryString}`,
		{
			headers: {
				Authorization: `Bearer ${input.token}`,
				"Content-Type": "application/json",
			},
		},
	);

	if (!response.ok) {
		throw new Error(
			`GitBook API error ${response.status} for ${input.path}`,
		);
	}

	return (await response.json()) as T;
}

function extractGitBookText(document: Record<string, unknown>): string {
	const root =
		document.document && typeof document.document === "object"
			? (document.document as Record<string, unknown>)
			: null;
	const nodes = Array.isArray(root?.nodes)
		? (root?.nodes as Array<Record<string, unknown>>)
		: [];
	const parts: string[] = [];

	const extractLeaves = (node: Record<string, unknown>): string => {
		if (Array.isArray(node.leaves)) {
			return (node.leaves as Array<{ text?: string }>)
				.map((leaf) => leaf.text ?? "")
				.join("");
		}
		if (Array.isArray(node.nodes)) {
			return (node.nodes as Array<Record<string, unknown>>)
				.map(extractLeaves)
				.join("");
		}
		return "";
	};

	for (const node of nodes) {
		const type = typeof node.type === "string" ? node.type : "paragraph";
		const text = Array.isArray(node.nodes)
			? (node.nodes as Array<Record<string, unknown>>)
					.map(extractLeaves)
					.join("")
			: "";

		switch (type) {
			case "heading-1":
				parts.push(`# ${text}`);
				break;
			case "heading-2":
				parts.push(`## ${text}`);
				break;
			case "heading-3":
				parts.push(`### ${text}`);
				break;
			case "blockquote":
				parts.push(`> ${text}`);
				break;
			case "list-unordered":
				if (Array.isArray(node.nodes)) {
					for (const listItem of node.nodes as Array<
						Record<string, unknown>
					>) {
						const itemText = Array.isArray(listItem.nodes)
							? (listItem.nodes as Array<Record<string, unknown>>)
									.map(extractLeaves)
									.join("")
							: "";
						parts.push(`- ${itemText}`);
					}
				}
				break;
			default:
				if (text.trim()) {
					parts.push(text);
				}
				break;
		}
	}

	return parts.join("\n\n").trim();
}

async function fetchMicrosoftGraphJson<T>(input: {
	token: string;
	path: string;
	query?: Record<string, string>;
}): Promise<T> {
	const queryString = input.query
		? `?${new URLSearchParams(input.query).toString()}`
		: "";
	const response = await fetch(
		`https://graph.microsoft.com/v1.0/${input.path}${queryString}`,
		{
			headers: {
				Authorization: `Bearer ${input.token}`,
				Accept: "application/json",
			},
		},
	);

	if (!response.ok) {
		throw new Error(
			`Microsoft Graph API error ${response.status} for ${input.path}`,
		);
	}

	return (await response.json()) as T;
}

async function fetchMicrosoftGraphCollection<T>(input: {
	token: string;
	path: string;
	query?: Record<string, string>;
}): Promise<T[]> {
	const items: T[] = [];
	let nextUrl: string | null =
		`https://graph.microsoft.com/v1.0/${input.path}${
			input.query ? `?${new URLSearchParams(input.query).toString()}` : ""
		}`;

	while (nextUrl) {
		const response = await fetch(nextUrl, {
			headers: {
				Authorization: `Bearer ${input.token}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			throw new Error(
				`Microsoft Graph API error ${response.status} for ${nextUrl}`,
			);
		}

		const data = (await response.json()) as {
			value?: T[];
			"@odata.nextLink"?: string;
		};

		items.push(...(data.value ?? []));
		nextUrl = data["@odata.nextLink"] ?? null;
	}

	return items;
}

async function fetchMicrosoftGraphText(input: {
	token: string;
	driveId: string;
	itemId: string;
}): Promise<string> {
	const response = await fetch(
		`https://graph.microsoft.com/v1.0/drives/${input.driveId}/items/${input.itemId}/content`,
		{
			headers: {
				Authorization: `Bearer ${input.token}`,
			},
		},
	);

	if (!response.ok) {
		throw new Error(
			`Microsoft Graph content fetch error ${response.status} for ${input.itemId}`,
		);
	}

	return response.text();
}

async function fetchGmailJson<T>(input: {
	token: string;
	path: string;
	query?: Record<string, string>;
}): Promise<T> {
	const queryString = input.query
		? `?${new URLSearchParams(input.query).toString()}`
		: "";
	const response = await fetch(
		`https://gmail.googleapis.com/gmail/v1/users/me/${input.path}${queryString}`,
		{
			headers: {
				Authorization: `Bearer ${input.token}`,
				Accept: "application/json",
			},
		},
	);

	if (!response.ok) {
		throw new Error(`Gmail API error ${response.status} for ${input.path}`);
	}

	return (await response.json()) as T;
}

function decodeGmailBody(data?: string | null): string {
	if (!data) {
		return "";
	}

	try {
		return Buffer.from(data, "base64url").toString("utf8");
	} catch {
		return "";
	}
}

interface GmailPayloadPart {
	mimeType?: string;
	body?: { data?: string };
	parts?: Array<GmailPayloadPart | Record<string, unknown>>;
}

function extractGmailBody(payload?: GmailPayloadPart): string {
	if (!payload) {
		return "";
	}

	if (payload.mimeType === "text/plain") {
		const plainText = decodeGmailBody(payload.body?.data);
		if (plainText.trim()) {
			return plainText.trim();
		}
	}

	for (const part of payload.parts ?? []) {
		const nested = extractGmailBody(part);
		if (nested.trim()) {
			return nested.trim();
		}
	}

	return "";
}

function getGmailHeader(
	headers: Array<{ name?: string; value?: string }> | undefined,
	name: string,
): string | null {
	const match = headers?.find(
		(header) => header.name?.toLowerCase() === name.toLowerCase(),
	);
	return match?.value ?? null;
}

export async function testGoogleDriveConnection(
	credentials: ConnectorCredentials,
) {
	if (!credentials.accessToken) {
		return false;
	}

	const response = await fetch(
		"https://www.googleapis.com/drive/v3/about?fields=user",
		{
			headers: {
				Authorization: `Bearer ${credentials.accessToken}`,
			},
		},
	);
	return response.ok;
}

export async function testNotionConnection(credentials: ConnectorCredentials) {
	if (!credentials.accessToken) {
		return false;
	}

	const response = await fetch("https://api.notion.com/v1/users/me", {
		headers: {
			Authorization: `Bearer ${credentials.accessToken}`,
			"Notion-Version": "2022-06-28",
		},
	});
	return response.ok;
}

export async function testConfluenceConnection(
	credentials: ConnectorCredentials,
) {
	if (
		typeof credentials.domain !== "string" ||
		typeof credentials.email !== "string" ||
		typeof credentials.apiToken !== "string"
	) {
		return false;
	}

	const response = await fetch(
		`${normalizeHttpsBaseUrl(credentials.domain)}/wiki/rest/api/user/current`,
		{
			headers: buildBasicAuthHeaders(
				credentials.email,
				credentials.apiToken,
			),
		},
	);
	return response.ok;
}

export async function testMicrosoftConnection(
	credentials: ConnectorCredentials,
) {
	if (!credentials.accessToken) {
		return false;
	}

	const response = await fetch(
		"https://graph.microsoft.com/v1.0/me/drive/root",
		{
			headers: {
				Authorization: `Bearer ${credentials.accessToken}`,
			},
		},
	);
	return response.ok;
}

export async function testTeamsConnection(credentials: ConnectorCredentials) {
	if (!credentials.accessToken) {
		return false;
	}

	const response = await fetch(
		"https://graph.microsoft.com/v1.0/me/joinedTeams?$top=1",
		{
			headers: {
				Authorization: `Bearer ${credentials.accessToken}`,
				Accept: "application/json",
			},
		},
	);
	return response.ok;
}

export async function discoverConfluenceResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const domain =
		typeof input.credentials.domain === "string"
			? input.credentials.domain
			: null;
	const email =
		typeof input.credentials.email === "string"
			? input.credentials.email
			: null;
	const apiToken =
		typeof input.credentials.apiToken === "string"
			? input.credentials.apiToken
			: null;

	if (!domain || !email || !apiToken) {
		throw new Error("Confluence domain, email, and API token are required");
	}

	const baseUrl = normalizeHttpsBaseUrl(domain);
	const confluenceConfig = input.providerConfig as ConfluenceSyncConfig;

	if (confluenceConfig.pageIds && confluenceConfig.pageIds.length > 0) {
		return confluenceConfig.pageIds.map((pageId) => ({
			id: pageId,
			name: `Confluence page ${pageId}`,
			type: "confluence-page",
			path: `${baseUrl}/wiki/pages/viewpage.action?pageId=${pageId}`,
			metadata: { pageId },
		}));
	}

	const cql = buildConfluenceSearchCql(confluenceConfig);
	const limit = 100;
	let start = 0;
	const resources: Resource[] = [];

	while (true) {
		const data = await fetchConfluenceJson<{
			results?: Array<{
				id: string;
				title?: string;
				_links?: { webui?: string };
				space?: { key?: string; name?: string };
			}>;
		}>({
			baseUrl,
			email,
			apiToken,
			path: `/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&start=${start}`,
		});

		const results = data.results ?? [];
		for (const page of results) {
			resources.push({
				id: page.id,
				name: page.title ?? `Confluence page ${page.id}`,
				type: "confluence-page",
				path: page._links?.webui
					? `${baseUrl}${page._links.webui.startsWith("/") ? page._links.webui : `/${page._links.webui}`}`
					: `${baseUrl}/wiki/pages/viewpage.action?pageId=${page.id}`,
				metadata: {
					pageId: page.id,
					spaceKey: page.space?.key ?? null,
					spaceName: page.space?.name ?? null,
				},
			});
		}

		if (results.length < limit) {
			break;
		}
		start += results.length;
	}

	return resources;
}

export async function discoverNotionResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token = input.credentials.accessToken;
	if (!token) {
		throw new Error("Notion access token is required");
	}

	const notionConfig = input.providerConfig as NotionSyncConfig;
	if (notionConfig.includePages === false) {
		return [];
	}

	if (notionConfig.pageIds && notionConfig.pageIds.length > 0) {
		return notionConfig.pageIds.map((pageId) => ({
			id: pageId,
			name: `Notion page ${pageId}`,
			type: "notion-page",
			path: `https://www.notion.so/${pageId.replace(/-/g, "")}`,
			metadata: { pageId },
		}));
	}

	const resources: Resource[] = [];
	let nextCursor: string | undefined;

	do {
		const data = await fetchNotionJson<{
			results?: Array<{
				id: string;
				url?: string;
				properties?: Record<string, unknown>;
				object?: string;
			}>;
			next_cursor?: string | null;
			has_more?: boolean;
		}>({
			token,
			path: "search",
			method: "POST",
			body: {
				page_size: 100,
				filter: { value: "page", property: "object" },
				...(nextCursor ? { start_cursor: nextCursor } : {}),
			},
		});

		for (const page of data.results ?? []) {
			if (page.object !== "page") {
				continue;
			}
			resources.push({
				id: page.id,
				name: getNotionPageTitle(page),
				type: "notion-page",
				path:
					page.url ??
					`https://www.notion.so/${page.id.replace(/-/g, "")}`,
				metadata: { pageId: page.id },
			});
		}

		nextCursor = data.has_more
			? (data.next_cursor ?? undefined)
			: undefined;
	} while (nextCursor);

	return resources;
}

export async function discoverGoogleDriveResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token = input.credentials.accessToken;
	if (!token) {
		throw new Error("Google Drive access token is required");
	}

	const driveConfig = input.providerConfig as GoogleDriveSyncConfig;
	if (driveConfig.fileIds && driveConfig.fileIds.length > 0) {
		return driveConfig.fileIds.map((fileId) => ({
			id: fileId,
			name: `Drive file ${fileId}`,
			type: "google-drive-file",
			path: `https://drive.google.com/file/d/${fileId}/view`,
			metadata: { fileId },
		}));
	}

	const queryParts = ["trashed = false"];
	if (driveConfig.folderIds && driveConfig.folderIds.length > 0) {
		const folderClauses = driveConfig.folderIds.map(
			(folderId) => `'${folderId}' in parents`,
		);
		queryParts.push(`(${folderClauses.join(" or ")})`);
	}
	if (driveConfig.includeSharedWithMe) {
		queryParts.push("sharedWithMe = true");
	}

	const files = await fetchGoogleDriveJson<{
		files?: Array<{
			id: string;
			name: string;
			mimeType?: string;
			webViewLink?: string;
			modifiedTime?: string;
			size?: string;
			parents?: string[];
		}>;
	}>({
		token,
		path: "files",
		query: {
			fields: "files(id,name,mimeType,webViewLink,modifiedTime,size,parents)",
			pageSize: "100",
			includeItemsFromAllDrives: driveConfig.includeSharedDrives
				? "true"
				: "false",
			supportsAllDrives: driveConfig.includeSharedDrives
				? "true"
				: "false",
			q: queryParts.join(" and "),
		},
	});

	return (files.files ?? []).map((file) => ({
		id: file.id,
		name: file.name,
		type: "google-drive-file",
		path: file.webViewLink,
		metadata: {
			fileId: file.id,
			mimeType: file.mimeType ?? null,
			modifiedTime: file.modifiedTime ?? null,
			size: file.size ? Number.parseInt(file.size, 10) : null,
			parentIds: file.parents ?? [],
		},
	}));
}

export async function discoverDropboxResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token = input.credentials.accessToken ?? input.credentials.apiKey;
	if (!token) {
		throw new Error("Dropbox access token is required");
	}

	const dropboxConfig = input.providerConfig as DropboxSyncConfig;
	const configuredPaths =
		dropboxConfig.paths?.filter((path) => path.trim().length > 0) ?? [];
	const resources: Resource[] = [];

	const listFolder = async (path: string) => {
		const data = await fetchDropboxJson<{
			entries?: Array<{
				".tag": "file" | "folder";
				id: string;
				name: string;
				path_lower?: string;
				path_display?: string;
				server_modified?: string;
				size?: number;
				is_downloadable?: boolean;
			}>;
		}>({
			token,
			path: "files/list_folder",
			body: {
				path,
				recursive: false,
				include_deleted: false,
			},
		});

		for (const entry of data.entries ?? []) {
			if (entry[".tag"] !== "file") {
				continue;
			}

			resources.push({
				id: entry.id,
				name: entry.name,
				type: "dropbox-file",
				path: entry.path_display,
				metadata: {
					pathLower: entry.path_lower ?? null,
					pathDisplay: entry.path_display ?? null,
					serverModified: entry.server_modified ?? null,
					size: entry.size ?? null,
					isDownloadable: entry.is_downloadable ?? true,
				},
			});
		}
	};

	if (configuredPaths.length > 0) {
		for (const path of configuredPaths) {
			await listFolder(path);
		}
		return resources;
	}

	await listFolder("");
	return resources;
}

export async function testS3Connection(
	credentials: ConnectorCredentials,
): Promise<boolean> {
	const config = getStorageSyncConfig(undefined, credentials);
	const bucket = typeof config.bucket === "string" ? config.bucket : null;
	if (!bucket) {
		return false;
	}

	const client = createS3Client({
		config,
		credentials,
	});

	await client.send(
		new ListObjectsV2Command({
			Bucket: bucket,
			Prefix:
				typeof config.prefix === "string" ? config.prefix : undefined,
			MaxKeys: 1,
		}),
	);
	return true;
}

export async function testGoogleStorageConnection(
	credentials: ConnectorCredentials,
): Promise<boolean> {
	return testS3Connection({
		...credentials,
		providerConfig: {
			endpoint: "https://storage.googleapis.com",
			forcePathStyle: true,
			region: "auto",
			...(credentials.providerConfig ?? {}),
		},
	});
}

export async function testR2Connection(
	credentials: ConnectorCredentials,
): Promise<boolean> {
	return testS3Connection(credentials);
}

export async function discoverS3Resources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const config = getStorageSyncConfig(
		input.providerConfig,
		input.credentials,
	);
	const bucket = typeof config.bucket === "string" ? config.bucket : null;
	if (!bucket) {
		throw new Error("S3 bucket is required");
	}

	const client = createS3Client({
		config,
		credentials: input.credentials,
	});

	const resources: Resource[] = [];
	let continuationToken: string | undefined;

	do {
		const result = await client.send(
			new ListObjectsV2Command({
				Bucket: bucket,
				Prefix:
					typeof config.prefix === "string"
						? config.prefix
						: undefined,
				ContinuationToken: continuationToken,
				MaxKeys: 1000,
			}),
		);

		for (const object of result.Contents ?? []) {
			const key = object.Key;
			if (!key || key.endsWith("/")) {
				continue;
			}

			resources.push({
				id: `s3:${bucket}:${key}`,
				name: key.split("/").pop() ?? key,
				type: "s3-object",
				path: `s3://${bucket}/${key}`,
				metadata: {
					bucket,
					key,
					eTag: object.ETag ?? null,
					lastModified: object.LastModified?.toISOString() ?? null,
					size: object.Size ?? null,
					storageClass: object.StorageClass ?? null,
				},
			});
		}

		continuationToken = result.IsTruncated
			? result.NextContinuationToken
			: undefined;
	} while (continuationToken);

	return resources;
}

async function discoverStorageResources(input: {
	provider: "S3" | "GOOGLE_STORAGE" | "R2";
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const config = getStorageSyncConfig(
		input.providerConfig,
		input.credentials,
	);
	const bucket = typeof config.bucket === "string" ? config.bucket : null;
	if (!bucket) {
		throw new Error(`${input.provider} bucket is required`);
	}

	const client = createS3Client({
		config,
		credentials: input.credentials,
	});
	const details = getStorageProviderDetails(input.provider);
	const resources: Resource[] = [];
	let continuationToken: string | undefined;

	do {
		const result = await client.send(
			new ListObjectsV2Command({
				Bucket: bucket,
				Prefix:
					typeof config.prefix === "string"
						? config.prefix
						: undefined,
				ContinuationToken: continuationToken,
				MaxKeys: 1000,
			}),
		);

		for (const object of result.Contents ?? []) {
			const key = object.Key;
			if (!key || key.endsWith("/")) {
				continue;
			}

			resources.push({
				id: `${input.provider.toLowerCase()}:${bucket}:${key}`,
				name: key.split("/").pop() ?? key,
				type: details.resourceType,
				path: `${details.defaultUrlPrefix}${bucket}/${key}`,
				metadata: {
					bucket,
					key,
					eTag: object.ETag ?? null,
					lastModified: object.LastModified?.toISOString() ?? null,
					size: object.Size ?? null,
					storageClass: object.StorageClass ?? null,
				},
			});
		}

		continuationToken = result.IsTruncated
			? result.NextContinuationToken
			: undefined;
	} while (continuationToken);

	return resources;
}

export async function discoverGoogleStorageResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	return discoverStorageResources({
		provider: "GOOGLE_STORAGE",
		credentials: input.credentials,
		providerConfig: {
			endpoint: "https://storage.googleapis.com",
			forcePathStyle: true,
			region: "auto",
			...input.providerConfig,
		},
	});
}

export async function discoverR2Resources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	return discoverStorageResources({
		provider: "R2",
		credentials: input.credentials,
		providerConfig: input.providerConfig,
	});
}

export async function testAirtableConnection(
	credentials: ConnectorCredentials,
): Promise<boolean> {
	const token = credentials.accessToken ?? credentials.apiKey;
	const config = (credentials.providerConfig ?? {}) as AirtableSyncConfig;
	const baseId = typeof config.baseId === "string" ? config.baseId : null;
	if (!token || !baseId) {
		return false;
	}

	await fetchAirtableJson({
		token,
		path: `meta/bases/${baseId}/tables`,
	});
	return true;
}

export async function discoverAirtableResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token = input.credentials.accessToken ?? input.credentials.apiKey;
	if (!token) {
		throw new Error("Airtable API token is required");
	}

	const airtableConfig = input.providerConfig as AirtableSyncConfig;
	const baseId =
		typeof airtableConfig.baseId === "string"
			? airtableConfig.baseId
			: null;
	if (!baseId) {
		throw new Error("Airtable baseId is required");
	}

	const data = await fetchAirtableJson<{
		tables?: Array<{
			id: string;
			name: string;
			description?: string;
			fields?: Array<{ id: string; name: string; type?: string }>;
			views?: Array<{ id: string; name: string }>;
		}>;
	}>({
		token,
		path: `meta/bases/${baseId}/tables`,
	});

	const configuredTableIds = new Set(airtableConfig.tableIds ?? []);

	return (data.tables ?? [])
		.filter((table) =>
			configuredTableIds.size > 0
				? configuredTableIds.has(table.id)
				: true,
		)
		.map((table) => ({
			id: `airtable:table:${baseId}:${table.id}`,
			name: table.name,
			type: "airtable-table",
			path: `https://airtable.com/${baseId}/${table.id}`,
			metadata: {
				baseId,
				tableId: table.id,
				description: table.description ?? null,
				fieldNames: (table.fields ?? []).map((field) => field.name),
				viewIds: (table.views ?? []).map((view) => view.id),
				viewName:
					typeof airtableConfig.view === "string"
						? airtableConfig.view
						: null,
			},
		}));
}

export async function discoverCodaResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token = input.credentials.accessToken ?? input.credentials.apiKey;
	if (!token) {
		throw new Error("Coda API token is required");
	}

	const codaConfig = input.providerConfig as CodaSyncConfig;
	const resources: Resource[] = [];
	const configuredDocIds = codaConfig.docIds?.filter(Boolean) ?? [];

	let docs: Array<{
		id: string;
		name: string;
		browserLink?: string;
		workspace?: { id?: string; name?: string };
		updatedAt?: string;
	}> = [];

	if (configuredDocIds.length > 0) {
		for (const docId of configuredDocIds) {
			const doc = await fetchCodaJson<{
				id: string;
				name: string;
				browserLink?: string;
				workspace?: { id?: string; name?: string };
				updatedAt?: string;
			}>({
				token,
				path: `docs/${docId}`,
			});
			docs.push(doc);
		}
	} else {
		const data = await fetchCodaJson<{
			items?: Array<{
				id: string;
				name: string;
				browserLink?: string;
				workspace?: { id?: string; name?: string };
				updatedAt?: string;
			}>;
		}>({
			token,
			path: "docs",
			query: codaConfig.workspaceId
				? { workspaceId: codaConfig.workspaceId }
				: undefined,
		});
		docs = data.items ?? [];
	}

	for (const doc of docs) {
		if (codaConfig.includePages === false) {
			resources.push({
				id: `coda-doc:${doc.id}`,
				name: doc.name,
				type: "coda-doc",
				path: doc.browserLink,
				metadata: {
					docId: doc.id,
					workspaceId: doc.workspace?.id ?? null,
					workspaceName: doc.workspace?.name ?? null,
					updatedAt: doc.updatedAt ?? null,
				},
			});
			continue;
		}

		const pages = await fetchCodaJson<{
			items?: Array<{
				id: string;
				name: string;
				browserLink?: string;
				contentType?: string;
				updatedAt?: string;
				isHidden?: boolean;
			}>;
		}>({
			token,
			path: `docs/${doc.id}/pages`,
		});

		for (const page of pages.items ?? []) {
			if (page.isHidden) {
				continue;
			}
			resources.push({
				id: `coda-page:${doc.id}:${page.id}`,
				name: `${doc.name} / ${page.name}`,
				type: "coda-page",
				path: page.browserLink ?? doc.browserLink,
				metadata: {
					docId: doc.id,
					docName: doc.name,
					pageId: page.id,
					contentType: page.contentType ?? null,
					workspaceId: doc.workspace?.id ?? null,
					workspaceName: doc.workspace?.name ?? null,
					updatedAt: page.updatedAt ?? doc.updatedAt ?? null,
				},
			});
		}
	}

	return resources;
}

export async function discoverGitBookResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token = input.credentials.accessToken ?? input.credentials.apiKey;
	if (!token) {
		throw new Error("GitBook API token is required");
	}

	const gitbookConfig = input.providerConfig as GitBookSyncConfig;
	if (!gitbookConfig.spaceId) {
		throw new Error("GitBook spaceId is required");
	}

	const data = await fetchGitBookJson<{
		pages?: Array<{
			id: string;
			title?: string;
			path?: string;
			type?: string;
			kind?: string;
			updatedAt?: string;
			urls?: { app?: string };
		}>;
	}>({
		token,
		path: `spaces/${gitbookConfig.spaceId}/content/pages`,
	});

	return (data.pages ?? []).map((page) => ({
		id: `gitbook-page:${gitbookConfig.spaceId}:${page.id}`,
		name: page.title ?? `GitBook Page ${page.id}`,
		type: "gitbook-page",
		path: page.urls?.app,
		metadata: {
			spaceId: gitbookConfig.spaceId,
			pageId: page.id,
			path: page.path ?? null,
			pageType: page.type ?? null,
			pageKind: page.kind ?? null,
			updatedAt: page.updatedAt ?? null,
		},
	}));
}

export async function discoverMicrosoftResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token = input.credentials.accessToken;
	if (!token) {
		throw new Error("Microsoft access token is required");
	}

	const microsoftConfig = input.providerConfig as MicrosoftSyncConfig;
	const resources: Resource[] = [];
	const includeOneDrive = microsoftConfig.includeOneDrive !== false;
	const includeSharePoint = microsoftConfig.includeSharePoint === true;

	if (includeOneDrive) {
		const oneDriveItems = await fetchMicrosoftGraphCollection<{
			id: string;
			name: string;
			webUrl?: string;
			lastModifiedDateTime?: string;
			size?: number;
			file?: { mimeType?: string };
			parentReference?: { driveId?: string; path?: string };
		}>({
			token,
			path: "me/drive/root/children",
			query: {
				$top: "100",
				$select:
					"id,name,webUrl,lastModifiedDateTime,size,file,parentReference",
			},
		});

		for (const item of oneDriveItems) {
			if (!item.file?.mimeType) {
				continue;
			}
			resources.push({
				id: `onedrive:${item.id}`,
				name: item.name,
				type: "microsoft-drive-item",
				path: item.webUrl,
				metadata: {
					itemId: item.id,
					driveId: item.parentReference?.driveId ?? "me",
					source: "onedrive",
					mimeType: item.file.mimeType,
					path: item.parentReference?.path ?? null,
					lastModifiedDateTime: item.lastModifiedDateTime ?? null,
					size: item.size ?? null,
				},
			});
		}
	}

	if (includeSharePoint) {
		const allowedSiteIds =
			microsoftConfig.siteIds && microsoftConfig.siteIds.length > 0
				? new Set(microsoftConfig.siteIds)
				: null;

		const sharePointSites = allowedSiteIds
			? await Promise.all(
					[...allowedSiteIds].map((siteId) =>
						fetchMicrosoftGraphJson<{
							id: string;
							name?: string;
							displayName?: string;
							webUrl?: string;
						}>({
							token,
							path: `sites/${siteId}`,
							query: {
								$select: "id,name,displayName,webUrl",
							},
						}),
					),
				)
			: await fetchMicrosoftGraphCollection<{
					id: string;
					name?: string;
					displayName?: string;
					webUrl?: string;
				}>({
					token,
					path: "sites",
					query: {
						search: "*",
						$top: "25",
						$select: "id,name,displayName,webUrl",
					},
				});

		for (const site of sharePointSites) {
			if (allowedSiteIds && !allowedSiteIds.has(site.id)) {
				continue;
			}

			const siteDriveItems = await fetchMicrosoftGraphCollection<{
				id: string;
				name: string;
				webUrl?: string;
				lastModifiedDateTime?: string;
				size?: number;
				file?: { mimeType?: string };
				parentReference?: { driveId?: string; path?: string };
			}>({
				token,
				path: `sites/${site.id}/drive/root/children`,
				query: {
					$top: "100",
					$select:
						"id,name,webUrl,lastModifiedDateTime,size,file,parentReference",
				},
			});

			for (const item of siteDriveItems) {
				if (!item.file?.mimeType) {
					continue;
				}
				resources.push({
					id: `sharepoint:${site.id}:${item.id}`,
					name: item.name,
					type: "microsoft-drive-item",
					path: item.webUrl ?? site.webUrl,
					metadata: {
						itemId: item.id,
						driveId: item.parentReference?.driveId ?? null,
						source: "sharepoint",
						siteId: site.id,
						siteName: site.displayName ?? site.name ?? null,
						mimeType: item.file.mimeType,
						path: item.parentReference?.path ?? null,
						lastModifiedDateTime: item.lastModifiedDateTime ?? null,
						size: item.size ?? null,
					},
				});
			}
		}
	}

	return resources;
}

export async function discoverTeamsResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token = input.credentials.accessToken;
	if (!token) {
		throw new Error("Microsoft Teams access token is required");
	}

	const config = input.providerConfig as TeamsSyncConfig;
	const allowedTeamIds = new Set(
		(config.teamIds ?? []).filter(
			(teamId): teamId is string => typeof teamId === "string",
		),
	);
	const allowedChannelIds = new Set(
		(config.channelIds ?? []).filter(
			(channelId): channelId is string => typeof channelId === "string",
		),
	);

	const teams = await fetchMicrosoftGraphCollection<{
		id: string;
		displayName?: string;
		webUrl?: string;
	}>({
		token,
		path: "me/joinedTeams",
	});

	const resources: Resource[] = [];

	for (const team of teams) {
		if (allowedTeamIds.size > 0 && !allowedTeamIds.has(team.id)) {
			continue;
		}

		const channels = await fetchMicrosoftGraphCollection<{
			id: string;
			displayName?: string;
			webUrl?: string;
			membershipType?: string;
		}>({
			token,
			path: `teams/${team.id}/channels`,
		});

		for (const channel of channels) {
			if (
				allowedChannelIds.size > 0 &&
				!allowedChannelIds.has(channel.id)
			) {
				continue;
			}

			resources.push({
				id: `teams:channel:${team.id}:${channel.id}`,
				name: `${team.displayName ?? "Team"} / ${channel.displayName ?? "Channel"}`,
				type: "teams-channel",
				path: channel.webUrl ?? team.webUrl,
				metadata: {
					teamId: team.id,
					teamName: team.displayName ?? null,
					channelId: channel.id,
					channelName: channel.displayName ?? null,
					membershipType: channel.membershipType ?? null,
				},
			});
		}
	}

	return resources;
}

export async function discoverGmailResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token = input.credentials.accessToken;
	if (!token) {
		throw new Error("Gmail access token is required");
	}

	const gmailConfig = input.providerConfig as GmailSyncConfig;
	const listResponse = await fetchGmailJson<{
		threads?: Array<{ id: string; snippet?: string; historyId?: string }>;
	}>({
		token,
		path: "threads",
		query: {
			maxResults: "100",
			...(gmailConfig.query?.trim()
				? { q: gmailConfig.query.trim() }
				: {}),
			...(gmailConfig.labelIds && gmailConfig.labelIds.length > 0
				? { labelIds: gmailConfig.labelIds.join(",") }
				: {}),
			includeSpamTrash: gmailConfig.includeSpamTrash ? "true" : "false",
		},
	});

	return (listResponse.threads ?? []).map((thread) => ({
		id: `gmail:thread:${thread.id}`,
		name: thread.snippet?.trim() || `Gmail thread ${thread.id}`,
		type: "gmail-thread",
		path: `https://mail.google.com/mail/u/0/#inbox/${thread.id}`,
		metadata: {
			threadId: thread.id,
			historyId: thread.historyId ?? null,
			snippet: thread.snippet ?? null,
		},
	}));
}

export async function fetchConfluenceResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const domain =
		typeof input.credentials.domain === "string"
			? input.credentials.domain
			: null;
	const email =
		typeof input.credentials.email === "string"
			? input.credentials.email
			: null;
	const apiToken =
		typeof input.credentials.apiToken === "string"
			? input.credentials.apiToken
			: null;

	if (!domain || !email || !apiToken) {
		throw new Error("Confluence domain, email, and API token are required");
	}

	const baseUrl = normalizeHttpsBaseUrl(domain);
	const pageId =
		(typeof input.resource.metadata?.pageId === "string" &&
			input.resource.metadata.pageId) ||
		input.resource.id;

	const page = await fetchConfluenceJson<{
		id: string;
		title?: string;
		body?: {
			storage?: { value?: string };
			view?: { value?: string };
		};
		version?: { when?: string; number?: number };
		space?: { key?: string; name?: string };
		_links?: { webui?: string; self?: string };
	}>({
		baseUrl,
		email,
		apiToken,
		path: `/wiki/rest/api/content/${pageId}?expand=body.storage,version,space`,
	});

	const document = buildConfluencePageDocument({
		baseUrl,
		page,
	});
	const updatedAt =
		typeof document.metadata.updatedAt === "string"
			? document.metadata.updatedAt
			: undefined;

	return {
		documents: [document],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "CONFLUENCE",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}

export async function fetchNotionResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token = input.credentials.accessToken;
	if (!token) {
		throw new Error("Notion access token is required");
	}

	const pageId =
		(typeof input.resource.metadata?.pageId === "string" &&
			input.resource.metadata.pageId) ||
		input.resource.id;
	const page = await fetchNotionJson<{
		id: string;
		url?: string;
		last_edited_time?: string;
		properties?: Record<string, unknown>;
	}>({
		token,
		path: `pages/${pageId}`,
	});
	const blocks = await fetchNotionBlockChildren({
		token,
		blockId: pageId,
	});
	const title = getNotionPageTitle(page);
	const content = parseNotionBlocks(blocks);
	const updatedAt = page.last_edited_time;

	return {
		documents: [
			{
				id: `notion-page-${page.id}`,
				externalId: `notion:page:${page.id}`,
				title,
				content: `# ${title}\n\n${content || "(No text content found)"}`,
				contentHash: updatedAt ?? undefined,
				metadata: {
					resourceType: "page",
					pageId: page.id,
					url:
						page.url ??
						`https://www.notion.so/${page.id.replace(/-/g, "")}`,
					updatedAt: updatedAt ?? null,
				},
				sizeBytes: Buffer.byteLength(content, "utf8"),
				textLength: content.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "NOTION",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}

export async function fetchGoogleDriveResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token = input.credentials.accessToken;
	if (!token) {
		throw new Error("Google Drive access token is required");
	}

	const fileId =
		(typeof input.resource.metadata?.fileId === "string" &&
			input.resource.metadata.fileId) ||
		input.resource.id;
	const file = await fetchGoogleDriveJson<{
		id: string;
		name: string;
		mimeType?: string;
		webViewLink?: string;
		description?: string;
		modifiedTime?: string;
		size?: string;
	}>({
		token,
		path: `files/${fileId}`,
		query: {
			fields: "id,name,mimeType,webViewLink,description,modifiedTime,size",
			supportsAllDrives: "true",
		},
	});

	const mimeType = file.mimeType ?? "application/octet-stream";
	const supportsTextDownload =
		mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/xml" ||
		mimeType === "application/vnd.google-apps.document" ||
		mimeType === "application/vnd.google-apps.spreadsheet" ||
		mimeType === "application/vnd.google-apps.presentation";

	const body = supportsTextDownload
		? await fetchGoogleDriveText({
				token,
				fileId,
				mimeType,
			})
		: file.description?.trim()
			? `Description: ${file.description.trim()}`
			: `Google Drive file "${file.name}" (${mimeType}) is connected for search, but its body could not be exported as text.`;

	const updatedAt = file.modifiedTime ?? null;

	return {
		documents: [
			{
				id: `google-drive-file-${file.id}`,
				externalId: `google-drive:file:${file.id}`,
				title: file.name,
				content: `# ${file.name}\n\n${body}`,
				contentHash: updatedAt ?? undefined,
				metadata: {
					resourceType: "file",
					fileId: file.id,
					mimeType,
					url:
						file.webViewLink ??
						`https://drive.google.com/file/d/${file.id}/view`,
					updatedAt,
				},
				sizeBytes: file.size
					? Number.parseInt(file.size, 10)
					: undefined,
				textLength: body.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "GOOGLE_DRIVE",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}

export async function fetchDropboxResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token = input.credentials.accessToken ?? input.credentials.apiKey;
	if (!token) {
		throw new Error("Dropbox access token is required");
	}

	const pathLower =
		typeof input.resource.metadata?.pathLower === "string"
			? input.resource.metadata.pathLower
			: null;
	if (!pathLower) {
		throw new Error("Dropbox file path is required");
	}

	const isDownloadable =
		typeof input.resource.metadata?.isDownloadable === "boolean"
			? input.resource.metadata.isDownloadable
			: true;
	const body = isDownloadable
		? await fetchDropboxText({
				token,
				pathLower,
			})
		: `Dropbox file "${input.resource.name}" is connected for search, but it could not be downloaded as text.`;
	const updatedAt =
		typeof input.resource.metadata?.serverModified === "string"
			? input.resource.metadata.serverModified
			: null;

	return {
		documents: [
			{
				id: `dropbox-file-${input.resource.id}`,
				externalId: `dropbox:file:${input.resource.id}`,
				title: input.resource.name,
				content: `# ${input.resource.name}\n\n${body}`,
				contentHash: updatedAt ?? undefined,
				metadata: {
					resourceType: "file",
					fileId: input.resource.id,
					pathLower,
					pathDisplay:
						typeof input.resource.metadata?.pathDisplay === "string"
							? input.resource.metadata.pathDisplay
							: (input.resource.path ?? null),
					updatedAt,
				},
				sizeBytes:
					typeof input.resource.metadata?.size === "number"
						? input.resource.metadata.size
						: undefined,
				textLength: body.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "DROPBOX",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}

export async function fetchS3ResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	return fetchStorageResourceDocuments({
		provider: "S3",
		...input,
	});
}

async function fetchStorageResourceDocuments(input: {
	provider: "S3" | "GOOGLE_STORAGE" | "R2";
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const bucket =
		typeof input.resource.metadata?.bucket === "string"
			? input.resource.metadata.bucket
			: null;
	const key =
		typeof input.resource.metadata?.key === "string"
			? input.resource.metadata.key
			: null;
	if (!bucket || !key) {
		throw new Error(`${input.provider} bucket and key are required`);
	}

	const client = createS3Client({
		config: getStorageSyncConfig(undefined, input.credentials),
		credentials: input.credentials,
	});

	const response = await client.send(
		new GetObjectCommand({
			Bucket: bucket,
			Key: key,
		}),
	);

	let body = "";
	const details = getStorageProviderDetails(input.provider);
	try {
		body = response.Body ? await response.Body.transformToString() : "";
	} catch {
		body = `${details.emptyDecodeMessage} "${input.resource.name}" is connected for search, but it could not be decoded as text.`;
	}

	if (!body.trim()) {
		body = `${details.emptyDecodeMessage} "${input.resource.name}" is connected for search, but it did not contain extractable text.`;
	}

	const updatedAt =
		typeof input.resource.metadata?.lastModified === "string"
			? input.resource.metadata.lastModified
			: null;

	return {
		documents: [
			{
				id: `${input.provider.toLowerCase()}-object-${bucket}-${key}`,
				externalId: `${details.externalPrefix}:${bucket}:${key}`,
				title: input.resource.name,
				content: `# ${input.resource.name}\n\n${body}`,
				contentHash:
					typeof input.resource.metadata?.eTag === "string"
						? input.resource.metadata.eTag
						: (updatedAt ?? undefined),
				metadata: {
					resourceType: "object",
					bucket,
					key,
					url:
						input.resource.path ??
						`${details.defaultUrlPrefix}${bucket}/${key}`,
					updatedAt,
					storageClass:
						typeof input.resource.metadata?.storageClass ===
						"string"
							? input.resource.metadata.storageClass
							: null,
				},
				sizeBytes:
					typeof input.resource.metadata?.size === "number"
						? input.resource.metadata.size
						: Buffer.byteLength(body, "utf8"),
				textLength: body.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: details.updatedProvider,
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}

export async function fetchGoogleStorageResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	return fetchStorageResourceDocuments({
		provider: "GOOGLE_STORAGE",
		...input,
	});
}

export async function fetchR2ResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	return fetchStorageResourceDocuments({
		provider: "R2",
		...input,
	});
}

export async function fetchAirtableResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
	providerConfig?: Record<string, unknown>;
	batchSize?: number;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token = input.credentials.accessToken ?? input.credentials.apiKey;
	if (!token) {
		throw new Error("Airtable API token is required");
	}

	const baseId =
		typeof input.resource.metadata?.baseId === "string"
			? input.resource.metadata.baseId
			: null;
	const tableId =
		typeof input.resource.metadata?.tableId === "string"
			? input.resource.metadata.tableId
			: null;
	if (!baseId || !tableId) {
		throw new Error("Airtable baseId and tableId are required");
	}

	const airtableConfig = (input.providerConfig ?? {}) as AirtableSyncConfig;
	const pageSize = Math.min(
		100,
		airtableConfig.maxRecordsPerTable ?? input.batchSize ?? 100,
	);
	const recordsData = await fetchAirtableJson<{
		records?: Array<{
			id: string;
			createdTime?: string;
			fields?: Record<string, unknown>;
		}>;
		offset?: string;
	}>({
		token,
		path: `${baseId}/${encodeURIComponent(tableId)}`,
		query: {
			pageSize: String(pageSize),
			...(typeof airtableConfig.view === "string"
				? { view: airtableConfig.view }
				: {}),
		},
	});

	const records = recordsData.records ?? [];
	const rows = records
		.map((record) => {
			const fields = Object.entries(record.fields ?? {})
				.map(([key, value]) => {
					const normalized =
						typeof value === "string"
							? value
							: Array.isArray(value)
								? value
										.map((entry) =>
											typeof entry === "string"
												? entry
												: JSON.stringify(entry),
										)
										.join(", ")
								: value && typeof value === "object"
									? JSON.stringify(value)
									: String(value ?? "");
					return `- ${key}: ${normalized}`;
				})
				.join("\n");
			return `## Record ${record.id}\n${fields || "- (No fields)"}`;
		})
		.join("\n\n");

	const createdTimes = records
		.map((record) => record.createdTime)
		.filter((value): value is string => typeof value === "string")
		.sort();
	const updatedAt =
		createdTimes.length > 0 ? createdTimes[createdTimes.length - 1] : null;

	return {
		documents: [
			{
				id: `airtable-table-${baseId}-${tableId}`,
				externalId: `airtable:table:${baseId}:${tableId}`,
				title: input.resource.name,
				content: `# ${input.resource.name}\n\n${rows || "(No records found)"}`,
				contentHash: updatedAt ?? undefined,
				metadata: {
					resourceType: "table",
					baseId,
					tableId,
					url: input.resource.path ?? null,
					recordCount: records.length,
					updatedAt,
					view:
						typeof airtableConfig.view === "string"
							? airtableConfig.view
							: null,
				},
				sizeBytes: Buffer.byteLength(rows, "utf8"),
				textLength: rows.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "AIRTABLE",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}

export async function fetchCodaResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token = input.credentials.accessToken ?? input.credentials.apiKey;
	if (!token) {
		throw new Error("Coda API token is required");
	}

	const docId =
		typeof input.resource.metadata?.docId === "string"
			? input.resource.metadata.docId
			: null;
	if (!docId) {
		throw new Error("Coda doc id is required");
	}

	if (input.resource.type === "coda-doc") {
		const doc = await fetchCodaJson<{
			id: string;
			name: string;
			browserLink?: string;
			updatedAt?: string;
		}>({
			token,
			path: `docs/${docId}`,
		});
		const updatedAt = doc.updatedAt ?? null;
		const content =
			`# ${doc.name}\n\nCoda document connected for search.\n\nOpen: ${doc.browserLink ?? ""}`.trim();

		return {
			documents: [
				{
					id: `coda-doc-${doc.id}`,
					externalId: `coda:doc:${doc.id}`,
					title: doc.name,
					content,
					contentHash: updatedAt ?? undefined,
					metadata: {
						resourceType: "doc",
						docId: doc.id,
						url: doc.browserLink ?? null,
						updatedAt,
					},
					sizeBytes: Buffer.byteLength(content, "utf8"),
					textLength: content.length,
				},
			],
			newCursor: updatedAt
				? {
						connectorId: input.connectorId,
						provider: "CODA",
						cursorType: "incremental",
						cursor: updatedAt,
						lastSyncedAt: updatedAt,
					}
				: undefined,
		};
	}

	const pageId =
		typeof input.resource.metadata?.pageId === "string"
			? input.resource.metadata.pageId
			: null;
	if (!pageId) {
		throw new Error("Coda page id is required");
	}

	const contentData = await fetchCodaJson<{
		items?: Array<{
			itemContent?: { content?: string };
		}>;
	}>({
		token,
		path: `docs/${docId}/pages/${pageId}/content`,
	});

	const body = (contentData.items ?? [])
		.map((item) => item.itemContent?.content ?? "")
		.filter((part) => part.trim().length > 0)
		.join("\n\n");
	const title =
		typeof input.resource.metadata?.docName === "string"
			? `${input.resource.metadata.docName} / ${input.resource.name.split(" / ").pop() ?? input.resource.name}`
			: input.resource.name;
	const updatedAt =
		typeof input.resource.metadata?.updatedAt === "string"
			? input.resource.metadata.updatedAt
			: null;

	return {
		documents: [
			{
				id: `coda-page-${docId}-${pageId}`,
				externalId: `coda:page:${docId}:${pageId}`,
				title,
				content: `# ${title}\n\n${body || "(No text content found)"}`,
				contentHash: updatedAt ?? undefined,
				metadata: {
					resourceType: "page",
					docId,
					pageId,
					url: input.resource.path ?? null,
					updatedAt,
				},
				sizeBytes: Buffer.byteLength(body, "utf8"),
				textLength: body.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "CODA",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}

export async function fetchGitBookResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token = input.credentials.accessToken ?? input.credentials.apiKey;
	if (!token) {
		throw new Error("GitBook API token is required");
	}

	const spaceId =
		typeof input.resource.metadata?.spaceId === "string"
			? input.resource.metadata.spaceId
			: null;
	const pageId =
		typeof input.resource.metadata?.pageId === "string"
			? input.resource.metadata.pageId
			: null;
	if (!spaceId || !pageId) {
		throw new Error("GitBook spaceId and pageId are required");
	}

	const content = await fetchGitBookJson<Record<string, unknown>>({
		token,
		path: `spaces/${spaceId}/content/page/${pageId}`,
	});
	const body = extractGitBookText(content);
	const updatedAt =
		typeof input.resource.metadata?.updatedAt === "string"
			? input.resource.metadata.updatedAt
			: null;

	return {
		documents: [
			{
				id: `gitbook-page-${spaceId}-${pageId}`,
				externalId: `gitbook:page:${spaceId}:${pageId}`,
				title: input.resource.name,
				content: `# ${input.resource.name}\n\n${body || "(No text content found)"}`,
				contentHash: updatedAt ?? undefined,
				metadata: {
					resourceType: "page",
					spaceId,
					pageId,
					url: input.resource.path ?? null,
					path:
						typeof input.resource.metadata?.path === "string"
							? input.resource.metadata.path
							: null,
					updatedAt,
				},
				sizeBytes: Buffer.byteLength(body, "utf8"),
				textLength: body.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "GITBOOK",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}

export async function fetchMicrosoftResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token = input.credentials.accessToken;
	if (!token) {
		throw new Error("Microsoft access token is required");
	}

	const itemId =
		typeof input.resource.metadata?.itemId === "string"
			? input.resource.metadata.itemId
			: input.resource.id;
	const driveId =
		typeof input.resource.metadata?.driveId === "string"
			? input.resource.metadata.driveId
			: "me";

	const metadata = await fetchMicrosoftGraphJson<{
		id: string;
		name: string;
		webUrl?: string;
		lastModifiedDateTime?: string;
		size?: number;
		file?: { mimeType?: string };
		parentReference?: { path?: string };
	}>({
		token,
		path: `drives/${driveId}/items/${itemId}`,
		query: {
			$select:
				"id,name,webUrl,lastModifiedDateTime,size,file,parentReference",
		},
	});

	const content = await fetchMicrosoftGraphText({
		token,
		driveId,
		itemId,
	});

	const title = metadata.name || input.resource.name;
	const source =
		typeof input.resource.metadata?.source === "string"
			? input.resource.metadata.source
			: "microsoft-365";
	const siteId =
		typeof input.resource.metadata?.siteId === "string"
			? input.resource.metadata.siteId
			: null;
	const siteName =
		typeof input.resource.metadata?.siteName === "string"
			? input.resource.metadata.siteName
			: null;
	const updatedAt = metadata.lastModifiedDateTime ?? null;

	return {
		documents: [
			{
				id: `microsoft-${source}-${itemId}`,
				externalId: `microsoft:${source}:${itemId}`,
				title,
				content: [`Source: ${source}`, "", content].join("\n"),
				contentHash: updatedAt ?? undefined,
				metadata: {
					resourceType: "file",
					source,
					driveId,
					itemId,
					siteId,
					siteName,
					mimeType: metadata.file?.mimeType ?? null,
					url: metadata.webUrl ?? input.resource.path ?? null,
					path: metadata.parentReference?.path ?? null,
					updatedAt,
				},
				sizeBytes: metadata.size ?? Buffer.byteLength(content, "utf8"),
				textLength: content.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "MICROSOFT_365",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}

export async function fetchTeamsResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token = input.credentials.accessToken;
	if (!token) {
		throw new Error("Microsoft Teams access token is required");
	}

	const teamId =
		typeof input.resource.metadata?.teamId === "string"
			? input.resource.metadata.teamId
			: null;
	const channelId =
		typeof input.resource.metadata?.channelId === "string"
			? input.resource.metadata.channelId
			: null;

	if (!teamId || !channelId) {
		throw new Error("Teams teamId and channelId are required");
	}

	const messages = await fetchMicrosoftGraphCollection<{
		id: string;
		subject?: string | null;
		createdDateTime?: string;
		lastModifiedDateTime?: string;
		from?: {
			user?: { displayName?: string | null };
			application?: { displayName?: string | null };
		};
		body?: { content?: string | null; contentType?: string | null };
		replyToId?: string | null;
	}>({
		token,
		path: `teams/${teamId}/channels/${channelId}/messages`,
		query: {
			$top: "50",
		},
	});

	const messageSections = messages
		.map((message) => {
			const sender =
				message.from?.user?.displayName ??
				message.from?.application?.displayName ??
				"Unknown sender";
			const text = message.body?.content
				? convertHtmlToText(message.body.content)
				: "";
			if (!text.trim()) {
				return null;
			}
			return [
				message.createdDateTime
					? `Message at: ${message.createdDateTime}`
					: null,
				`From: ${sender}`,
				message.subject?.trim()
					? `Subject: ${message.subject.trim()}`
					: null,
				text.trim(),
			]
				.filter((value): value is string => Boolean(value))
				.join("\n");
		})
		.filter((value): value is string => Boolean(value));

	const title =
		typeof input.resource.metadata?.channelName === "string"
			? input.resource.metadata.channelName
			: input.resource.name;
	const teamName =
		typeof input.resource.metadata?.teamName === "string"
			? input.resource.metadata.teamName
			: null;
	const sortedTimestamps = messages
		.map(
			(message) =>
				message.lastModifiedDateTime ?? message.createdDateTime ?? null,
		)
		.filter((value): value is string => Boolean(value))
		.sort();
	const updatedAt =
		sortedTimestamps.length > 0
			? sortedTimestamps[sortedTimestamps.length - 1]
			: null;

	const content = [
		teamName ? `Team: ${teamName}` : null,
		`# ${title}`,
		"",
		messageSections.join("\n\n---\n\n") || "(No channel messages found)",
	]
		.filter((value): value is string => Boolean(value))
		.join("\n");

	return {
		documents: [
			{
				id: `teams-channel-${teamId}-${channelId}`,
				externalId: `teams:channel:${teamId}:${channelId}`,
				title,
				content,
				contentHash: updatedAt ?? undefined,
				metadata: {
					resourceType: "channel",
					teamId,
					teamName,
					channelId,
					channelName: title,
					url: input.resource.path ?? null,
					updatedAt,
					messageCount: messageSections.length,
				},
				sizeBytes: Buffer.byteLength(content, "utf8"),
				textLength: content.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "TEAMS",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}

export async function fetchGmailResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token = input.credentials.accessToken;
	if (!token) {
		throw new Error("Gmail access token is required");
	}

	const threadId =
		(typeof input.resource.metadata?.threadId === "string" &&
			input.resource.metadata.threadId) ||
		input.resource.id.replace(/^gmail:thread:/, "");

	const thread = await fetchGmailJson<{
		id: string;
		historyId?: string;
		snippet?: string;
		messages?: Array<{
			id: string;
			internalDate?: string;
			payload?: {
				headers?: Array<{ name?: string; value?: string }>;
				mimeType?: string;
				body?: { data?: string };
				parts?: Array<{
					mimeType?: string;
					body?: { data?: string };
					parts?: Array<{
						mimeType?: string;
						body?: { data?: string };
						parts?: Array<unknown>;
					}>;
				}>;
			};
		}>;
	}>({
		token,
		path: `threads/${threadId}`,
		query: {
			format: "full",
		},
	});

	const messageBodies = (thread.messages ?? []).map((message) => {
		const headers = message.payload?.headers;
		const subject = getGmailHeader(headers, "Subject");
		const from = getGmailHeader(headers, "From");
		const to = getGmailHeader(headers, "To");
		const date = getGmailHeader(headers, "Date");
		const body = extractGmailBody(message.payload);

		return [
			subject ? `Subject: ${subject}` : null,
			from ? `From: ${from}` : null,
			to ? `To: ${to}` : null,
			date ? `Date: ${date}` : null,
			"",
			body || "(No plain text body found)",
		]
			.filter((value): value is string => Boolean(value))
			.join("\n");
	});

	const firstHeaders = thread.messages?.[0]?.payload?.headers;
	const title =
		getGmailHeader(firstHeaders, "Subject") ||
		thread.snippet?.trim() ||
		input.resource.name;
	const newestInternalDate = [...(thread.messages ?? [])]
		.map((message) => message.internalDate)
		.filter((value): value is string => typeof value === "string")
		.sort();
	const newestTimestamp =
		newestInternalDate.length > 0
			? newestInternalDate[newestInternalDate.length - 1]
			: undefined;
	const updatedAt = newestTimestamp
		? new Date(Number.parseInt(newestTimestamp, 10)).toISOString()
		: null;
	const combinedContent = messageBodies.join("\n\n");

	return {
		documents: [
			{
				id: `gmail-thread-${thread.id}`,
				externalId: `gmail:thread:${thread.id}`,
				title,
				content: [`# ${title}`, "", combinedContent].join("\n\n"),
				contentHash: thread.historyId ?? updatedAt ?? undefined,
				metadata: {
					resourceType: "thread",
					threadId: thread.id,
					historyId: thread.historyId ?? null,
					url: `https://mail.google.com/mail/u/0/#inbox/${thread.id}`,
					updatedAt,
					messageCount: thread.messages?.length ?? 0,
				},
				sizeBytes: Buffer.byteLength(combinedContent, "utf8"),
				textLength: combinedContent.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "GMAIL",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}
