/**
 * Shared Confluence content fetching utility.
 *
 * Mirrors `notion-content-fetcher.ts`: fetches a page's content via MCP tools
 * and normalizes the many response shapes a Confluence MCP server can return
 * (ADF document, Confluence storage/view HTML, plain Markdown, or an MCP
 * text-content envelope) into plain text suitable for embedding into project
 * RAG. Used by `ConfluenceResourceBrowser`.
 *
 * The normalizer is intentionally pure and DOM-free so it can run in any
 * environment — it never reaches for `DOMParser` or a server-only HTML library.
 */

import { extractTextFromAdf, isAdfDocument } from "@repo/utils/adf-text";

export type ConfluenceContentFetchResult = {
	content: string;
	title: string;
	contentFetchFailed: boolean;
};

// ── HTML → text (regex-based, DOM-free) ──────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
	"&nbsp;": " ",
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&apos;": "'",
};

function decodeEntities(input: string): string {
	let out = input;
	for (const [entity, char] of Object.entries(NAMED_ENTITIES)) {
		out = out.split(entity).join(char);
	}
	out = out.replace(/&#(\d+);/g, (_, dec: string) => {
		const code = Number(dec);
		return Number.isFinite(code) ? String.fromCodePoint(code) : _;
	});
	out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
		String.fromCodePoint(Number.parseInt(hex, 16)),
	);
	return out;
}

function looksLikeHtml(value: string): boolean {
	return /<\/?[a-z][^>]*>/i.test(value);
}

/**
 * Strip HTML/XHTML (Confluence storage or view format) to plain text. Block
 * boundaries (`</p>`, `<br>`, list items, headings, table rows…) become
 * newlines; all other tags are dropped; entities are decoded; runs of
 * whitespace are collapsed while paragraph breaks are preserved.
 */
function htmlToText(html: string): string {
	const withBreaks = html
		.replace(/<\s*br\s*\/?>/gi, "\n")
		.replace(
			/<\/\s*(p|div|h[1-6]|li|tr|table|ul|ol|blockquote|section|article|pre|figure)\s*>/gi,
			"\n",
		)
		// Confluence wraps content in <ac:*> / <ri:*> macro tags — drop them too.
		.replace(/<[^>]+>/g, "");

	return decodeEntities(withBreaks)
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

// ── Normalizer ───────────────────────────────────────────────────────────────

/**
 * Coerce any Confluence MCP page payload into plain text. Precedence:
 *  1. ADF document → flattened via the shared ADF helpers.
 *  2. Confluence storage/view body (`body.storage.value`, `body.view.value`,
 *     `body.atlas_doc_format.value`).
 *  3. MCP text-content envelope (`[{type:"text",text}]` / `{content:[...]}`).
 *  4. Plain string / Markdown → passthrough (HTML strings are stripped).
 *  5. `JSON.stringify` fallback; empty / null → `""`.
 */
export function normalizeConfluenceContent(raw: unknown): string {
	if (raw === null || raw === undefined) {
		return "";
	}

	if (isAdfDocument(raw)) {
		return extractTextFromAdf(raw);
	}

	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			return "";
		}
		// A JSON-encoded ADF document / MCP envelope arrives as a string.
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				return normalizeConfluenceContent(JSON.parse(trimmed));
			} catch {
				// Not JSON — treat as content below.
			}
		}
		return looksLikeHtml(raw) ? htmlToText(raw) : raw;
	}

	if (typeof raw !== "object") {
		return String(raw);
	}

	// MCP text-content envelope: [{ type: "text", text: "..." }]
	if (Array.isArray(raw)) {
		const texts = raw
			.filter(
				(block): block is { text: string } =>
					!!block &&
					typeof block === "object" &&
					typeof (block as { text?: unknown }).text === "string",
			)
			.map((block) => block.text);
		if (texts.length > 0) {
			return normalizeConfluenceContent(texts.join("\n\n"));
		}
		return raw.length > 0 ? JSON.stringify(raw) : "";
	}

	const obj = raw as Record<string, unknown>;

	// { content: [...] } MCP envelope
	if (Array.isArray(obj.content)) {
		return normalizeConfluenceContent(obj.content);
	}

	// Confluence REST/MCP body shapes. A recognized body container is
	// authoritative: an empty page (`value: ""`) normalizes to "" rather than
	// falling through to the JSON.stringify fallback (which would embed noise).
	const body = obj.body as Record<string, unknown> | undefined;
	if (body && typeof body === "object") {
		const container = (body.storage ??
			body.view ??
			body.atlas_doc_format) as { value?: unknown } | undefined;
		if (
			container &&
			typeof container === "object" &&
			typeof container.value === "string"
		) {
			return normalizeConfluenceContent(container.value);
		}
	}

	if (typeof obj.content === "string") {
		return normalizeConfluenceContent(obj.content);
	}
	if (typeof obj.text === "string") {
		return normalizeConfluenceContent(obj.text);
	}
	if (typeof obj.markdown === "string") {
		return obj.markdown;
	}

	return JSON.stringify(raw);
}

// ── Title extraction ─────────────────────────────────────────────────────────

/** Pull a `title` field out of the (possibly enveloped) MCP result. */
function extractConfluenceTitle(result: unknown): string | undefined {
	let data: unknown = result;

	if (typeof data === "string") {
		const trimmed = data.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				data = JSON.parse(trimmed);
			} catch {
				return undefined;
			}
		}
	}

	if (
		Array.isArray(data) &&
		data[0] &&
		typeof data[0] === "object" &&
		typeof (data[0] as { text?: unknown }).text === "string"
	) {
		const text = (data[0] as { text: string }).text.trim();
		if (text.startsWith("{")) {
			try {
				data = JSON.parse(text);
			} catch {
				return undefined;
			}
		}
	}

	if (data && typeof data === "object" && !Array.isArray(data)) {
		const title = (data as { title?: unknown }).title;
		if (typeof title === "string" && title.trim().length > 0) {
			return title.trim();
		}
	}

	return undefined;
}

// ── Tool detection ───────────────────────────────────────────────────────────

/**
 * Find a tool for fetching a single Confluence page's content. Tool names vary
 * across MCP server implementations (`confluence_get_page`, `get_page_content`,
 * `getPage`, Atlassian Rovo's `getConfluencePage`, …).
 *
 * A Confluence server typically exposes SEVERAL get+page tools — Rovo alone has
 * getConfluencePage, getConfluencePageFooterComments,
 * getConfluencePageInlineComments, getConfluencePageDescendants, and
 * getPagesInConfluenceSpace. Only the first fetches a single page's body, so we
 * match known exact names first and exclude the non-content tools before a loose
 * fallback — otherwise a naive `get`+`page` match can grab comments or the
 * pages-in-space listing and silently return junk.
 */
const GET_PAGE_EXACT = [
	"getconfluencepage",
	"confluence_get_page",
	"get_page",
	"get_page_content",
	"getpage",
	"read_page",
];

const NON_CONTENT_PAGE_TOOL =
	/comment|descendant|ancestor|child|pagesin|pages_in|create|update/;

function findGetPageTool(tools: string[]): string | undefined {
	const lowered = tools.map((name) => [name, name.toLowerCase()] as const);

	for (const exact of GET_PAGE_EXACT) {
		const hit = lowered.find(([, lower]) => lower === exact);
		if (hit) {
			return hit[0];
		}
	}

	const fuzzy = lowered.find(
		([, lower]) =>
			!NON_CONTENT_PAGE_TOOL.test(lower) &&
			((lower.includes("get") && lower.includes("page")) ||
				(lower.includes("fetch") && lower.includes("page"))),
	);
	return fuzzy?.[0];
}

// ── Fetcher ──────────────────────────────────────────────────────────────────

/**
 * Fetch a Confluence page's content via MCP. Discovers the available tools,
 * picks a get-page tool, calls it, then normalizes the result to plain text.
 * Returns `contentFetchFailed: true` (with empty content) on any failure so the
 * caller can create a PENDING context row rather than aborting the batch.
 */
export async function fetchConfluencePageContent(params: {
	pageId: string;
	mcpConfigId: string;
	organizationId?: string | null;
	fallbackTitle?: string;
}): Promise<ConfluenceContentFetchResult> {
	const { pageId, mcpConfigId, organizationId, fallbackTitle } = params;
	const defaultTitle = fallbackTitle || "Confluence Page";

	// Step 1: list available tools.
	const toolsResponse = await fetch("/api/pipeline/mcp-tool", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			mcpConfigId,
			action: "list_tools",
			organizationId: organizationId ?? undefined,
		}),
	});
	const toolsData = await toolsResponse.json();
	const tools = (toolsData.tools || []) as string[];

	// Step 2: find a get-page tool.
	const getPageTool = findGetPageTool(tools);
	if (!getPageTool) {
		console.warn(
			"[ConfluenceContentFetcher] No get_page tool found. Available tools:",
			tools,
		);
		return { content: "", title: defaultTitle, contentFetchFailed: true };
	}

	// Step 3: fetch the page content. Atlassian Rovo's getConfluencePage uses a
	// strict schema (just `pageId`; cloudId is injected server-side and the body
	// is returned by default), so sending the community servers' extra params
	// (`id`, `page_id`, `expand`) risks a validation rejection. Send the minimal
	// shape for Rovo, and keep the broad shotgun for everything else.
	const isRovoGetPage = getPageTool.toLowerCase() === "getconfluencepage";
	const contentResponse = await fetch("/api/pipeline/mcp-tool", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			mcpConfigId,
			toolName: getPageTool,
			params: isRovoGetPage
				? { pageId }
				: {
						id: pageId,
						page_id: pageId,
						pageId,
						expand: "body.storage",
					},
			organizationId: organizationId ?? undefined,
		}),
	});
	const contentData = await contentResponse.json();

	if (contentData.error || !contentData.result) {
		return { content: "", title: defaultTitle, contentFetchFailed: true };
	}

	// Step 4: normalize content and resolve the best title.
	const content = normalizeConfluenceContent(contentData.result);
	const mcpTitle = extractConfluenceTitle(contentData.result);
	const headingTitle = content.match(/^#\s+(.+)/m)?.[1]?.trim();
	const title =
		mcpTitle || fallbackTitle || headingTitle || "Confluence Page";

	return {
		content,
		title,
		contentFetchFailed: content.length === 0,
	};
}
