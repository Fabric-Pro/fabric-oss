/**
 * Confluence Content Helpers
 *
 * Helpers to resolve credentials and interact with Confluence Cloud REST API
 * for page discovery and markdown content conversion.
 */

import { ORPCError } from "@orpc/server";
import { fetchCredentialsByProvider } from "@repo/database";
import { convertConfluenceXhtmlToMarkdown } from "@repo/utils/confluence-storage-markdown";

const MAX_CONFLUENCE_PAGE_BYTES = 2 * 1024 * 1024;

export interface ConfluenceCredentials {
	baseUrl: string;
	email: string;
	apiToken: string;
}

export interface ConfluencePageItem {
	id: string;
	title: string;
	url: string;
	spaceKey: string;
	spaceName: string | null;
	lastEdited: string | null;
}

interface ConfluenceSearchResult {
	results?: Array<{
		id: string;
		title?: string;
		space?: { key?: string; name?: string };
		version?: { when?: string };
		_links?: { webui?: string };
	}>;
	totalSize?: number;
	_links?: {
		next?: string;
	};
}

/**
 * Resolve Confluence credentials for the acting user / organization.
 */
export async function getConfluenceCredentials(
	userId: string,
	organizationId?: string,
): Promise<ConfluenceCredentials> {
	const creds = await fetchCredentialsByProvider(
		"CONFLUENCE",
		userId,
		organizationId,
	);

	if (
		!creds ||
		!creds.CONFLUENCE_DOMAIN ||
		!creds.CONFLUENCE_EMAIL ||
		!creds.CONFLUENCE_API_TOKEN
	) {
		throw new ORPCError("NOT_FOUND", {
			message: "Connect Confluence on the Integrations page",
		});
	}

	const rawDomain = creds.CONFLUENCE_DOMAIN.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/\/+$/, "");

	// Reject paths, fragments, queries, ports, and credentials. Only allow *.atlassian.net
	if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*\.atlassian\.net$/i.test(rawDomain)) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Invalid Confluence domain. Expected *.atlassian.net",
		});
	}

	return {
		baseUrl: `https://${rawDomain}`,
		email: creds.CONFLUENCE_EMAIL,
		apiToken: creds.CONFLUENCE_API_TOKEN,
	};
}

/**
 * Fetch JSON from Confluence API, mapping errors consistently without leaking internal responses.
 */
export async function fetchConfluenceJson<T>(
	creds: ConfluenceCredentials,
	path: string,
): Promise<T> {
	const authHeader = `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64")}`;
	const response = await fetch(`${creds.baseUrl}${path}`, {
		headers: {
			Authorization: authHeader,
			Accept: "application/json",
		},
	});

	if (!response.ok) {
		console.error(`[Confluence] API error (${response.status})`);

		if (response.status === 401) {
			throw new ORPCError("UNAUTHORIZED", {
				message:
					"Confluence connection expired. Update your API token.",
			});
		}
		if (response.status === 403) {
			throw new ORPCError("FORBIDDEN", {
				message: "Confluence resource access forbidden",
			});
		}
		if (response.status === 404) {
			throw new ORPCError("NOT_FOUND", {
				message: "Confluence resource not found",
			});
		}
		throw new ORPCError("BAD_REQUEST", {
			message: "Confluence API request failed",
		});
	}

	return (await response.json()) as T;
}

/**
 * Search Confluence pages with CQL ordered by last modified date.
 */
export async function searchConfluencePages(
	creds: ConfluenceCredentials,
	query?: string,
	cursor?: string,
): Promise<{ pages: ConfluencePageItem[]; nextCursor: string | null }> {
	const trimmedQuery = query?.trim();
	const escapedQuery = trimmedQuery
		? trimmedQuery.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
		: "";
	const cql = escapedQuery
		? `type=page AND title ~ "${escapedQuery}" order by lastmodified desc`
		: "type=page order by lastmodified desc";

	const startOffset =
		cursor && /^\d{1,6}$/.test(cursor) ? Number.parseInt(cursor, 10) : 0;

	const path = `/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=50&start=${startOffset}&expand=space,version`;

	const data = await fetchConfluenceJson<ConfluenceSearchResult>(creds, path);
	const results = data.results ?? [];

	const pages: ConfluencePageItem[] = results.map((page) => {
		const webPath = page._links?.webui;
		const url = webPath
			? `${creds.baseUrl}${webPath.startsWith("/") ? webPath : `/${webPath}`}`
			: `${creds.baseUrl}/wiki/pages/viewpage.action?pageId=${page.id}`;

		return {
			id: page.id,
			title: page.title ?? "Untitled",
			url,
			spaceKey: page.space?.key ?? "",
			spaceName: page.space?.name ?? null,
			lastEdited: page.version?.when ?? null,
		};
	});

	let nextCursor: string | null = null;
	if (data._links?.next) {
		nextCursor = String(startOffset + results.length);
	} else if (
		data.totalSize !== undefined &&
		startOffset + results.length < data.totalSize
	) {
		nextCursor = String(startOffset + results.length);
	}

	return { pages, nextCursor };
}

/**
 * Fetch a single Confluence page's storage content and convert it to Markdown.
 */
export async function fetchConfluencePageContent(
	creds: ConfluenceCredentials,
	pageId: string,
): Promise<string> {
	const path = `/wiki/rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage`;
	const data = await fetchConfluenceJson<{
		body?: {
			storage?: {
				value?: string;
			};
		};
	}>(creds, path);

	const rawContent = data.body?.storage?.value ?? "";
	if (Buffer.byteLength(rawContent, "utf8") > MAX_CONFLUENCE_PAGE_BYTES) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Confluence page is too large to import (exceeds 2 MB limit)",
		});
	}
	return convertConfluenceXhtmlToMarkdown(rawContent);
}
