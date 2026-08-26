/**
 * Story Sync Activities
 *
 * Provides activities for syncing user stories between Fabric and external
 * project management tools (e.g. Fizzy) via MCP. Uses the established
 * orchestrator patterns: getMcpClient, analyzePMToolCapabilities, executeMcpTool.
 *
 * Push (Fabric → PM): title, description (incl. acceptance criteria, size,
 * story points, labels, and a "View in Fabric" back-link URL that keeps the
 * Fabric identifier discoverable from the PM ticket), status/column (when
 * statusColumnMap in additionalContext), labels/tags, plus any
 * additionalContext keys that match tool params. Priority is deliberately
 * NEVER pushed — it is Fabric-internal (see the roadmap Priority feature).
 *
 * Pull (PM → Fabric): title, description, labels, statusId (via column name match
 * or statusColumnMap), externalId, externalUrl. Parsing supports common PM field
 * names (title/name/summary, description/body/content/details, tags/labels,
 * column/status/column_id).
 */
import {
	closeMcpClientSafe,
	getMcpClientResult,
} from "@repo/agent-core/backend";
import { config } from "@repo/config";
import {
	appendFabricBackLink,
	buildFabricStoryUrl,
	createStory,
	db,
	deleteStory,
	type FieldMappingConfig,
	formatBackLinkForProvider,
	getMcpConfigById,
	getStoryById,
	HTML_BACK_LINK_RE,
	isProjectReadOnly,
	listStoryStatuses,
	normalizeBackLinkFromProvider,
	readFieldMappingConfig,
	type StoryKind,
	type StoryPriority,
	type StorySize,
	type StorySource,
	updateTask,
} from "@repo/database";

import {
	computeLabelDeltaOnPush,
	readLabelStatusMap,
} from "@repo/integrations/pm";
import {
	appendAdoAttachmentLinks,
	buildAdoIngestOptions,
	buildFizzyIngestOptions,
	fetchAdoAttachmentRelations,
	ingestPulledImages,
	stripFailedMediaPlaceholders,
} from "@repo/integrations/pm/pull-image-ingest";
import { createStoryMediaPullStore } from "@repo/integrations/pm/pull-image-store";
import { logger } from "@repo/logs";
import { getCachedMcpClientForConfig } from "@repo/mcp";
import { deleteObjects } from "@repo/storage";
import {
	COMMON_ID_FIELDS,
	COMMON_URL_FIELDS,
	decryptApiKey,
	extractWebUrlFromLinks,
	findBacklogsListTool,
	getBaseUrl,
	normalizeUrl,
	parseWorkItemTypeMapping,
	READ_ONLY_MODE_MESSAGE,
	resolveKindFromPmType,
	resolveWorkItemType,
	type StoryKindValue,
} from "@repo/utils";
import { ApplicationFailure } from "@temporalio/activity";
import {
	ELISION_MARKER,
	slimWorkItemSummaries,
} from "../../lib/payload-elision";
import {
	assertPayloadWithinLimit,
	PAYLOAD_HARD_LIMIT_BYTES,
} from "../../lib/payload-size-guard";
import { executeMcpTool } from "../orchestrator/execution/execute-mcp-tool";
import { runWithTimeout } from "../orchestrator/execution/mcp-call-timeout";
import { resolvePmSource } from "../pm-source";
import {
	callPmToolWithFallback,
	GITLAB_REST_CAPABILITIES,
} from "../pm-tool-fallback";
import { descriptionToText } from "./adf";
import { refreshAtlassianCloudToken } from "./atlassian-cloud-refresh";
import { runBoundedWorkerPool } from "./bounded-worker-pool";
import {
	resolveAdoDefaultTeam,
	resolveAtlassianCloudId,
	resolveJiraDefaultIssueType,
} from "./fetch-pm-hierarchy";
import { resolveFizzyAccountSlug } from "./fizzy-account-slug";
import { truncateTitleForProvider } from "./pm-title-limits";
import {
	belongsToDifferentKnownTool,
	hostsShareRegistrableDomain,
	PM_TOOL_HOST_PATTERNS,
	safeHost,
} from "./pm-tool-mismatch";
import { updateStoryFromPm as updateStory } from "./pm-update-story";
import { reconcileStoryTerminalStatus } from "./reconcile-story-terminal-status";
import {
	type RecordPmSyncLogInput,
	recordPmSyncLog,
} from "./record-pm-sync-log";
import {
	recordPmSyncFailure,
	recordPmSyncSuccessState,
} from "./record-pm-sync-state";
import {
	type AdoAttachmentTarget,
	convertEmbeddedHtmlTablesToMarkdown,
	convertMarkdownTablesToHtml,
	extractAdoImages,
	extractAdoTables,
	extractFizzyFileAttachments,
	extractFizzyImages,
	extractImagesFromHtml,
	extractStoryMediaKeysFromContent,
	type ImageRef,
	imageToLexxyFigure,
	inlineJiraMarkdownImagesAsBase64DataUrls,
	type JiraCloudTarget,
	looksFabricAuthored,
	looksLikeHtmlBody,
	replaceHtmlImagesWithMarkdown,
	resolveFizzyAttachmentTarget,
	resolveFizzyFileEmbeds,
	resolveFizzyImageEmbeds,
	resolveIssueSite,
	resolveJiraCloudTarget,
	resolveStoryMediaSignedUrls,
	restoreAdoImages,
	restoreAdoTables,
	restoreFizzyFileAttachments,
	restoreFizzyImagesWithEmbeds,
	rewriteAdoInCellImagesToAttachments,
	rewriteFizzyInCellImagesHybrid,
	rewriteStoryMediaSourcesToSignedUrls,
	stripStoryMediaFileAnchors,
	uploadAdoImageAttachments,
	uploadJiraImagesAndRewriteDescription,
} from "./story-sync-media";
import {
	analyzePMToolCapabilities,
	type McpToolDefinition,
	type PMToolCapabilities,
	type ToolInputSchema,
} from "./tool-analyzer";

// =============================================================================
// Types
// =============================================================================

export type SyncDirection = "push" | "pull" | "bidirectional";

export interface StorySyncInput {
	storyId: string;
	projectId: string;
	mcpConfigId: string | null;
	mcpServerId?: string;
	containerId: string;
	additionalContext?: Record<string, string>;
	direction: SyncDirection;
	userId: string;
	/** Organization ID for tenant isolation - use project's orgId, not session's */
	organizationId?: string;
	/** Pre-discovered capabilities (to avoid redundant discovery calls) */
	capabilities?: PMToolCapabilities;
	/** When true and direction is "push", treat a tool mismatch as an
	 *  explicit migration: clear the previous tool's link and proceed
	 *  with the push against the active tool. */
	overrideMismatch?: boolean;
	/**
	 * When true and direction is "push", skip the hash-drift conflict
	 * check and push the Fabric version unconditionally.
	 *
	 * Set by the `resolveConflict` procedure when the user chooses
	 * "Use Fabric version" (LOCAL resolution). Never set for automated
	 * auto-push flows — those must honour conflict detection.
	 */
	forceHashOverride?: boolean;
}

export type StorySyncErrorCode =
	| "PM_TOOL_MISMATCH"
	| "EXTERNAL_ID_NOT_FOUND"
	| "PM_SYNC_CONFLICT";

export interface StorySyncResult {
	success: boolean;
	externalId?: string;
	externalUrl?: string;
	error?: string;
	errorCode?: StorySyncErrorCode;
	syncedAt: Date;
	direction: SyncDirection;
	/** True when a not-found left the PM link intact (deletion is owned by the poll). */
	linkPreserved?: boolean;
	/**
	 * #1360 — terminal-status lifecycle outcome from the per-item pull reconcile.
	 * Populated only on a successful pull that ran the STORY reconcile; absent on
	 * push and when the (non-fatal) reconcile threw.
	 */
	terminalApplied?: boolean;
	/** The reconcile `action` (e.g. "auto-hidden", "checkmark-only"). */
	lifecycleAction?: string;
	/** True when the pull ran the reconcile to completion; false if it threw. */
	lifecycleReconciled?: boolean;
	/** The raw terminal status the ticket matched on, when terminal. */
	terminalStatusLabel?: string | null;
}

export interface BulkStorySyncInput {
	projectId: string;
	mcpConfigId: string;
	containerId: string;
	additionalContext?: Record<string, string>;
	filter?: {
		statusIds?: string[];
		unsyncedOnly?: boolean;
	};
	userId: string;
	/** Organization ID for tenant isolation - use project's orgId, not session's */
	organizationId?: string;
}

export interface BulkStorySyncResult {
	success: boolean;
	totalStories: number;
	syncedCount: number;
	failedCount: number;
	results: Array<{
		storyId: string;
		identifier: string;
		success: boolean;
		externalId?: string;
		error?: string;
		errorCode?: string;
	}>;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Normalize a URL to ensure it's absolute with logging.
 *
 * Uses shared normalizeUrl from @repo/utils but adds logging for debugging.
 *
 * @param url - The URL to normalize
 * @param baseUrl - Optional base URL from MCP config to resolve relative paths
 */
function _normalizeExternalUrl(
	url: string | undefined | null,
	baseUrl?: string | null,
): string | undefined {
	const result = normalizeUrl(url, baseUrl);

	// Log for debugging when normalization involves transformation
	if (url && result && url !== result) {
		logger.info("[URL Normalize] Transformed URL", {
			original: url,
			normalized: result,
			baseUrl,
		});
	} else if (url && !result) {
		logger.warn("[URL Normalize] Unable to normalize URL", { url });
	}

	return result;
}

/**
 * Normalize area path for Azure DevOps - requires backslashes (TF401347).
 * Converts forward slashes to backslashes for compatibility with stored values.
 */
function normalizeAreaPathForAdo(areaPath: string): string {
	return areaPath.trim().replace(/\//g, "\\");
}

/**
 * Map a PM-tool detectedType (used by capabilities discovery) to the canonical
 * StorySource enum stored on UserStory.source. Tools without a dedicated bucket
 * fall back to MANUAL — this matches the behavior of the legacy heuristic in
 * apps/web/.../roadmap-filters.ts before this column existed.
 */
function pmDetectedTypeToStorySource(
	detectedType: string | undefined,
): StorySource {
	switch ((detectedType ?? "").toLowerCase()) {
		case "jira":
			return "JIRA";
		case "azure-devops":
			return "AZURE_DEVOPS";
		case "fizzy":
			return "FIZZY";
		case "gitlab":
			return "GITLAB";
		case "linear":
			return "LINEAR";
		case "github":
			return "GITHUB";
		default:
			return "MANUAL";
	}
}

function hostMatchesTool(hostname: string, detectedType: string): boolean {
	const patterns = PM_TOOL_HOST_PATTERNS[detectedType];
	if (!patterns) {
		return true; // unknown tool → don't guess
	}
	return patterns.some((p) => hostname === p || hostname.endsWith(`.${p}`));
}

/**
 * Strip markdown heading markers and bold wrappers from a line.
 * e.g. "### **Main Flow**" → "Main Flow"
 *      "**User Story**" → "User Story"
 */
function stripMarkdownHeader(line: string): string {
	return line
		.replace(/^#{1,6}\s*/, "") // Strip leading ### markers
		.replace(/\*{2}([^*]+)\*{2}/g, "$1") // Strip **bold** wrappers
		.trim();
}

/**
 * Normalise provider code blocks to a bare `<pre><code>…</code></pre>` on pull.
 *
 * Rich editors paste code as syntax-highlighted HTML. Azure DevOps, when code
 * is pasted from Visual Studio, stores it in `System.Description` as
 *   `<div style…><pre style…><span style="color:…">token</span>…</pre></div>`
 * — a `<pre>` WITHOUT a `<code>` child, full of inline-styled `<span>`s. The
 * frontend HTML→markdown (Turndown) code-block rule only fires for
 * `<pre><code>`, so a span-only `<pre>` falls through to generic block
 * handling: lines collapse, the block splits, and `>` is escaped to `\>`.
 * (Fabric's own pushed code round-trips fine because it ships as `<pre><code>`.)
 *
 * This rewrites every `<pre>…</pre>` to `<pre><code>…</code></pre>`, dropping
 * the styling spans — their text, HTML entities (`&lt;`/`&gt;`) and newlines
 * are kept verbatim — so the block matches Turndown's code rule and renders
 * like the pushed form. Only `<pre>` blocks are rewritten; tables, images,
 * paragraphs and every other byte are left exactly as-is. Self-gated to ADO
 * (no-op for every other provider) and a no-op when there is no `<pre>`, so it
 * is safe to call unconditionally on the non-Fizzy pull branch.
 */
export function cleanAdoCodeBlocks<T extends string | null | undefined>(
	html: T,
	detectedType?: string | null,
): T {
	if (typeof html !== "string" || html.length === 0) {
		return html;
	}
	const provider = (detectedType ?? "").toLowerCase();
	if (provider !== "azure-devops" && provider !== "ado") {
		return html;
	}
	if (!/<pre\b/i.test(html)) {
		return html;
	}
	const cleaned = html.replace(
		/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
		(_full: string, inner: string) => {
			// Already-clean `<pre><code>…</code></pre>` (Fabric's own push output)
			// keeps its code verbatim; a styled span-only `<pre>` has its tags
			// stripped. Entities stay escaped — the browser/Turndown decode them.
			const codeMatch = inner.match(
				/^\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*$/i,
			);
			const body = codeMatch ? codeMatch[1] : inner;
			const code = body
				.replace(/<br\s*\/?>/gi, "\n") // line-break tags → newlines
				.replace(/<[^>]+>/g, ""); // drop <span>/styling tags, keep text + entities
			return `<pre><code>${code}</code></pre>`;
		},
	);
	return cleaned as T;
}

/**
 * Convert simple HTML (as returned by Fizzy/Trello/etc.) to markdown for storage in Fabric.
 * Mirrors the inverse of markdownToSimpleHtml — handles the common tags those tools produce.
 *
 * Handles: <strong>/<b>, <em>/<i>, <s>/<del>/<strike>, <br>, <p>, <ul>/<ol>/<li>,
 * <h1>-<h6>, <a href>. Strips all remaining tags.
 */
export function simpleHtmlToMarkdown(html: string): string {
	// Extract code blocks → ``` fences up front. Fizzy/Lexxy emits
	// `<pre data-language="…">line<br>line</pre>` (no <code> wrapper; lines
	// separated by <br>). We must convert those <br> to real newlines AND decode
	// entities (`&lt;`→`<`) so the code reads correctly — but decoding inline
	// would let the generic tag-strip below eat the decoded `<…>` inside the
	// code. So each converted fence is stashed in a sentinel and restored
	// verbatim at the very end, untouched by the rest of the pipeline.
	const codeBlocks: string[] = [];
	const codeBlockText = (code: string): string =>
		code
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(?:div|p)>/gi, "\n")
			.replace(/<[^>]+>/g, "")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&amp;/g, "&")
			.replace(/^\n+|\n+$/g, "");
	const stashCode = (code: string): string => {
		codeBlocks.push(`\`\`\`\n${codeBlockText(code)}\n\`\`\``);
		return `\n\nFABRICCODE${codeBlocks.length - 1}\n\n`;
	};
	const htmlNoCode = html
		.replace(
			/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
			(_m, code: string) => stashCode(code),
		)
		.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code: string) =>
			stashCode(code),
		);

	// Preserve <table> blocks across the generic tag-strip below. Extract them
	// to sentinels first; otherwise the strip (`/<(?!br>)[^>]+>/g`) drops every
	// <table>/<tr>/<td> tag and mashes the cells' text into one run — tables are
	// lost on ADO/Fizzy pull. Restored verbatim at the end: a raw <table> block
	// embedded in markdown is exactly the canonical shape the push converters
	// (convertEmbeddedHtmlTablesTo*, tiptapTableToLexxy) and the Tiptap editor
	// already consume, so the round-trip stays stable.
	const tables: string[] = [];
	const htmlNoTables = htmlNoCode.replace(
		/<table\b[^>]*>[\s\S]*?<\/table>/gi,
		(tableHtml) => {
			tables.push(tableHtml);
			return `\n\nFABRICTABLE${tables.length - 1}\n\n`;
		},
	);
	const md = htmlNoTables
		// Fizzy ActionText attachments → markdown image/link BEFORE the
		// generic tag strip drops them. Prefer the inner <img src>
		// (account-scoped, fetchable) over the wrapper `url` attr; skip
		// mention chips. The pull-image ingester then re-hosts the URL.
		.replace(
			/<action-text-attachment\b([^>]*)>([\s\S]*?)<\/action-text-attachment>/gi,
			(_m, attrs: string, inner: string) => {
				const contentType =
					attrs.match(/\bcontent-type=["']([^"']*)["']/i)?.[1] ?? "";
				if (contentType.includes("mention")) {
					return "";
				}
				const filename =
					attrs.match(/\bfilename=["']([^"']*)["']/i)?.[1] ??
					"attachment";
				const innerImg = inner.match(
					/<img\b[^>]*\bsrc=["']([^"']*)["']/i,
				)?.[1];
				const wrapperUrl = attrs.match(/\burl=["']([^"']*)["']/i)?.[1];
				const url = innerImg || wrapperUrl || "";
				if (!url) {
					return "";
				}
				const isImage =
					/^image\//i.test(contentType) || Boolean(innerImg);
				return isImage
					? `\n\n![${filename}](${url})\n\n`
					: `\n\n[${filename}](${url})\n\n`;
			},
		)
		// Code blocks (<pre>) were already extracted to FABRICCODE
		// sentinels above (with <br>→newline + entity decode) — nothing to
		// do here.
		// Block elements first — add surrounding newlines.
		// Heading level is preserved so a Fizzy push → pull → push
		// round-trip stays stable: <h1> back to "# ", <h2> to "## ",
		// etc. Earlier iterations dropped the level (emitted the
		// content as plain text), which made the second push downgrade
		// <h1> to <p> in Fizzy.
		.replace(
			/<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>/gi,
			(_, level: string, c: string) => {
				const hashes = "#".repeat(
					Math.min(Number.parseInt(level, 10), 6),
				);
				return `\n\n${hashes} ${c.trim()}\n\n`;
			},
		)
		.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, c) => `\n\n${c.trim()}\n\n`)
		// Preserve hard line breaks as a literal `<br>` (normalised). A bare
		// "\n" does NOT survive: the stored description is HTML-parsed by the
		// editor's Turndown (when it starts with a tag) and soft-broken by
		// markdown-it (breaks:false) — both collapse a lone "\n" to a space,
		// flattening multi-line text onto one line (Fizzy card #1595). Only a
		// `<br>` element round-trips: Turndown → "  \n" hard break, markdown-it
		// (html:true) → hardBreak, and markdownToSimpleHtml re-emits it as
		// `<br>` on push. The tag-strip below is taught to keep `<br>`.
		.replace(/<br\s*\/?>/gi, "<br>")
		// Ordered lists — preserve numbering (process before <ul> to avoid mismatches)
		.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner: string) => {
			let i = 0;
			return inner.replace(
				/<li[^>]*>([\s\S]*?)<\/li>/gi,
				(_m: string, c: string) => `\n${++i}. ${c.trim()}`,
			);
		})
		// Unordered lists
		.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner: string) =>
			inner.replace(
				/<li[^>]*>([\s\S]*?)<\/li>/gi,
				(_m: string, c: string) => `\n- ${c.trim()}`,
			),
		)
		// Remaining <li> outside a list container (fallback)
		.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `\n- ${c.trim()}`)
		// Strip remaining list container tags
		.replace(/<\/?(ul|ol)[^>]*>/gi, "\n")
		// Inline formatting — order matters: bold before italic
		.replace(
			/<(strong|b)[^>]*>([\s\S]*?)<\/(strong|b)>/gi,
			(_, _t, c) => `**${c}**`,
		)
		.replace(/<(em|i)[^>]*>([\s\S]*?)<\/(em|i)>/gi, (_, _t, c) => `*${c}*`)
		.replace(
			/<(s|del|strike)[^>]*>([\s\S]*?)<\/(s|del|strike)>/gi,
			(_, _t, c) => `~~${c}~~`,
		)
		// Links
		// Links — escape ] in text and ) / whitespace in href to avoid broken markdown
		.replace(
			/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
			(_, href, c) => {
				const safeText = c.replace(/\]/g, "\\]");
				const safeHref = href
					.replace(/\)/g, "%29")
					.replace(/\s/g, "%20");
				return `[${safeText}](${safeHref})`;
			},
		)
		// Standalone <img> → markdown image so the pull-image ingester
		// can re-host it (the generic strip below would drop it).
		.replace(/<img\b[^>]*>/gi, (tag: string) => {
			const src = tag.match(/\bsrc=["']([^"']*)["']/i)?.[1] ?? "";
			const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] ?? "";
			return src ? `![${alt}](${src})` : "";
		})
		// Strip remaining tags — but KEEP the canonical `<br>` (normalised
		// above) so hard line breaks survive into the stored description.
		.replace(/<(?!br>)[^>]+>/g, "")
		// Decode safe HTML entities.
		// &lt; and &gt; are intentionally NOT decoded: converting them to < / >
		// would reintroduce raw HTML into the stored markdown, which is then
		// rendered with html:true and could change rendering semantics.
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		// Collapse excessive blank lines to at most two
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	// Restore preserved blocks. Sentinels survived the chain as plain text (no
	// angle brackets for the tag-strip to catch). Restore tables first, then
	// code, so a code block that lived inside a table cell is recovered too.
	return md
		.replace(
			/FABRICTABLE(\d+)/g,
			(_m, i: string) => tables[Number(i)] ?? "",
		)
		.replace(
			/FABRICCODE(\d+)/g,
			(_m, i: string) => codeBlocks[Number(i)] ?? "",
		);
}

/**
 * PM tool types that use HTML rich text editors for card/issue descriptions.
 * These tools do not render markdown natively, so we convert markdown to HTML
 * before sending to avoid newlines collapsing and markdown symbols appearing raw.
 *
 * - Fizzy: ActionText/Lexxy rich text.
 * - Asana: `html_notes` rich-text field (HTML subset).
 * - Monday: update `body` accepts HTML.
 *
 * Tools that natively render markdown are in `MARKDOWN_DESCRIPTION_TOOLS`
 * instead. Azure DevOps (`System.Description` HTML) and Jira (ADF) are handled
 * separately.
 */
export const HTML_DESCRIPTION_TOOLS = new Set(["fizzy", "asana", "monday"]);

/**
 * PM tool types that render Markdown natively in issue/task descriptions, so
 * we send GFM (tables + emphasis + headings preserved) and embed images as
 * markdown `![alt](url)` rather than raw `<img>`:
 *
 * - GitHub / GitLab: GitHub/GitLab Flavored Markdown (full GFM incl. tables).
 * - Linear: issue descriptions accept Markdown via the API.
 * - ClickUp: `markdown_description` field.
 * - Trello: card descriptions render a Markdown subset (tables degrade to
 *   text — acceptable; formatting + image links still render).
 *
 * Jira is intentionally excluded: its description is ADF and goes through the
 * Rovo create/update + hybrid-Cloud ADF media path, not raw markdown.
 */
export const MARKDOWN_DESCRIPTION_TOOLS = new Set([
	"github",
	"gitlab",
	"linear",
	"clickup",
	"trello",
]);

/**
 * Convert inline markdown to HTML (bold, italic).
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Build an `AdoAttachmentTarget` (PAT + org slug) from a user's ADO
 * MCPConfig. Returns `null` when the config can't supply both pieces —
 * the ADO push path then falls back to embedding external `<img src>`
 * URLs verbatim (which ADO's sanitizer will strip), so the caller can
 * still ship the rest of the description rather than aborting the whole
 * sync.
 *
 * The PAT lives in `encryptedApiKey` (AES-256-GCM via `@repo/utils`).
 * The org slug lives in `commandArgs[0]` for ADO's STDIO transport and
 * is parsed out of the host of `baseUrl` for the HTTP transport
 * (`https://dev.azure.com/{org}/…`).
 */
async function resolveAdoAttachmentTarget(
	mcpConfig: {
		encryptedApiKey?: string | null;
		commandArgs?: readonly string[] | string[] | null;
		baseUrl?: string | null;
		mcpServer?: { defaultUrl?: string | null } | null;
	} | null,
): Promise<AdoAttachmentTarget | null> {
	if (!mcpConfig?.encryptedApiKey) {
		return null;
	}
	let pat: string;
	try {
		const { decryptApiKey } = await import("@repo/utils");
		pat = decryptApiKey(mcpConfig.encryptedApiKey);
	} catch (err) {
		logger.warn("[ADO Attachments] PAT decrypt failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
	if (!pat) {
		return null;
	}

	// STDIO transport: `commandArgs` is `[org, ...]`.
	const commandArg = Array.isArray(mcpConfig.commandArgs)
		? mcpConfig.commandArgs[0]
		: null;
	let org = typeof commandArg === "string" ? commandArg : null;

	// HTTP transport: parse `dev.azure.com/{org}` out of `baseUrl` or
	// the server's `defaultUrl`.
	if (!org) {
		const url =
			mcpConfig.baseUrl ?? mcpConfig.mcpServer?.defaultUrl ?? null;
		if (url) {
			const match = url.match(/dev\.azure\.com\/([^/?#]+)/i);
			org = match?.[1] ?? null;
		}
	}
	if (!org) {
		logger.warn(
			"[ADO Attachments] No ADO org resolvable from MCPConfig — skipping attachment upload",
		);
		return null;
	}
	return { pat, org };
}

function convertInlineMarkdown(text: string): string {
	// Escape HTML special characters first to prevent raw text from being
	// interpreted as HTML tags by the PM tool (e.g. "Array<string>" → "Array&lt;string&gt;")
	return (
		escapeHtml(text)
			.replace(
				/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
				(_m, label: string, url: string) =>
					`<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`,
			)
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/\*([^*]+)\*/g, "<em>$1</em>")
			// Inline code `text` → <code>text</code>. The escapeHtml above ran
			// first, so any `<` / `>` inside the backticks is already
			// `&lt;` / `&gt;`. We don't try to detect triple-backtick fenced
			// code blocks here — the markdownToSimpleHtml block handler treats
			// fenced code as a paragraph (limitation, not addressed in this PR).
			.replace(/`([^`]+)`/g, "<code>$1</code>")
	);
}

// =============================================================================
// Fizzy table conversion (Tiptap → Lexxy)
// =============================================================================
//
// Fabric stores Tiptap-authored descriptions as markdown + embedded HTML for
// tables specifically — Tiptap has no markdown serializer for tables, so it
// falls back to inline HTML of the shape:
//
//   <table class="tiptap-table" style="min-width: 75px;">
//     <colgroup><col style="min-width: 25px;">…</colgroup>
//     <tbody>
//       <tr><th colspan="1" rowspan="1"><p>cell</p></th>…</tr>
//       <tr><td colspan="1" rowspan="1"><p>cell</p></td>…</tr>
//     </tbody>
//   </table>
//
// Fizzy uses Lexxy (Basecamp's successor to Trix, the editor used by Rails
// ActionText). Lexxy's HTML sanitizer rejects the Tiptap-specific class,
// inline styles, `colspan`/`rowspan` attributes, and the `<colgroup>` /
// `<col>` tags — the entire `<table>` block is escaped to literal `&lt;table&gt;`
// text and rendered to the user as raw HTML markup (Fizzy card #1355).
//
// The accepted Lexxy shape, verified empirically against a working table on
// Fizzy card #1398, is:
//
//   <figure class="lexxy-content__table-wrapper">
//     <table>
//       <tbody>
//         <tr>
//           <th class="lexxy-content__table-cell--header"><p>cell</p></th>…
//         </tr>
//         <tr>
//           <td><p>cell</p></td>…
//         </tr>
//       </tbody>
//     </table>
//   </figure>
//
// The fix is applied ONLY for Fizzy push (see the call site in
// `syncStoryToPM`). Tables in descriptions bound for any other PM target are
// forwarded byte-for-byte — those tools render Tiptap's table HTML natively.
// =============================================================================

/**
 * Inline tags whose content is preserved unchanged inside Lexxy table cells.
 * Lexxy's sanitizer accepts these — anything else inside a cell is stripped
 * down to its text content.
 */
const LEXXY_CELL_INLINE_TAGS =
	/<\/?(strong|em|b|i|s|del|strike|br|a)(\s[^>]*)?>/gi;

/**
 * Reduce an HTML cell's inner content to Lexxy-safe HTML:
 *  - Strip any nested <p> / </p> (Lexxy expects exactly one <p> per cell —
 *    Tiptap wraps cell content in <p> already and that's where the single
 *    wrapper comes from in the output).
 *  - Drop any tag not in `LEXXY_CELL_INLINE_TAGS`, keeping inner text.
 *  - Empty cells fall back to `<br>` so Lexxy renders an empty line, not a
 *    collapsed cell.
 *
 * NOTE: callers must extract `<img>` tags from `html` BEFORE invoking this —
 * `<img>` is not in `LEXXY_CELL_INLINE_TAGS` so it would be stripped here
 * (this is the original "tables strip images" bug). See `tiptapTableToLexxy`
 * for the in-cell image extraction logic.
 */
function sanitizeLexxyCellContent(html: string): string {
	const stripped = html
		.replace(/<\/?p[^>]*>/gi, "") // drop nested <p> wrappers
		.replace(
			/<(?!\/?(strong|em|b|i|s|del|strike|br|a)(\s[^>]*)?>)[^>]+>/gi,
			"",
		)
		.trim();
	return stripped.length === 0 ? "<br>" : stripped;
}

/**
 * Convert a single `<table>…</table>` HTML block (any flavour — Tiptap or
 * otherwise) to the Lexxy-accepted shape. Returns the empty string for a
 * table with zero rows (drops it so we don't ship an empty <figure>).
 *
 * Image handling: any `<img>` tags found inside `<td>` / `<th>` cells are
 * extracted out of the cell BEFORE sanitization (Lexxy strips images from
 * cells silently — see `sanitizeLexxyCellContent`) and re-emitted as Lexxy
 * attachment `<figure>` blocks appended after the table. This preserves the
 * images while keeping the table row layout intact.
 */
export function tiptapTableToLexxy(tableHtml: string): string {
	// Walk over <tr>…</tr> directly so we tolerate tables with or without
	// an explicit <tbody> wrapper (Tiptap always emits <tbody>, but the
	// sanitizer should not depend on it).
	const rows: string[] = [];
	const extractedImages: ImageRef[] = [];
	const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
	let rowMatch: RegExpExecArray | null;
	while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
		const cellsHtml = rowMatch[1];
		const cells: string[] = [];
		const cellRe = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi;
		let cellMatch: RegExpExecArray | null;
		while ((cellMatch = cellRe.exec(cellsHtml)) !== null) {
			const tag = cellMatch[1].toLowerCase();
			// Extract any <img> tags from the cell before sanitization
			// strips them. The extracted images are appended after the
			// table figure below.
			const { html: cellWithoutImages, images: cellImages } =
				extractImagesFromHtml(cellMatch[2]);
			extractedImages.push(...cellImages);
			const inner = sanitizeLexxyCellContent(cellWithoutImages);
			if (tag === "th") {
				cells.push(
					`<th class="lexxy-content__table-cell--header"><p>${inner}</p></th>`,
				);
			} else {
				cells.push(`<td><p>${inner}</p></td>`);
			}
		}
		if (cells.length > 0) {
			rows.push(`<tr>${cells.join("")}</tr>`);
		}
	}
	if (rows.length === 0) {
		return "";
	}
	const tableFigure = `<figure class="lexxy-content__table-wrapper"><table><tbody>${rows.join("")}</tbody></table></figure>`;
	const imageFigures = extractedImages.map(imageToLexxyFigure).join("");
	return `${tableFigure}${imageFigures}`;
}

/**
 * Sentinel token swapped in for each `<table>` block during the Fizzy push
 * pre-pass. Chosen to be vanishingly unlikely in user-authored text and to
 * survive `escapeHtml` unchanged (no `<`, `>`, or `&` characters).
 */
const FIZZY_TABLE_TOKEN_RE = /__FIZZY_TABLE_(\d+)__/g;
function fizzyTableToken(index: number): string {
	return `__FIZZY_TABLE_${index}__`;
}

/**
 * Pre-pass for the Fizzy push pipeline: extract each `<table>…</table>` block
 * out of the joined description, convert it to Lexxy's accepted shape, and
 * replace the original block with a sentinel token padded by blank lines so
 * `markdownToSimpleHtml` treats it as its own block (and wraps the token in
 * `<p>…</p>` rather than splicing it into an adjacent paragraph).
 *
 * The text returned from this function is fed to the existing
 * `markdownToSimpleHtml` pipeline unchanged — that converter never sees any
 * `<table>` markup, so its `escapeHtml` step has nothing to mangle.
 */
export function extractFizzyTables(input: string): {
	withTokens: string;
	tables: string[];
} {
	const tables: string[] = [];
	// Normalise GFM markdown tables → <table> first: Fabric may store a typed
	// markdown table, and Lexxy renders HTML (not GFM), so a raw GFM table would
	// otherwise ship to Fizzy as literal `|` text.
	const normalized = convertMarkdownTablesToHtml(input);
	// Require the `<table>` opening tag to be followed by typical HTML table
	// scaffolding (`<colgroup>`, `<thead>`, `<tbody>`, or `<tr>`) so that
	// inline-code references like `` `<table>` `` in surrounding prose (the
	// AI bug template emits such references in its triage / hypothesis
	// sections) don't get falsely matched as real tables.
	const withTokens = normalized.replace(
		/<table\b[^>]*>\s*(?=<(?:colgroup|thead|tbody|tr)\b)[\s\S]*?<\/table>/gi,
		(match) => {
			const lexxy = tiptapTableToLexxy(match);
			if (lexxy.length === 0) {
				return ""; // empty table — drop it
			}
			tables.push(lexxy);
			return `\n\n${fizzyTableToken(tables.length - 1)}\n\n`;
		},
	);
	return { withTokens, tables };
}

/**
 * Post-pass for the Fizzy push pipeline: substitute every `<p>token</p>`
 * (the wrapping `markdownToSimpleHtml` adds around the sentinel) with the
 * pre-converted Lexxy `<figure>` block. Also handles the bare-token case
 * (no `<p>` wrapper) defensively in case future changes to
 * `markdownToSimpleHtml` ever skip the wrap.
 */
export function restoreFizzyTables(html: string, tables: string[]): string {
	if (tables.length === 0) {
		return html;
	}
	return html
		.replace(
			new RegExp(`<p>${FIZZY_TABLE_TOKEN_RE.source}</p>`, "g"),
			(_m, idx) => tables[Number(idx)] ?? "",
		)
		.replace(FIZZY_TABLE_TOKEN_RE, (_m, idx) => tables[Number(idx)] ?? "");
}

/**
 * Convert markdown text to simple HTML for PM tools that use HTML rich text editors.
 *
 * Handles the common patterns produced by buildStoryDescription and the
 * AI bug template:
 * - Paragraphs (double-newline separated blocks)
 * - Unordered lists (lines starting with "- " or "* ")
 * - Ordered lists (lines starting with "1. ", "2. ", …)
 * - Inline bold (**text**), italic (*text*), and code (`text`)
 * - Single newlines within a block → <br>
 *
 * This is intentionally a lightweight converter — not a full markdown renderer.
 * It only needs to handle the output of buildStoryDescription and the AI
 * bug template's Steps to Reproduce / Hypotheses sections.
 */
export function markdownToSimpleHtml(markdown: string): string {
	// Extract fenced code blocks (```lang\n…\n```) up front. Their inner blank
	// lines would otherwise be split into separate paragraphs below, and there
	// is no fenced-code branch in the block builder — so the ``` fences would
	// ship to the PM card as literal backtick text (ADO/Fizzy push bug). Each
	// block becomes a sentinel that is restored to <pre><code> at the very end.
	const codeBlocks: string[] = [];
	const withCodeExtracted = markdown.replace(
		/```[^\n`]*\n([\s\S]*?)```/g,
		(_m, code: string) => {
			const escaped = code
				.replace(/\n+$/, "")
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");
			codeBlocks.push(`<pre><code>${escaped}</code></pre>`);
			return `\n\nFABRICCODEBLOCK${codeBlocks.length - 1}\n\n`;
		},
	);

	// Fabric stores a hard line break inside a paragraph as a literal `<br>`
	// (e.g. from a pulled Fizzy `<p>a<br>b</p>` — see simpleHtmlToMarkdown).
	// Normalise it back to "\n" BEFORE the block split + escapeHtml pass, so the
	// per-line paragraph builder re-emits it as `<br>`. Without this, escapeHtml
	// would turn the stored "<br>" into the literal text "&lt;br&gt;" on the PM
	// card. Tables/images/file anchors are already extracted into sentinel
	// tokens upstream, so this only ever touches `<br>` in plain body text.
	const blocks = withCodeExtracted
		.replace(/<br\s*\/?>/gi, "\n")
		.split(/\n\n+/);

	/** Convert a markdown heading line to an HTML heading tag. */
	function headingToHtml(line: string): string {
		const match = line.match(/^(#{1,6})\s+(.*)/);
		if (!match) {
			return `<p>${convertInlineMarkdown(line)}</p>`;
		}
		const level = Math.min(match[1].length, 3); // cap at h3 for PM tools
		const text = convertInlineMarkdown(match[2]);
		return `<h${level}>${text}</h${level}>`;
	}

	// Detect ordered-list lines (`1. text`, `2. text`, …). Matches both
	// `1.` and `1)` for resilience against minor formatting differences in
	// AI-drafted content.
	const OL_LINE_RE = /^\d+[.)]\s+/;
	const UL_LINE_RE = /^[-*]\s+/;
	const stripOrderedPrefix = (line: string) => line.replace(OL_LINE_RE, "");
	const stripUnorderedPrefix = (line: string) => line.replace(UL_LINE_RE, "");

	const htmlBlocks = blocks.flatMap((block) => {
		const trimmed = block.trim();
		if (!trimmed) {
			return "";
		}

		const lines = trimmed.split("\n");

		// Heading block: single line starting with # markers
		if (lines.length === 1 && /^#{1,6}\s+/.test(lines[0])) {
			return headingToHtml(lines[0]);
		}

		// Unordered-list block: every line is `- foo` (or `*`) or blank.
		const isUnorderedListBlock = lines.every(
			(l) => UL_LINE_RE.test(l) || l.trim() === "",
		);
		if (isUnorderedListBlock) {
			const items = lines
				.filter((l) => UL_LINE_RE.test(l))
				.map(
					(l) =>
						`<li>${convertInlineMarkdown(stripUnorderedPrefix(l))}</li>`,
				)
				.join("");
			return `<ul>${items}</ul>`;
		}

		// Ordered-list block: every line is `1. foo`, `2. foo` … or blank.
		const isOrderedListBlock = lines.every(
			(l) => OL_LINE_RE.test(l) || l.trim() === "",
		);
		if (isOrderedListBlock) {
			const items = lines
				.filter((l) => OL_LINE_RE.test(l))
				.map(
					(l) =>
						`<li>${convertInlineMarkdown(stripOrderedPrefix(l))}</li>`,
				)
				.join("");
			return `<ol>${items}</ol>`;
		}

		// Mixed block: split into runs of headings, list items (ordered or
		// unordered), and text. Adjacent ordered-vs-unordered runs each
		// flush into their own `<ol>` / `<ul>` block to keep the markup
		// faithful.
		const hasUnorderedItems = lines.some((l) => UL_LINE_RE.test(l));
		const hasOrderedItems = lines.some((l) => OL_LINE_RE.test(l));
		const hasHeadings = lines.some((l) => /^#{1,6}\s+/.test(l));
		if (hasUnorderedItems || hasOrderedItems || hasHeadings) {
			const parts: string[] = [];
			let nonListBuf: string[] = [];

			const flushNonList = () => {
				if (nonListBuf.length > 0) {
					const html = nonListBuf
						.map((l) => convertInlineMarkdown(l))
						.join("<br>");
					parts.push(`<p>${html}</p>`);
					nonListBuf = [];
				}
			};

			let listBuf: string[] = [];
			let listKind: "ul" | "ol" | null = null;
			const flushList = () => {
				if (listBuf.length > 0 && listKind) {
					const items = listBuf
						.map(
							(l) =>
								`<li>${convertInlineMarkdown(listKind === "ol" ? stripOrderedPrefix(l) : stripUnorderedPrefix(l))}</li>`,
						)
						.join("");
					parts.push(`<${listKind}>${items}</${listKind}>`);
					listBuf = [];
					listKind = null;
				}
			};

			for (const l of lines) {
				if (/^#{1,6}\s+/.test(l)) {
					flushNonList();
					flushList();
					parts.push(headingToHtml(l));
				} else if (UL_LINE_RE.test(l)) {
					flushNonList();
					if (listKind && listKind !== "ul") {
						flushList();
					}
					listKind = "ul";
					listBuf.push(l);
				} else if (OL_LINE_RE.test(l)) {
					flushNonList();
					if (listKind && listKind !== "ol") {
						flushList();
					}
					listKind = "ol";
					listBuf.push(l);
				} else if (l.trim() === "") {
					// skip blank lines
				} else {
					flushList();
					nonListBuf.push(l);
				}
			}
			flushNonList();
			flushList();
			return parts;
		}

		const html = lines
			.map((l) => {
				if (/^#{1,6}\s+/.test(l)) {
					return `<strong>${convertInlineMarkdown(l.replace(/^#{1,6}\s+/, ""))}</strong>`;
				}
				return convertInlineMarkdown(l);
			})
			.join("<br>");
		return `<p>${html}</p>`;
	});

	// Restore fenced code blocks. The block builder wrapped each sentinel in a
	// <p> — drop that wrapper so <pre> isn't nested inside <p> (invalid HTML);
	// the second pass catches any sentinel that didn't end up wrapped.
	return htmlBlocks
		.filter(Boolean)
		.join("")
		.replace(
			/<p>\s*FABRICCODEBLOCK(\d+)\s*<\/p>/g,
			(_m, i: string) => codeBlocks[Number(i)] ?? "",
		)
		.replace(
			/FABRICCODEBLOCK(\d+)/g,
			(_m, i: string) => codeBlocks[Number(i)] ?? "",
		);
}

/**
 * Remove editor highlight (`<mark>`) tags, keeping the text they wrapped.
 *
 * No PM tool renders `<mark>`: markdown-native trackers show the literal tag,
 * and the HTML subset (`markdownToSimpleHtml` → `escapeHtml`) ships it as
 * `&lt;mark…&gt;`. Either way a highlighted phrase reads as garbage on the
 * card, so the tag is dropped before the tool branch runs.
 *
 * The patterns are deliberately WORD-DELIMITED. The naive
 * `/<\/?mark[^>]*>/gi` also matches `<marker>`, `<markdown>` and
 * `Map<markerId, string>` and would silently delete real text — the mirror of
 * the `Array<string>` case that must keep escaping normally. This is a
 * `<mark>` strip, NOT a general HTML stripper.
 *
 * Applied repeatedly because a nested/malformed fragment such as
 * `<ma<mark>rk data-color="x">` reassembles into a valid tag after one pass:
 * removing the inner tag joins the surrounding text back into a live one.
 *
 * The loop is BOUNDED. Each pass rescans the whole string, so an unbounded
 * fixed point is quadratic in nesting depth — measured at ~114ms for a 48KB
 * crafted line, and `description` is `@db.Text` with no length validation
 * upstream, on a path that runs inside a Temporal workflow. That is the
 * CPU-exhaustion shape `docs/solutions/security-issues/redos-in-preview-markdown-strip.md`
 * warns about: bound the work at the boundary rather than trusting the input.
 *
 * Real editor output nests one level deep, so the cap is never reached in
 * practice. If it ever is, the final sweep ESCAPES rather than deletes, so
 * correctness does not depend on the loop converging.
 *
 * The sweep must not delete. Deleting splices the neighbours together, which is
 * the very reassembly the loop exists to defeat: a delete-sweep turns the inert
 * fragment `<ma</markrk>` into a live `<mark>`, and would also eat the literal
 * text `<marker` / `Map<markerId, …>` this path deliberately preserves.
 * Escaping the `<` removes no characters, so nothing can rejoin
 * ("mangle, don't delete" — `CONCEPTS.md`).
 */
const MAX_HIGHLIGHT_STRIP_PASSES = 10;

function stripHighlightMarks(text: string): string {
	let current = text;
	for (let pass = 0; pass < MAX_HIGHLIGHT_STRIP_PASSES; pass++) {
		const next = current
			.replace(/<mark(?=[\s/>])[^>]*>/gi, "")
			.replace(/<\/mark\s*>/gi, "");
		if (next === current) {
			return current;
		}
		current = next;
	}
	// Cap hit — adversarial nesting only. Neutralize every remaining opener by
	// escaping it; see the docstring for why this must not be a delete.
	return current.replace(/<(?=\/?mark)/gi, "&lt;");
}

/**
 * Clean stored content for PM tool display.
 * - Strips ### heading markers and **bold** wrappers from section headers
 * - Strips editor highlight (`<mark>`) tags, keeping the highlighted text
 * - Preserves line breaks and content structure
 */
export function cleanContentForPM(content: string): string {
	return content
		.split("\n")
		.map((rawLine) => {
			// Drop highlight tags FIRST so a decorated heading such as
			// `### <mark>**Feature Story**</mark>` still matches the
			// heading-decoration rules below.
			const line = stripHighlightMarks(rawLine);
			// Preserve heading markers for markdownToSimpleHtml to convert to <h2>/<h3>.
			// Only strip redundant **bold** inside headings: ### **Feature Story** → ### Feature Story
			if (/^#{1,6}\s+\*{2}.+\*{2}\s*$/.test(line)) {
				return line.replace(/\*{2}([^*]+)\*{2}/g, "$1");
			}
			// Strip **bold** from GIVEN/WHEN/THEN/AND keywords but keep the text
			return line.replace(/\*{2}(GIVEN|WHEN|THEN|AND)\*{2}/g, "$1");
		})
		.join("\n");
}

/**
 * Strip leaked EPIC/FEAT headers, trailing "Acceptance Criteria", separators, and junk.
 * Handles both markdown (## FEAT-001:) and plain text (FEAT-001:) variants.
 */
function stripTrailingJunk(text: string): string {
	return text
		.replace(/\n?#{1,3}\s*(EPIC|FEAT)-\d+:[\s\S]*$/i, "")
		.replace(/\n?(EPIC|FEAT)-\d+:[\s\S]*$/i, "")
		.replace(/\n?Acceptance Criteria\s*$/i, "")
		.replace(/\n?\*\s*\*\s*\*\s*$/i, "")
		.replace(/\n?---\s*$/i, "")
		.trim();
}

/**
 * Build a description for a story to sync to PM tool.
 *
 * Handles both cleanly-parsed stories and legacy data where sections
 * may be mixed (e.g. Notes/Links and Release Notes inside acceptanceCriteria).
 */
export function buildStoryDescription(story: {
	description?: string | null;
	acceptanceCriteria?: string | null;
	releaseNotes?: string | null;
	priority?: StoryPriority | null;
	size?: StorySize | null;
	storyPoints?: number | null;
	labels?: string[] | null;
}): string {
	const parts: string[] = [];

	// Extract the "View in Fabric" back-link wherever it currently lives
	// (acceptanceCriteria first, then description) so it can be re-appended
	// as the LAST `parts.push(...)` call — after AC, Notes/Links, and
	// Release Notes. `placeFabricBackLink` puts the anchor at the end of
	// acceptanceCriteria when AC is non-empty (visual UI end of the card);
	// legacy stories still have it at the end of description, hence the two-
	// column lookup.
	//
	// Byte-for-byte invariant: when the back-link is already in description
	// AND no other section (AC, Release Notes) would follow it, leave the
	// description string untouched. This preserves the round-trip pull→push
	// behaviour for ADO (System.Description goes through verbatim via the
	// raw `rawDescription` path below) and any other tool that compares
	// hashes of stored content.
	let descriptionRaw = story.description ?? "";
	let acceptanceCriteriaRaw = story.acceptanceCriteria ?? "";
	const acBackLinkMatch = acceptanceCriteriaRaw.match(HTML_BACK_LINK_RE);
	const descBackLinkMatch = acBackLinkMatch
		? null
		: descriptionRaw.match(HTML_BACK_LINK_RE);
	const hasContentAfterDescription =
		acceptanceCriteriaRaw.trim().length > 0 ||
		(story.releaseNotes ?? "").trim().length > 0;
	let backLinkMatch: RegExpMatchArray | null = null;
	if (acBackLinkMatch) {
		// Back-link is in AC → always extract so it lands as the absolute
		// last block, after any Notes/Links / Release Notes that get
		// extracted out of AC below.
		backLinkMatch = acBackLinkMatch;
		acceptanceCriteriaRaw = acceptanceCriteriaRaw
			.replace(HTML_BACK_LINK_RE, "")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	} else if (descBackLinkMatch && hasContentAfterDescription) {
		// Back-link is in description AND something else (AC / release
		// notes) would follow it in the joined payload → extract so it
		// lands last instead of mid-document.
		backLinkMatch = descBackLinkMatch;
		descriptionRaw = descriptionRaw
			.replace(HTML_BACK_LINK_RE, "")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}
	// Otherwise: back-link is at the end of description and nothing follows
	// — leave it where it is so the description string round-trips byte-
	// for-byte through the ADO verbatim push path.

	// Clean description: strip all "User Story" headers (plain, bold, markdown heading)
	let description = descriptionRaw;
	description = description
		.replace(/^#{1,6}\s*\*{0,2}User Story\*{0,2}\s*\n*/i, "")
		.replace(/^\*{0,2}User Story\*{0,2}\s*\n*/i, "")
		.replace(/^User Story\s*\n*/i, "")
		.trim();
	if (description) {
		description = cleanContentForPM(description);
		parts.push(description);
	}

	// Clean acceptance criteria: extract Notes/Links and Release Notes if embedded
	// Use the back-link-stripped version so the trailing anchor doesn't trip
	// the Notes/Links / Release Notes regexes below.
	let ac = acceptanceCriteriaRaw;
	let extractedNotesLinks = "";
	let extractedReleaseNotes = "";

	// Extract and remove "Notes / Links" section from AC
	const notesMatch = ac.match(
		/\n?#{0,6}\s*\*{0,2}Notes\s*[/&]\s*Links\*{0,2}\s*\n([\s\S]*?)(?=\n#{0,6}\s*\*{0,2}Release Notes|$)/i,
	);
	if (notesMatch) {
		extractedNotesLinks = notesMatch[1].trim();
		ac = ac.replace(notesMatch[0], "");
	}
	// Also try plain text "Notes / Links" header
	if (!extractedNotesLinks) {
		const plainNotesMatch = ac.match(
			/\n?Notes\s*[/&]\s*Links\s*\n([\s\S]*?)(?=\nRelease Notes|$)/i,
		);
		if (plainNotesMatch) {
			extractedNotesLinks = plainNotesMatch[1].trim();
			ac = ac.replace(plainNotesMatch[0], "");
		}
	}

	// Extract and remove "Release Notes" section from AC (if not stored separately)
	if (!story.releaseNotes) {
		const rnMatch = ac.match(
			/\n?#{0,6}\s*\*{0,2}Release Notes\*{0,2}\s*\n([\s\S]*?)$/i,
		);
		if (rnMatch) {
			extractedReleaseNotes = rnMatch[1].trim();
			ac = ac.replace(rnMatch[0], "");
		}
		// Also try plain text "Release Notes" header
		if (!extractedReleaseNotes) {
			const plainRnMatch = ac.match(/\n?Release Notes\s*\n([\s\S]*?)$/i);
			if (plainRnMatch) {
				extractedReleaseNotes = plainRnMatch[1].trim();
				ac = ac.replace(plainRnMatch[0], "");
			}
		}
	}

	// Strip any leaked EPIC/FEAT headers and trailing junk from AC
	ac = stripTrailingJunk(ac);

	if (ac) {
		ac = cleanContentForPM(ac);
		parts.push(`**Acceptance Criteria:**\n\n${ac}`);
	}

	// Notes / Links: prefer extracted from AC
	if (extractedNotesLinks) {
		parts.push(
			`**Notes / Links:**\n\n${cleanContentForPM(extractedNotesLinks)}`,
		);
	}

	// Release notes: prefer stored field, fall back to extracted from AC
	const releaseNotes = stripTrailingJunk(
		(story.releaseNotes ?? extractedReleaseNotes).trim(),
	);
	if (releaseNotes) {
		parts.push(`**Release Notes:**\n\n${cleanContentForPM(releaseNotes)}`);
	}

	// Re-append the "View in Fabric" back-link as the LAST part so it lands
	// at the very bottom of the PM-tool card regardless of which column it
	// was originally stored in.
	if (backLinkMatch) {
		parts.push(backLinkMatch[0]);
	}

	return parts.join("\n\n");
}

/**
 * The label values pushed to a PM tool. ONLY `story.labels` (GitLab status-
 * mapping) is ever synced — custom tags (StoryTag / UserStory.tags) are
 * Fabric-internal and must NEVER leave Fabric (spec 2026-06-15-custom-tags §5).
 * All PM-bound label args MUST flow through this helper so a future edit cannot
 * accidentally push tags; the regression test below pins that it ignores tags.
 */
export function pmLabelValues(story: { labels?: string[] | null }): string[] {
	return story.labels ?? [];
}

/**
 * Extract external ID and URL from MCP tool response
 *
 * Uses dynamic discovery: if idParamHint is provided (from the update tool's schema),
 * it looks for that field first. This allows the system to adapt to any PM tool's
 * ID convention without hardcoding.
 *
 * @param output - The MCP tool response
 * @param options - Optional configuration
 * @param options.baseUrl - Base URL from MCP config to resolve relative paths
 * @param options.idParamHint - The ID parameter name from the update tool's schema
 *                              (e.g., "card_number" for Fizzy, "issue_key" for Jira)
 */
function extractExternalInfo(
	output: unknown,
	options?: {
		baseUrl?: string | null;
		idParamHint?: string;
	},
): {
	externalId?: string;
	externalUrl?: string;
} {
	if (!output) {
		return {};
	}

	let data = output as Record<string, unknown>;

	// Handle MCP response format with content array
	if (Array.isArray(data.content)) {
		const textContent = data.content.find(
			(c: unknown) =>
				typeof c === "object" &&
				c !== null &&
				(c as Record<string, unknown>).type === "text",
		) as { text?: string } | undefined;
		if (textContent?.text) {
			try {
				data = JSON.parse(textContent.text);
			} catch {
				// Not JSON, use as-is
			}
		}
	}

	// DYNAMIC DISCOVERY: Use idParamHint from the update tool's schema first
	// This allows the system to adapt to any PM tool's ID convention (MCP discovery pattern)
	// e.g., Fizzy uses "number", Jira uses "issue_key", GitHub uses "issue_number"
	const { idParamHint } = options || {};
	let externalId: string | undefined;

	if (idParamHint && data[idParamHint] !== undefined) {
		// Found the exact field from discovered schema
		externalId = String(data[idParamHint]);
		logger.info("[Extract] Using dynamically discovered ID field", {
			idParamHint,
			externalId,
		});
	} else {
		// Fallback: Try common ID field names from shared patterns
		// This is only used when idParamHint isn't provided or doesn't match
		for (const field of COMMON_ID_FIELDS) {
			if (data[field] !== undefined) {
				externalId = String(data[field]);
				if (!idParamHint) {
					logger.info(
						"[Extract] Using fallback ID field (no hint provided)",
						{
							field,
							externalId,
						},
					);
				} else {
					logger.warn(
						"[Extract] idParamHint field not found, using fallback",
						{
							idParamHint,
							fallbackField: field,
							externalId,
						},
					);
				}
				break;
			}
		}
	}

	// HATEOAS web URL (Azure DevOps `_links.html.href`) wins over top-level
	// `url` — the latter is the REST-API endpoint and would render JSON in
	// the browser when the user clicks "Open in PM tool" from the roadmap.
	let rawUrl: string | undefined = extractWebUrlFromLinks(data);
	if (!rawUrl) {
		for (const field of COMMON_URL_FIELDS) {
			if (data[field] !== undefined) {
				rawUrl = String(data[field]);
				break;
			}
		}
	}

	// Normalize URL to ensure it's absolute (not relative)
	// Uses shared normalizeUrl from @repo/utils
	const externalUrl = normalizeUrl(rawUrl, options?.baseUrl);

	return { externalId, externalUrl };
}

/**
 * Best-effort JSON unwrap for a MCP text-content payload. Returns the parsed
 * object when `t` is a JSON string, the value itself when it's already an
 * object, or `undefined` on parse failure / nullish input. Used by the #1360
 * pull reconcile to recover the RAW item object (which carries `closed` /
 * `column`) that `parsePMItemFromGetOutput` discards.
 */
function safeParseMaybeJson(t: unknown): Record<string, unknown> | undefined {
	try {
		if (typeof t === "string") {
			return JSON.parse(t) as Record<string, unknown>;
		}
		return t && typeof t === "object"
			? (t as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

// =============================================================================
// Custom field read-mapping — replace-mode aggregation
// =============================================================================

/**
 * Options injected into {@link parsePMItemFromGetOutput} so it can decide whether
 * to compose the description body from the admin-configured field mapping
 * (replace-mode) instead of the legacy ADO precedence chain. All three are read
 * off the loaded Project row by the caller; the parse function stays pure.
 */
export interface FieldMappingReplaceOptions {
	/** Runtime connected provider (`capabilities.detectedType`). */
	connectedProvider?: string | null;
	/** Parsed `fieldMapping` config, or null when absent/malformed/legacy. */
	config?: FieldMappingConfig | null;
	/** Project-level feature flag `pmFieldMappingEnabled`. */
	enabled?: boolean;
}

/** Why replace-mode did or did not engage — surfaced in observability logs. */
export type ReplaceModeReason =
	| "engaged"
	| "no-config"
	| "empty-selection"
	| "provider-mismatch"
	| "flag-off";

/**
 * Pure activation check. Replace-mode engages ONLY when all hold:
 * a non-null config with a non-empty `fields[]`, a provider match, and the flag
 * on. The most-specific failing reason is returned for logging.
 */
export function evaluateReplaceModeActivation(
	options: FieldMappingReplaceOptions,
): { engaged: boolean; reason: ReplaceModeReason } {
	const { config, connectedProvider, enabled } = options;
	if (!config) {
		return { engaged: false, reason: "no-config" };
	}
	if (config.fields.length === 0) {
		return { engaged: false, reason: "empty-selection" };
	}
	if (config.provider !== connectedProvider) {
		return { engaged: false, reason: "provider-mismatch" };
	}
	if (!enabled) {
		return { engaged: false, reason: "flag-off" };
	}
	return { engaged: true, reason: "engaged" };
}

/**
 * Pure assembly of the replace-mode description body. Iterates the
 * configured fields IN ORDER, reads each by `id` (referenceName) from the ADO
 * get-output `fields` object, omits empty/blank fields entirely, and emits a
 * `## <displayName>` heading + the per-field value converted via
 * {@link simpleHtmlToMarkdown}. Sections are separated by a blank line.
 *
 * Returns `undefined` when every configured field is blank/absent — the caller
 * threads that straight through so `updateStory` does not clobber existing
 * Fabric content ("don't clobber" semantics).
 */
export function assembleFieldMappingDescription(
	fields: Record<string, unknown> | undefined,
	config: FieldMappingConfig,
): string | undefined {
	if (!fields) {
		return undefined;
	}
	const sections: string[] = [];
	for (const field of config.fields) {
		const raw = fields[field.id];
		let value: string;
		if (typeof raw === "string") {
			value = simpleHtmlToMarkdown(raw).trim();
		} else if (typeof raw === "number" || typeof raw === "boolean") {
			value = String(raw).trim();
		} else {
			// null / undefined / object (e.g. identity fields) → treat as empty.
			continue;
		}
		if (!value) {
			continue;
		}
		sections.push(`## ${field.displayName}\n\n${value}`);
	}
	return sections.length > 0 ? sections.join("\n\n") : undefined;
}

/**
 * Load the replace-mode context off the Project row: the feature flag and the
 * `fieldMapping` config parsed from `projectManagementAdditionalContext`. Kept
 * out of {@link parsePMItemFromGetOutput} so that stays pure/options-injected.
 */
async function loadProjectFieldMappingContext(
	projectId: string,
): Promise<{ enabled: boolean; config: FieldMappingConfig | null }> {
	// Fail-safe: a failure to load the flag/config must NEVER break a sync — it
	// falls back to the legacy precedence chain (the safe default). readFieldMapping
	// itself never throws (malformed → null); this guards the DB read only.
	try {
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: {
				pmFieldMappingEnabled: true,
				projectManagementAdditionalContext: true,
			},
		});
		if (!project) {
			return { enabled: false, config: null };
		}
		return {
			enabled: project.pmFieldMappingEnabled === true,
			config: readFieldMappingConfig(
				project.projectManagementAdditionalContext,
			),
		};
	} catch (error) {
		logger.warn(
			"[Story Sync] Failed to load field-mapping context — using legacy chain",
			{ error: error instanceof Error ? error.message : String(error) },
		);
		return { enabled: false, config: null };
	}
}

/**
 * Parse get-tool output into title, description, labels, column/status, and external refs.
 * Used when pulling from PM tool so we update the local story with as much card data as possible.
 * Supports common field names across Fizzy, Jira, Linear, etc.
 */
export function parsePMItemFromGetOutput(
	output: unknown,
	options?: {
		baseUrl?: string | null;
		idParamHint?: string;
		/**
		 * Custom field read-mapping. When present AND active
		 * (config + provider match + flag on), the description body is composed
		 * from the configured fields instead of the legacy ADO precedence chain.
		 * Absent → today's behavior byte-for-byte.
		 */
		fieldMapping?: FieldMappingReplaceOptions;
	},
): {
	title?: string;
	description?: string | null;
	labels?: string[] | null;
	columnName?: string | null;
	columnId?: string | null;
	externalId?: string;
	externalUrl?: string;
	workItemType?: string;
} {
	const extracted = extractExternalInfo(output, options);
	if (!output || typeof output !== "object") {
		return extracted;
	}
	let data = output as Record<string, unknown>;
	if (Array.isArray(data.content)) {
		const textContent = (
			data.content as Array<{ type?: string; text?: string }>
		).find((c) => c.type === "text");
		if (textContent?.text) {
			try {
				data = JSON.parse(textContent.text) as Record<string, unknown>;
			} catch {
				return extracted;
			}
		}
	}
	// Azure DevOps: fields["System.Title"], fields["System.Description"]
	// Jira (Atlassian Rovo): fields.summary, fields.description, fields.status,
	// fields.labels — everything is nested under `fields`, so without these the
	// pull parses nothing and the sync logs a false-success no-op.
	const fields = data.fields as Record<string, unknown> | undefined;
	const title =
		typeof data.title === "string"
			? data.title
			: typeof data.name === "string"
				? data.name
				: typeof data.summary === "string"
					? data.summary
					: typeof fields?.summary === "string"
						? fields.summary
						: ((fields?.["System.Title"] ??
								fields?.["System.Name"]) as string | undefined);
	const legacyDescription =
		// Fizzy (Action Text) returns BOTH `description` (plain_text — attachments
		// collapse to `[filename]` placeholders) and `description_html` (the real
		// <action-text-attachment>/<img> markup). Prefer the HTML so the Fizzy
		// pull path's simpleHtmlToMarkdown + image ingester have real tags/URLs
		// to re-host (#1471). Other providers don't emit `description_html`, so
		// this is a no-op for them.
		(typeof data.description_html === "string" && data.description_html
			? data.description_html
			: undefined) ??
		(typeof data.description === "string" ? data.description : undefined) ??
		(typeof data.body === "string" ? data.body : undefined) ??
		(typeof data.content === "string" ? data.content : undefined) ??
		(typeof data.details === "string" ? data.details : undefined) ??
		// Jira (Rovo) returns fields.description as an ADF document, not a
		// string — flatten it to text before it feeds pull/update + hashing.
		descriptionToText(fields?.description) ??
		// ADO Bugs store the body in Repro Steps, not System.Description —
		// prefer it (undefined for User Stories / legacy bugs, so they fall
		// through to System.Description).
		((fields?.["Microsoft.VSTS.TCM.ReproSteps"] ??
			fields?.["System.Description"] ??
			fields?.["System.History"]) as string | undefined);

	// Custom field read-mapping: when replace-mode is active
	// (config present + provider match + flag on), compose the body from the
	// admin-configured fields IN ORDER instead of the legacy precedence chain.
	// Absent `fieldMapping` option → legacy behavior byte-for-byte (no new logs).
	// When engaged, the assembled result is threaded through UNCHANGED even if it
	// is `undefined` (all configured fields blank) so the legacy value never
	// leaks back and "don't clobber" is preserved.
	let description = legacyDescription;
	if (options?.fieldMapping) {
		const activation = evaluateReplaceModeActivation(options.fieldMapping);
		if (activation.engaged && options.fieldMapping.config) {
			description = assembleFieldMappingDescription(
				fields,
				options.fieldMapping.config,
			);
			logger.info("[Story Sync] Field-mapping replace-mode engaged", {
				fieldCount: options.fieldMapping.config.fields.length,
				producedBody: description !== undefined,
			});
		} else {
			logger.info(
				"[Story Sync] Field-mapping replace-mode fell back to legacy chain",
				{ reason: activation.reason },
			);
		}
	}

	// Labels/tags: array of strings or array of { name: string }
	// (Jira nests labels under fields.labels.)
	let labels: string[] | null = null;
	const rawTags =
		data.tags ?? data.labels ?? data.label_names ?? fields?.labels;
	if (Array.isArray(rawTags)) {
		labels = rawTags
			.map((t) =>
				typeof t === "string" ? t : (t as { name?: string })?.name,
			)
			.filter((s): s is string => typeof s === "string");
	} else if (typeof rawTags === "string") {
		labels = rawTags ? [rawTags] : null;
	}

	// Column/status for Kanban position (Fizzy: column.name, column_id; Jira:
	// fields.status.{name,id}; etc.)
	let columnName: string | null = null;
	let columnId: string | null = null;
	const col = data.column ?? data.status ?? fields?.status;
	if (typeof col === "string") {
		columnName = col;
	} else if (col && typeof col === "object") {
		const c = col as Record<string, unknown>;
		if (typeof c.name === "string") {
			columnName = c.name;
		}
		if (typeof c.id === "string") {
			columnId = c.id;
		}
	}
	if (typeof data.column_id === "string") {
		columnId = data.column_id;
	}
	if (typeof data.column_name === "string") {
		columnName = data.column_name;
	}
	if (typeof data.status_name === "string" && !columnName) {
		columnName = data.status_name;
	}

	const fieldsObj =
		data.fields && typeof data.fields === "object"
			? (data.fields as Record<string, unknown>)
			: undefined;
	const workItemType = extractWorkItemType(data, fieldsObj);

	return {
		...extracted,
		title,
		// Return description as-is: undefined when PM had no description field, so updateStory path won't overwrite existing Fabric description (consumer checks !== undefined)
		description,
		labels: labels ?? null,
		columnName,
		columnId,
		workItemType,
	};
}

// =============================================================================
// PM Tool Capabilities Discovery
// =============================================================================

/**
 * Typed result of {@link discoverPMToolCapabilitiesResult}. The error branch
 * carries the underlying `McpClientError` code so callers (e.g. the conflict
 * preview) can map it to a user-facing "credentials missing / expired" state
 * instead of silently degrading to "no conflict".
 */
export type DiscoverPMToolCapabilitiesResult =
	| { ok: true; capabilities: PMToolCapabilities }
	| { ok: false; error: { code: string; message: string } };

/**
 * Discover PM tool capabilities, preserving the typed failure reason.
 * Uses getMcpClientResult from @repo/agent-core/backend - supports STDIO
 * (Azure DevOps) via wrapper, HTTP, and SSE transports.
 *
 * Prefer this over {@link discoverPMToolCapabilities} when the failure reason
 * matters; the latter collapses errors to `null` for backwards compatibility.
 */
export async function discoverPMToolCapabilitiesResult(params: {
	mcpConfigId: string | null;
	mcpServerId?: string;
	userId: string;
	organizationId?: string;
	containerId?: string | null;
	/**
	 * Opt-in overall timeout (ms) for the connect + tool-list + analyze step. On
	 * timeout the function returns `{ ok:false, error:{ code:"DISCOVERY_TIMEOUT" } }`
	 * and — via the outer `finally` — still closes the discovery client it opened
	 * (finding 10). Existing callers omit it and keep the unbounded behavior.
	 */
	timeoutMs?: number;
}): Promise<DiscoverPMToolCapabilitiesResult> {
	const { mcpConfigId, userId, organizationId, timeoutMs } = params;

	// REST-GitLab branch: mcpConfigId is null. Synthesize a static
	// PMToolCapabilities shape that advertises the pull-side surface
	// (taskList + taskGet) so the workflow's capability guard passes and
	// proceeds to listWorkItemsFromPM / fetchPMItemsByIds, both of which
	// have their own REST branches that bypass tool-name dispatch and
	// call callPmToolWithFallback directly.
	//
	// Push (taskCreation / taskUpdate) is intentionally omitted: syncStoryToPM
	// rejects mcpConfigId == null with a clear error, and the workflow's
	// push branch invokes executeMcpTool by tool name — neither is REST-aware
	// yet. Advertising those capabilities here would route REST runs into
	// MCP-only code paths.
	//
	// Tool names are sentinel strings (never invoked) because:
	//   - workflow.ts only reads them for log messages on the pull path
	//   - listWorkItemsFromPM/fetchPMItemsByIds short-circuit to
	//     callPmToolWithFallback on `source.kind === "rest-gitlab"` BEFORE
	//     consulting capabilities.taskList.toolName
	if (mcpConfigId == null) {
		logger.info(
			"[PM Discovery] Synthesizing REST-GitLab capabilities (pull-only surface)",
			{
				mcpServerId: params.mcpServerId,
				userId,
				organizationId,
				gitlabRestCapabilities: GITLAB_REST_CAPABILITIES,
			},
		);
		return {
			ok: true,
			capabilities: {
				hasPMCapabilities: true,
				detectedType: "gitlab",
				containerHierarchy: [],
				availableTools: [],
				taskList: {
					toolName: "__rest_gitlab_list__",
					containerParam: "project_id",
					filterParams: [],
					paginationInfo: {
						style: "offset-page",
						pageParam: "page",
						pageSizeParam: "pageSize",
					},
					allParams: [],
				},
				taskGet: {
					toolName: "__rest_gitlab_get__",
					idParam: "issue_iid",
					additionalRequiredParams: [],
					allParams: [],
				},
			},
		};
	}

	// Close the non-cached discovery client AT MOST ONCE, from whichever path
	// reaches it first, so cleanup is robust to both slow-call shapes when a
	// timeout wins the race:
	//  - a hung `client.tools()` (finding 10): the client is already assigned by
	//    timeout time, so the OUTER post-race `finally` below closes it promptly
	//    (aborting the hung request) — `discover()` itself may never settle.
	//  - a slow `getMcpClientResult` connect (finding 12): the timeout wins while
	//    `client` is still undefined, so the outer finally no-ops; the detached
	//    `discover()` keeps running, assigns the client late, and its OWN finally
	//    closes it when the task finally settles.
	// The synchronous check-and-set (no await before setting the flag) makes the
	// once-guard safe against the two finallys running concurrently.
	let client: Parameters<typeof closeMcpClientSafe>[0] | undefined;
	let clientClosed = false;
	// Set when the timeout wins the race, so a slow connect that assigns the
	// client AFTER the timeout can bail before a (possibly hung) tools() call
	// strands it — the compound slow-connect-then-hung-tools race (finding 13).
	let timedOut = false;
	const closeClientOnce = async (): Promise<void> => {
		if (!client || clientClosed) {
			return;
		}
		clientClosed = true;
		await closeMcpClientSafe(client);
	};

	// Inner work — connect, list tools, analyze. Extracted so it can be raced
	// against a timeout (finding 10). Assigns the outer `client` (closure).
	const discover = async (): Promise<DiscoverPMToolCapabilitiesResult> => {
		try {
			const result = await getMcpClientResult(
				mcpConfigId,
				userId,
				organizationId,
			);
			if (!result.ok) {
				logger.warn("[PM Discovery] client creation failed", {
					mcpConfigId,
					code: result.error.code,
				});
				return { ok: false, error: result.error };
			}

			client = result.client;
			// If the timeout already won the race during the (slow) connect above,
			// do NOT proceed into client.tools() — it may hang and strand this
			// late-assigned client, because the outer finally already ran while
			// `client` was still undefined (finding 13). Close it now and bail;
			// discover()'s return value is discarded (the race resolved to the
			// timeout result).
			if (timedOut) {
				await closeClientOnce();
				return {
					ok: false,
					error: {
						code: "DISCOVERY_TIMEOUT",
						message: "PM capability discovery timed out",
					},
				};
			}
			const { serverName } = result;

			// List available tools
			let tools = await client.tools();
			let toolNames = Object.keys(tools);

			// If the timeout won while THIS first tools() was in flight and it
			// resolved late, bail before entering the refresh-retry — the borrow
			// (getCachedMcpClientForConfig) is itself an MCP/cache-mutating op (it can
			// health-check, close stale clients, create + cache a new one), not a pure
			// read, so it must not start after the discovery timeout already returned
			// (finding 17 — the pre-borrow companion to the finding-16 post-borrow
			// bail). No await stands between here and getCachedMcpClientForConfig, so
			// this fully closes the late-first-tools → borrow hole.
			if (timedOut) {
				return {
					ok: false,
					error: {
						code: "DISCOVERY_TIMEOUT",
						message: "PM capability discovery timed out",
					},
				};
			}

			// An empty tool list in the worker usually means the OAuth token needed
			// a refresh that this non-cached discovery client (getMcpClient, no
			// redirectUri) didn't perform. Observed for Atlassian Rovo save/
			// auto-push: discovery returned 0 tools → "does not have required
			// capabilities", while executeMcpTool (cached client WITH redirectUri)
			// could still call the create tool. Retry once via that same refreshing
			// client path before concluding the server has no PM capabilities.
			if (toolNames.length === 0) {
				logger.warn(
					"[PM Discovery] Empty tool list — retrying via cached OAuth-refreshing client",
					{ mcpConfigId, serverName },
				);
				try {
					// The refresh-retry borrows a client from the SHARED MCP client
					// cache (it may be a `fromCache` entry an unrelated concurrent call
					// is using). We deliberately never close or invalidate it on our own
					// timeout (findings 14, 15) — the cache owns its lifecycle. See the
					// outer finally.
					const refreshed = await getCachedMcpClientForConfig({
						configId: mcpConfigId,
						userId,
						organizationId,
						redirectUri: `${getBaseUrl()}/api/mcp/oauth/callback`,
					});
					// If the discovery timeout already won while this cache borrow was
					// in flight (a slow getCachedMcpClientForConfig), do NOT start a new
					// refreshed.client.tools() request — it could hang and strand this
					// detached discover() forever (finding 16, the refresh-retry analogue
					// of the owned-client bail in finding 13). Bail before touching it;
					// the borrowed client is cache-managed, so we leave it to the cache's
					// own lifecycle (finding 15). discover()'s result is discarded here
					// (the race already resolved to the timeout).
					if (timedOut) {
						return {
							ok: false,
							error: {
								code: "DISCOVERY_TIMEOUT",
								message: "PM capability discovery timed out",
							},
						};
					}
					const retryTools = await refreshed.client.tools();
					if (Object.keys(retryTools).length > 0) {
						tools = retryTools as typeof tools;
						toolNames = Object.keys(retryTools);
						logger.info(
							"[PM Discovery] Recovered tools via refreshing client",
							{ mcpConfigId, toolCount: toolNames.length },
						);
					}
				} catch (refreshError) {
					logger.warn(
						"[PM Discovery] Refreshing-client retry failed",
						{
							mcpConfigId,
							error:
								refreshError instanceof Error
									? refreshError.message
									: String(refreshError),
						},
					);
				}
			}

			logger.info("[PM Discovery] Listed tools from server", {
				mcpConfigId,
				serverName,
				toolCount: toolNames.length,
				tools: toolNames,
			});

			// Convert to McpToolDefinition format for analyzer
			const toolDefs: Record<string, McpToolDefinition> = {};
			for (const [name, tool] of Object.entries(tools)) {
				const toolAny = tool as Record<string, unknown>;
				let schema: ToolInputSchema | undefined;

				// Extract schema from AI SDK format
				if (toolAny.inputSchema) {
					const inputSchema = toolAny.inputSchema as Record<
						string,
						unknown
					>;
					if (inputSchema.jsonSchema) {
						schema = inputSchema.jsonSchema as ToolInputSchema;
					} else if (inputSchema.type || inputSchema.properties) {
						schema = inputSchema as ToolInputSchema;
					}
				}

				toolDefs[name] = {
					name,
					description: toolAny.description as string | undefined,
					inputSchema: schema,
				};
			}

			// Analyze capabilities using the tool analyzer. Pass the MCP server's
			// display name as a hint so vendors whose tool names don't carry the
			// brand (GitLab → list_issues / get_issue / …) still get a detectedType.
			const capabilities = analyzePMToolCapabilities(toolDefs, {
				serverHint: serverName,
			});

			logger.info("[PM Discovery] Analyzed capabilities", {
				mcpConfigId,
				serverName,
				hasPMCapabilities: capabilities.hasPMCapabilities,
				detectedType: capabilities.detectedType,
				canCreate: !!capabilities.taskCreation,
				canUpdate: !!capabilities.taskUpdate,
				canGet: !!capabilities.taskGet,
				createTool: capabilities.taskCreation?.toolName,
				updateTool: capabilities.taskUpdate?.toolName,
				getTool: capabilities.taskGet?.toolName,
			});

			return { ok: true, capabilities };
		} catch (error) {
			logger.error("[PM Discovery] Failed to discover capabilities", {
				mcpConfigId,
				error: error instanceof Error ? error.message : String(error),
			});
			return {
				ok: false,
				error: {
					code: "DISCOVERY_FAILED",
					message:
						error instanceof Error ? error.message : String(error),
				},
			};
		} finally {
			// Closes the client when discover() settles — the late-connect path
			// (finding 12). No-ops if the outer finally already closed it.
			await closeClientOnce();
		}
	};

	try {
		const result = timeoutMs
			? await runWithTimeout<DiscoverPMToolCapabilitiesResult>(
					discover(),
					timeoutMs,
					() => {
						timedOut = true;
						return {
							ok: false,
							error: {
								code: "DISCOVERY_TIMEOUT",
								message: "PM capability discovery timed out",
							},
						};
					},
				)
			: await discover();
		return result;
	} finally {
		// Close ONLY the client this discovery exclusively owns — the non-cached
		// `getMcpClient` discovery client tracked by `client`. Closes it if the
		// timeout won while it was already assigned (a hung tools() — finding 10),
		// aborting the hung request without waiting for the detached discover() to
		// settle (which it may never do). No-ops on the late-connect path (client
		// still undefined here; the late client is closed by discover()'s own
		// finally / the timedOut bail).
		//
		// We deliberately do NOT invalidate the shared MCP client cache on timeout.
		// The empty-tools refresh-retry borrows a client via getCachedMcpClientForConfig
		// that may be a `fromCache` entry an unrelated concurrent MCP call is using;
		// invalidateMcpClientCache would close+evict that shared entry (findings 14,
		// 15 — only close what you exclusively own). A possibly-hung refresh-retry
		// client is left to the cache's own expiry/staleness/LRU lifecycle; our
		// bounded discovery still returns a clean empty partial, so the poll keeps
		// making progress.
		await closeClientOnce();
	}
}

/**
 * Discover PM tool capabilities from an MCP server.
 * Backwards-compatible wrapper around {@link discoverPMToolCapabilitiesResult}
 * that collapses any failure to `null` (the long-standing contract for the
 * ~8 existing callers). New code that needs the failure reason should call
 * `discoverPMToolCapabilitiesResult` directly.
 */
export async function discoverPMToolCapabilities(params: {
	mcpConfigId: string | null;
	mcpServerId?: string;
	userId: string;
	organizationId?: string;
	containerId?: string | null;
}): Promise<PMToolCapabilities | null> {
	const result = await discoverPMToolCapabilitiesResult(params);
	return result.ok ? result.capabilities : null;
}

/**
 * Get simplified PM tool capabilities (for API responses)
 */
export async function getPMToolCapabilities(params: {
	mcpConfigId: string;
	userId: string;
	organizationId?: string;
}): Promise<{
	hasPMCapabilities: boolean;
	canCreate: boolean;
	canUpdate: boolean;
	canGet: boolean;
	canList: boolean;
	detectedType?: string;
	/**
	 * True when the connected tool holds a native test-case entity (Azure DevOps)
	 * or a recognized analogue (Jira Xray/Zephyr, GitLab test cases). Gates
	 * test-case push/pull so a case is never synced as a plain issue to a tool
	 * with no test-case concept.
	 */
	supportsTestCases: boolean;
} | null> {
	const capabilities = await discoverPMToolCapabilities(params);
	if (!capabilities) {
		return null;
	}

	return {
		hasPMCapabilities: capabilities.hasPMCapabilities,
		canCreate: !!capabilities.taskCreation,
		canUpdate: !!capabilities.taskUpdate,
		canGet: !!capabilities.taskGet,
		canList: !!capabilities.taskList,
		detectedType: capabilities.detectedType,
		supportsTestCases: capabilities.supportsTestCases ?? false,
	};
}

// =============================================================================
// Story Sync Activities
// =============================================================================

/**
 * Sync a single user story to the configured PM tool.
 * Dynamically discovers and uses the correct tool names.
 */
export async function syncStoryToPM(
	input: StorySyncInput,
): Promise<StorySyncResult> {
	const {
		storyId,
		projectId,
		mcpConfigId: maybeMcpConfigId,
		containerId,
		additionalContext,
		direction,
		userId,
		organizationId,
		capabilities: preDiscoveredCapabilities,
		overrideMismatch = false,
	} = input;

	// REST-GitLab fallback path (no pinned MCPConfig). Delegated to a
	// dedicated routine that drives the same push/pull/self-heal contract
	// through the provider-agnostic REST dispatcher. Dynamic import avoids a
	// static circular dependency (the routine imports types/helpers here).
	if (maybeMcpConfigId == null) {
		const { syncGitLabStoryViaRest } = await import(
			"./gitlab-rest-story-sync"
		);
		return syncGitLabStoryViaRest(input);
	}
	const mcpConfigId = maybeMcpConfigId;

	// Captured at function scope so the catch-path FAILURE log can name the real
	// tool — the in-`try` `capabilities` const is out of scope there. Stays
	// "unknown" only if the throw happens before discovery resolves.
	let detectedPmTool = "unknown";

	try {
		// 1. Use pre-discovered capabilities or discover them
		// CRITICAL: Pass organizationId for proper tenant isolation
		const capabilities =
			preDiscoveredCapabilities ??
			(await discoverPMToolCapabilities({
				mcpConfigId,
				userId,
				organizationId,
			}));
		if (!capabilities || !capabilities.hasPMCapabilities) {
			throw ApplicationFailure.nonRetryable(
				"PM tool does not have required capabilities",
			);
		}
		detectedPmTool = capabilities.detectedType ?? "unknown";

		// 1.5. Get MCP config to extract base URL for URL normalization
		const mcpConfig = await getMcpConfigById(mcpConfigId, {
			userId,
			organizationId,
		});
		const pmToolBaseUrl =
			mcpConfig?.baseUrl || mcpConfig?.mcpServer?.defaultUrl || null;

		// 2. Fetch the story
		const story = await getStoryById(storyId, projectId);
		if (!story) {
			throw ApplicationFailure.nonRetryable(
				`Story ${storyId} not found in project ${projectId}`,
			);
		}

		// Custom field read-mapping context: flag + parsed config
		// off the Project row. Threaded into the pull parse so replace-mode can
		// compose the body from the configured fields. Only loaded for ADO (the
		// sole provider adapter this iteration) so non-ADO syncs add zero DB reads
		// and stay byte-for-byte; inactive → legacy chain either way.
		const fieldMappingCtx =
			// Literal (not the @repo/database constant) mirrors this file's existing
			// ADO checks (see cleanAdoCodeBlocks) and avoids adding a new named
			// import that existing @repo/database test mocks don't stub.
			capabilities.detectedType === "azure-devops"
				? await loadProjectFieldMappingContext(projectId)
				: { enabled: false, config: null };

		logger.info("[Story Sync] Starting sync", {
			storyId,
			identifier: story.identifier,
			direction,
			hasExternalId: !!story.externalId,
			hasExternalMcpServerId: !!story.externalMcpServerId,
			detectedType: capabilities.detectedType,
			createTool: capabilities.taskCreation?.toolName,
		});

		let externalId = story.externalId ?? undefined;
		let externalUrl = story.externalUrl ?? undefined;
		const activeServerId = mcpConfig?.mcpServerId;
		const isLegacySync = !story.externalMcpServerId && !!externalId;

		// #1360 — terminal-status lifecycle outcome of the per-item pull reconcile.
		// Declared at function scope so the shared success return below can thread
		// it. Stays null/true until the pull's reconcile block runs; the block
		// flips `lifecycleReconciled` to false (non-fatally) if it throws.
		let lifecycle: {
			terminalApplied: boolean;
			action: string;
			terminalStatusLabel: string | null;
		} | null = null;
		let lifecycleReconciled = true;

		// One `PmSyncLog` row per attempted story outcome. A
		// `UserStory` always logs as `STORY` (bugs included; never `TASK`).
		// Reads the mutable `externalId`/`externalUrl` at call time so a
		// stale-link clear is reflected. NON-FATAL — `recordPmSyncLog` swallows
		// its own write errors and never affects the returned sync result.
		const logStoryOutcome = (
			status: "SUCCESS" | "FAILURE",
			errorPayload?: RecordPmSyncLogInput["errorPayload"],
		): Promise<void> =>
			recordPmSyncLog({
				// Faithful to the attempt's direction (the Sync History tab
				// filters on it): a pull sync logs "pull"; push / bidirectional
				// log "push".
				direction: direction === "pull" ? "pull" : "push",
				entityType: "STORY",
				entityId: storyId,
				title: story.title,
				pmTool: capabilities.detectedType ?? "unknown",
				status,
				errorPayload: errorPayload ?? null,
				actorUserId: userId,
				externalId: externalId ?? null,
				externalUrl: externalUrl ?? null,
				organizationId: organizationId ?? null,
				userId: organizationId ? null : userId,
				projectId,
			});

		// Hard check: if the story was synced to a known-different MCP server,
		// block immediately — the externalId belongs to the other tool.
		// Exception: explicit migration via overrideMismatch (push only) —
		// the user has confirmed they want to drop the previous link and
		// create a fresh item in the active tool.
		if (
			story.externalMcpServerId &&
			activeServerId &&
			story.externalMcpServerId !== activeServerId
		) {
			const canOverride =
				overrideMismatch &&
				(direction === "push" || direction === "bidirectional");
			if (!canOverride) {
				logger.warn("[Story Sync] PM tool mismatch — blocking sync", {
					storyId,
					identifier: story.identifier,
					storyServerId: story.externalMcpServerId,
					activeServerId,
					direction,
				});
				await logStoryOutcome("FAILURE", {
					errorCode: "PM_TOOL_MISMATCH",
					storyServerId: story.externalMcpServerId,
					activeServerId,
				});
				return {
					success: false,
					error: "This feature is synced to a different PM tool. Switch back to the original tool to pull, or push to migrate this feature to the current tool.",
					errorCode: "PM_TOOL_MISMATCH" as const,
					syncedAt: new Date(),
					direction,
				};
			}
			logger.info(
				"[Story Sync] PM tool mismatch — override accepted, clearing previous link",
				{
					storyId,
					identifier: story.identifier,
					previousServerId: story.externalMcpServerId,
					previousExternalId: externalId,
					previousExternalUrl: externalUrl,
					activeServerId,
				},
			);
			await updateStory(storyId, projectId, {
				externalId: null,
				externalUrl: null,
				externalMcpServerId: null,
			});
			externalId = undefined;
			externalUrl = undefined;
			// Sync the in-memory copy so downstream stamping logic
			// (which checks !story.externalMcpServerId) re-stamps the
			// active server id on the fresh push.
			story.externalId = null;
			story.externalUrl = null;
			story.externalMcpServerId = null;
		}

		// Legacy fallback: story has externalUrl but no externalMcpServerId.
		// Use URL-based heuristic to detect cross-tool migrations on push
		// (clears stale link so we take the create path).
		if (
			externalUrl &&
			!story.externalMcpServerId &&
			(direction === "push" || direction === "bidirectional")
		) {
			const existingHost = safeHost(externalUrl);
			const currentType = capabilities.detectedType;
			let mismatch = false;
			let reason = "";

			// Primary signal: known-tool host patterns via detectedType.
			// This catches cross-tool migrations (e.g. fizzy.do → dev.azure.com)
			// even when the MCP has no baseUrl (STDIO transports).
			if (existingHost && currentType) {
				if (belongsToDifferentKnownTool(existingHost, currentType)) {
					mismatch = true;
					reason = `host ${existingHost} belongs to a different known PM tool than ${currentType}`;
				}
			}

			// Secondary signal: baseUrl comparison for custom/self-hosted tools.
			// Use suffix-aware comparison so host variants of the same instance
			// (e.g. www.example.com vs example.com) are NOT treated as a mismatch.
			if (!mismatch && existingHost && pmToolBaseUrl) {
				const currentHost = safeHost(pmToolBaseUrl);
				if (
					currentHost &&
					!hostsShareRegistrableDomain(existingHost, currentHost)
				) {
					mismatch = true;
					reason = `baseUrl host ${currentHost} does not share a domain with ${existingHost}`;
				}
			}

			if (mismatch) {
				logger.warn(
					"[Story Sync] External link belongs to a different PM tool; clearing stale reference and creating fresh task",
					{
						storyId,
						identifier: story.identifier,
						existingHost,
						currentType,
						reason,
					},
				);
				externalId = undefined;
				externalUrl = undefined;
			}
		}

		// Read-only mode: skip the push half BEFORE any external
		// dispatch — this sits ahead of the attachment/image uploads below,
		// which hit ADO/Jira/Fizzy via raw fetch and would otherwise write
		// before the MCP chokepoint gate could block the create/update. Pull
		// (further down) still runs for "bidirectional"; a pure push reports
		// the block so the workflow stamps a clear, actionable sync error.
		const pushBlockedByReadOnly =
			(direction === "push" || direction === "bidirectional") &&
			(await isProjectReadOnly(projectId));
		if (pushBlockedByReadOnly && direction === "push") {
			return {
				success: false,
				error: READ_ONLY_MODE_MESSAGE,
				syncedAt: new Date(),
				direction,
			};
		}

		// 3. Push to PM tool
		if (
			!pushBlockedByReadOnly &&
			(direction === "push" || direction === "bidirectional")
		) {
			// The Fabric back-link is persisted into the story's description
			// at creation time (see createStory in @repo/database) as an
			// HTML anchor — Fabric's canonical form. The push pipeline for
			// PM-tool-bound descriptions has two layers:
			//
			//   1. Back-link format (per-provider): for Fizzy only,
			//      `formatBackLinkForProvider` rewrites the canonical HTML
			//      anchor as a markdown link `[View in Fabric](url)`. For
			//      every other provider this is identity. See fabric-url.ts.
			//
			//   2. Body format (per-provider): for Fizzy, run
			//      `markdownToSimpleHtml` over the whole description so
			//      headings, lists, and bold render as formatted HTML in
			//      the card body — Fizzy stores `description` as plain
			//      text and would otherwise show raw `#`, `**`, `-`
			//      markers to the end user. The markdown back-link from
			//      step (1) gets converted into a clean `<a>` tag by
			//      markdownToSimpleHtml's inline link regex, so the final
			//      HTML sent to Fizzy contains a proper hyperlink rather
			//      than a markdown literal. ADO and other providers
			//      forward the description verbatim — they handle their
			//      own format hint (e.g. ADO `format: "Markdown"`) or
			//      render markdown natively (Linear / GitHub / GitLab /
			//      Jira).
			//
			//   3. Table format (Fizzy only): Tiptap-authored descriptions
			//      can contain inline `<table>` HTML (Tiptap has no
			//      markdown serializer for tables). Fizzy's editor
			//      (Lexxy, Basecamp's successor to Trix) rejects the
			//      Tiptap-specific class / inline-style / colspan
			//      attributes and escapes the whole block to literal
			//      `&lt;table&gt;` text. We pre-extract every `<table>`
			//      block, convert it to Lexxy's accepted shape
			//      (`<figure class="lexxy-content__table-wrapper">…`),
			//      and stitch it back in *after* `markdownToSimpleHtml`
			//      runs so the converter's `escapeHtml` never sees a
			//      `<` from a table tag. Non-table text continues through
			//      the existing pipeline byte-for-byte. See
			//      `extractFizzyTables` / `restoreFizzyTables` /
			//      `tiptapTableToLexxy` for the conversion details and
			//      Fizzy card #1355 for the bug this fixes.
			//
			// History: PR #781 originally ran markdownToSimpleHtml on push
			// for the `HTML_DESCRIPTION_TOOLS` set; PR #910 + commit
			// a566e50e5 had to remove it because the HTML back-link anchor
			// it ran against was escaped by `escapeHtml()`, producing
			// `&lt;p&gt;&lt;a…` literal text. Step (1) above now strips
			// the HTML anchor before step (2) runs, so the escape path
			// has no anchor to mangle.
			//
			//   4. Story-media images (all tools): Fabric stores image
			//      references with either `<img src="..." data-s3-key=
			//      "story-media/...">` (Tiptap paste/upload) or
			//      `![alt](story-media/...)` (the `## Attachments` section
			//      from the create-story dialog). PM tools cannot reach the
			//      Fabric S3 bucket, so we resolve every key to a 7-day
			//      signed download URL and rewrite the description's `src`
			//      / markdown URL to that signed URL on push.
			//
			//   5. Tables (non-Fizzy, Fabric-authored only): Tiptap has no
			//      markdown serializer for tables — descriptions contain raw
			//      `<table>` HTML embedded in markdown. Most PM-tool
			//      renderers either strip unrecognised attributes or escape
			//      the whole block to literal text. We convert every embedded
			//      table to a GFM markdown table that all major PM-tool
			//      renderers (Jira, ADO via `format: "Markdown"`, GitHub,
			//      GitLab, Linear) handle natively. Gated on
			//      `looksFabricAuthored` so descriptions that round-tripped
			//      from a PM tool (no Tiptap markers) preserve their stored
			//      HTML byte-for-byte. Fizzy retains the existing Lexxy
			//      `<figure class="lexxy-content__table-wrapper">` shape via
			//      `tiptapTableToLexxy`.
			const rawDescription = buildStoryDescription(story);
			// Strip "could not be imported" placeholders BEFORE pushing. A
			// failed-pull placeholder pushed back OVERWRITES the live
			// attachment reference in the PM tool (permanent data loss — an
			// ADO `_apis/wit/attachments/…` reference becomes inert text).
			// Stripping keeps the source intact so a transient failure
			// self-heals on the next pull. Applied here, upstream of the
			// per-provider branches below, so every MCP provider is covered —
			// `syncGitLabStoryViaRest` does the same on the REST path.
			const withoutFailedMedia =
				stripFailedMediaPlaceholders(rawDescription);
			const withProviderBackLink = formatBackLinkForProvider(
				withoutFailedMedia,
				capabilities.detectedType,
			);

			// Resolve every story-media S3 key referenced in the description
			// to a 7-day signed download URL (the S3 cap). Failures per key
			// are logged + skipped — the original key stays in the
			// description so the surrounding text still ships, and the
			// Fabric back-link below covers the missing-image case.
			const mediaKeys =
				extractStoryMediaKeysFromContent(withProviderBackLink);
			const signedUrlMap = await resolveStoryMediaSignedUrls(mediaKeys);
			const { content: withResolvedMedia, unresolvedKeys } =
				rewriteStoryMediaSourcesToSignedUrls(
					withProviderBackLink,
					signedUrlMap,
				);
			if (unresolvedKeys.length > 0) {
				logger.warn(
					"[Story Sync] Some story-media keys did not resolve",
					{
						storyId,
						detectedType: capabilities.detectedType,
						unresolvedCount: unresolvedKeys.length,
						sampleKey: unresolvedKeys[0],
					},
				);
			}

			const detectedType = (
				capabilities.detectedType ?? ""
			).toLowerCase();
			const isFizzy = detectedType === "fizzy";
			const isAdo =
				detectedType === "azure-devops" || detectedType === "ado";

			let description: string;
			// Captured when the Jira branch resolves a hybrid Atlassian
			// Cloud target. The post-create / pre-update upload step reads
			// this to decide whether to run REST attachment upload + URL
			// rewrite. Null when no Cloud target — degrade to base64.
			let jiraCloudTarget: JiraCloudTarget | null = null;
			if (isFizzy) {
				// Order matters: tables FIRST (so any `<img>` inside cells
				// travels inside the captured table block and gets re-emitted
				// after the table), THEN standalone images (so the remaining
				// `<img>` / `![]()` references between paragraphs survive
				// `markdownToSimpleHtml`'s `escapeHtml` pass via the same
				// sentinel-token mechanism used for tables).
				//
				// Image rendering pipeline (PR #1168):
				//   1. Try Fizzy native ActionText attachment via the Rails
				//      `/{account_slug}/rails/active_storage/direct_uploads`
				//      flow (POST metadata → PUT bytes → embed via
				//      `<action-text-attachment sgid="…">`). Native Lexxy
				//      rendering, no description bloat. Uses the same API
				//      key already on the user's Fizzy MCPConfig.
				//   2. Per-image fallback to base64 `data:` URL inline
				//      (PR #1163 behaviour) when the upload fails or no
				//      attachment target can be built (no account_slug,
				//      decrypt fails, etc.).
				//   3. Last resort: leave the original URL — Lexxy strips
				//      it client-side, but the surrounding text + tables
				//      still ship intact.
				//
				// `resolveFizzyAttachmentTarget` returns null if the API
				// key can't be decrypted or `account_slug` is missing,
				// in which case the whole branch collapses to the PR #1163
				// base64 path — zero regression for existing connections.
				const fizzyTarget = await resolveFizzyAttachmentTarget(
					mcpConfig,
					additionalContext as
						| Record<string, unknown>
						| null
						| undefined,
				);
				const { withTokens: tableTokens, tables } =
					extractFizzyTables(withResolvedMedia);
				const { withTokens: imgTokens, images } =
					extractFizzyImages(tableTokens);
				// File attachments (non-image story-media `<a … download>`
				// anchors) must be extracted too — otherwise
				// `markdownToSimpleHtml` HTML-escapes the raw anchor into
				// literal text (the card-corrupting `&lt;a …&gt;name&lt;/a&gt;`
				// garbage seen on Fizzy card 1594). Upload them to Fizzy as
				// native ActionText attachments, exactly like images.
				const { withTokens: fileTokens, files } =
					extractFizzyFileAttachments(imgTokens);
				const imageEmbeds = await resolveFizzyImageEmbeds(
					images,
					fizzyTarget,
				);
				const fileEmbeds = await resolveFizzyFileEmbeds(
					files,
					fizzyTarget,
				);
				const tablesWithResolvedImages = await Promise.all(
					tables.map((t) =>
						rewriteFizzyInCellImagesHybrid(t, fizzyTarget),
					),
				);
				description = restoreFizzyFileAttachments(
					restoreFizzyImagesWithEmbeds(
						restoreFizzyTables(
							markdownToSimpleHtml(fileTokens),
							tablesWithResolvedImages,
						),
						imageEmbeds,
					),
					fileEmbeds,
				);
			} else if (isAdo && looksFabricAuthored(withResolvedMedia)) {
				// ADO push (create + update): the body has to ship as HTML.
				// ADO's `wit_update_work_item` JSON Patch entries do not
				// accept a `format` field and `System.Description` is an
				// HTML field — sending raw markdown there leaves `##`,
				// `**bold**`, `- bullet` as literal text in the rendered
				// description, and GFM tables render as `|`/`---` text.
				//
				// Mirror the Fizzy pipeline: pre-extract tables (cleaned
				// via `cleanTiptapTableHtml`) and standalone images, run
				// `markdownToSimpleHtml` to convert headings / lists /
				// emphasis to HTML, then restore tables as inline clean-
				// HTML blocks. Standalone and in-cell `<img>` URLs are
				// then uploaded to ADO as work-item attachments — ADO's
				// HTML sanitizer strips external `<img src>` URLs but
				// keeps `<img src="…/_apis/wit/attachments/…">`.
				//
				// Order matters: tables FIRST so any `<img>` inside cells
				// stays inside the captured table HTML; images SECOND so
				// the remaining `![]()` / standalone `<img>` references
				// between paragraphs survive `markdownToSimpleHtml`'s
				// `escapeHtml` pass via the sentinel-token mechanism.
				//
				// FIRST, drop story-media FILE-attachment anchors: ADO holds
				// files as native work-item attachments (relations), pulled into
				// the description only for Fabric display. Pushing them back into
				// System.Description is wrong — the signed localhost/S3 `<a href>`
				// is unreachable from ADO and `markdownToSimpleHtml` escapes the
				// raw `<a>` into literal `&lt;a&gt;` text (breaking the card).
				// The native attachment relation is untouched, so the file stays
				// attached. Inline `<img>` images are kept (uploaded below).
				const adoBody = stripStoryMediaFileAnchors(withResolvedMedia);
				const { withTokens: adoTableTokens, tables: adoTables } =
					extractAdoTables(adoBody);
				const { withTokens: adoImgTokens, images: adoImages } =
					extractAdoImages(adoTableTokens);

				// Build the AdoAttachmentTarget from the user's MCPConfig
				// (per-user PAT) and the org slug stored on the config.
				// `commandArgs[0]` is the ADO org for the STDIO transport;
				// fall back to parsing `baseUrl` for HTTP transports.
				const adoTarget = await resolveAdoAttachmentTarget(mcpConfig);
				const uploadedAdoImages = adoTarget
					? await uploadAdoImageAttachments(adoImages, adoTarget)
					: adoImages;
				const adoTablesWithUploads = adoTarget
					? await Promise.all(
							adoTables.map((t) =>
								rewriteAdoInCellImagesToAttachments(
									t,
									adoTarget,
								),
							),
						)
					: adoTables;

				// Preserve-vs-convert by whether the body is HTML or markdown:
				//   - PULLED-from-ADO body is already HTML (`<div>`/`<br>` per
				//     line). Ingesting its images trips `looksFabricAuthored`
				//     (story-media marker) and lands it here, but running
				//     `markdownToSimpleHtml` would escape `<div>` → literal
				//     `&lt;div&gt;` text (WI #225). So PRESERVE it.
				//   - Fabric markdown — including a Fabric-EDITED-from-pull body,
				//     which Turndown turns into plain text + `![](…)`/`[](…)`
				//     markdown with NO residual tags — must be CONVERTED, else the
				//     raw markdown ships as literal text into ADO (WI #228).
				// `looksLikeHtmlBody` checks the post-extraction body (tables +
				// images are tokens by now), so the only residual tags are ADO's
				// `<div>`/`<br>` and the HTML back-link anchor.
				const adoConverted = looksLikeHtmlBody(adoImgTokens)
					? adoImgTokens
					: markdownToSimpleHtml(adoImgTokens);
				description = restoreAdoImages(
					restoreAdoTables(adoConverted, adoTablesWithUploads),
					uploadedAdoImages,
				);
			} else if (looksFabricAuthored(withResolvedMedia)) {
				// Non-Fizzy, non-ADO, Fabric-authored: convert every Tiptap-
				// shaped `<table>` block to GFM markdown so it renders
				// reliably in Jira / GitHub / GitLab / Linear. Image
				// references were already rewritten above so they ride along
				// inside the converted cells.
				//
				// Jira-specific cosmetic fix: Rovo's markdown→ADF converter
				// escapes inline `<br>` inside table cells (ADF's table-cell
				// content model doesn't include inline `<br>`). Pass a
				// readable inline separator so multi-line cells stay
				// legible instead of showing literal `<br>` text. GitHub,
				// GitLab, and Linear honour `<br>` natively so they keep
				// the default.
				//
				// Jira image rendering — TWO paths (PR #1169):
				//
				//   (A) Cloud target present: a hybrid 3LO token with
				//       aud=api.atlassian.com is on file. Leave external
				//       URLs in the description for now, run REST attachment
				//       upload AFTER the create/update completes (issue key
				//       required), then rewrite the description with site-
				//       direct `/secure/attachment/{id}/{filename}` URLs.
				//       Avoids the 32 KB ADF text limit entirely + renders
				//       real screenshots inline.
				//
				//   (B) No Cloud target (existing behaviour): base64-inline
				//       every external image (PR #1167). Atlassian Media's
				//       proxy resolves `data:` URLs inline, but the 32 KB
				//       limit caps the description so large screenshots
				//       fail to render.
				//
				// GitHub / GitLab / Linear are unaffected — they render
				// external URLs natively.
				const isJira = detectedType === "jira";
				const converted = convertEmbeddedHtmlTablesToMarkdown(
					withResolvedMedia,
					isJira ? { inCellLineBreakSeparator: " / " } : {},
				);
				if (isJira) {
					jiraCloudTarget = mcpConfig
						? await resolveJiraCloudTarget(mcpConfig, {
								decrypt: decryptApiKey,
								refreshIfExpired: refreshAtlassianCloudToken,
							})
						: null;
					if (jiraCloudTarget) {
						// Path (A): defer image upload until after we have
						// the issue key. Leave external/signed URLs in place.
						description = converted;
					} else {
						// Path (B): existing base64 inline fallback.
						description =
							await inlineJiraMarkdownImagesAsBase64DataUrls(
								converted,
							);
					}
				} else if (MARKDOWN_DESCRIPTION_TOOLS.has(detectedType)) {
					// GitHub / GitLab / Linear / ClickUp / Trello render
					// Markdown natively: keep the GFM tables + emphasis and
					// convert standalone <img> tags to markdown images so they
					// render (a raw <img> isn't reliable across these).
					description = replaceHtmlImagesWithMarkdown(converted);
				} else {
					// Asana / Monday (and any unclassified tool): preserve the
					// prior markdown body unchanged.
					description = converted;
				}
			} else {
				description = withResolvedMedia;
			}
			const originalTitle = story.title;
			// Clamp the outbound title to the PM tool's limit (Fizzy rejects a
			// 256+ char title with an opaque HTTP 500 — varchar(255) overflow).
			// Fabric keeps the full title locally; the card carries a back-link.
			const title = truncateTitleForProvider(originalTitle, detectedType);
			if (title !== originalTitle) {
				logger.warn(
					"[Story Sync] Title exceeds PM tool limit; truncating for push",
					{
						storyId,
						detectedType,
						originalLength: originalTitle.length,
						pushedLength: title.length,
					},
				);
			}

			// Jira hybrid Cloud — UPDATE path: when the issue key is
			// already known and a Cloud target is on file, upload images
			// to Jira REST attachments and rewrite the description with
			// site-direct `/secure/attachment/{id}/{filename}` URLs
			// BEFORE the update call, so the single update writes the
			// final body. On any per-image failure the description keeps
			// the original src — Atlassian Media will show
			// "Preview unavailable" for that one, but the rest of the
			// body still ships.
			if (
				jiraCloudTarget &&
				externalId &&
				capabilities.taskUpdate &&
				detectedType === "jira"
			) {
				// Route the upload to the issue's OWN Atlassian site (the
				// cloudId is embedded in externalUrl), not the token's
				// primary site — multi-site accounts host issues on
				// different tenants. Degrade to base64 if the issue's site
				// isn't among the token's granted resources.
				const issueSite = resolveIssueSite(
					jiraCloudTarget,
					externalUrl,
				);
				if (issueSite) {
					const result = await uploadJiraImagesAndRewriteDescription(
						description,
						jiraCloudTarget,
						issueSite,
						externalId,
					);
					const preUpdateLog =
						result.failed > 0
							? logger.warn.bind(logger)
							: logger.info.bind(logger);
					preUpdateLog(
						"[Story Sync] Jira hybrid Cloud — pre-update attachment upload",
						{
							externalId,
							cloudId: issueSite.cloudId,
							uploaded: result.uploaded,
							failed: result.failed,
							errors: result.errors,
						},
					);
					description = result.description;
				} else {
					// The Cloud path skipped base64 at build time expecting
					// to upload attachments. Since the issue's site isn't
					// reachable, re-apply base64 inline so images still
					// render (small ones) rather than shipping dead URLs.
					logger.info(
						"[Story Sync] Jira hybrid Cloud — issue site not in granted resources; falling back to base64 inline",
						{ externalId, externalUrl },
					);
					description =
						await inlineJiraMarkdownImagesAsBase64DataUrls(
							description,
						);
				}
			}

			if (externalId && capabilities.taskUpdate) {
				// Update existing task
				const updateTool = capabilities.taskUpdate;
				let updateArgs: Record<string, unknown>;

				if (updateTool.updatesBased) {
					// Azure DevOps: id + updates array (JSON Patch style).
					// Round-trip invariant: descriptions pulled from a PM
					// tool (no Tiptap markers, no story-media keys) are
					// forwarded byte-for-byte. The `description` variable
					// above falls through unchanged in that case
					// (`looksFabricAuthored` returns false). For Fabric-
					// authored content the description carries the signed-
					// URL rewrites + clean HTML tables (via
					// `convertEmbeddedHtmlTablesToCleanHtml`). The ADO MCP
					// server's `wit_update_work_item` JSON Patch values do
					// not accept a `format` field — ADO renders the value
					// as HTML by default, so we must ship HTML here. The
					// create path sets `format: "Html"` to match.
					const updates: Array<{
						op: string;
						path: string;
						value: string;
					}> = [];
					updates.push({
						op: "add",
						path: "/fields/System.Title",
						value: title,
					});
					updates.push({
						op: "add",
						path: "/fields/System.Description",
						value: description,
					});
					// ADO Bugs render their body in Repro Steps; mirror the patch
					// there too so an edited bug's body updates on the form (and
					// stays in sync with System.Description, which the pull reads).
					if (story.kind === "BUG") {
						updates.push({
							op: "add",
							path: "/fields/Microsoft.VSTS.TCM.ReproSteps",
							value: description,
						});
					}
					updateArgs = {
						[updateTool.idParam]: externalId,
						[updateTool.updatesBased.updatesParam]: updates,
					};
				} else if (updateTool.fieldsObjectBased) {
					// Atlassian Rovo Jira: title/description live inside a
					// `fields` object — `editJiraIssue` has only id + fields
					// as top-level params, with `fields` accepting an
					// arbitrary object of issue field name → value.
					const fieldsValue: Record<string, unknown> = {
						[updateTool.fieldsObjectBased.titleField]: title,
						[updateTool.fieldsObjectBased.descriptionField]:
							description,
					};
					updateArgs = {
						[updateTool.idParam]: externalId,
						[updateTool.fieldsObjectBased.fieldsParam]: fieldsValue,
					};
				} else {
					updateArgs = {
						[updateTool.idParam]: externalId,
					};
					if (updateTool.titleParam) {
						updateArgs[updateTool.titleParam] = title;
					}
					if (updateTool.descriptionParam) {
						updateArgs[updateTool.descriptionParam] = description;
					}
				}

				// Push status/column when tool supports it (e.g. Fizzy column_id)
				if (
					updateTool.statusParam &&
					story.statusId &&
					additionalContext?.statusColumnMap
				) {
					const map =
						additionalContext.statusColumnMap as unknown as Record<
							string,
							string
						>;
					const pmColumnId = map[story.statusId];
					if (pmColumnId) {
						updateArgs[updateTool.statusParam] = pmColumnId;
					}
				}

				// Push labels/tags. When the remote tool exposes
				// `add_labels`/`remove_labels` (GitLab MCP shim), use a status
				// delta so user-added labels on the remote aren't clobbered
				// and stale status labels are stripped on transition.
				// Otherwise fall back to the legacy full-replace path.
				const updateAddLabelsParam = updateTool.allParams.find((p) =>
					/^add_labels$/i.test(p.name),
				)?.name;
				const updateRemoveLabelsParam = updateTool.allParams.find((p) =>
					/^remove_labels$/i.test(p.name),
				)?.name;
				const tagsLabelsParam = updateTool.allParams.find(
					(p) => /^tags?$/i.test(p.name) || /^labels?$/i.test(p.name),
				)?.name;

				if (updateAddLabelsParam || updateRemoveLabelsParam) {
					const map = readLabelStatusMap(additionalContext);
					const delta = computeLabelDeltaOnPush(
						story.lastSyncedStatusId ?? null,
						story.statusId,
						pmLabelValues(story),
						map,
					);
					if (updateAddLabelsParam && delta.addLabels.length > 0) {
						updateArgs[updateAddLabelsParam] = delta.addLabels;
					}
					if (
						updateRemoveLabelsParam &&
						delta.removeLabels.length > 0
					) {
						updateArgs[updateRemoveLabelsParam] =
							delta.removeLabels;
					}
				} else if (tagsLabelsParam) {
					// Legacy full-replace fallback for trackers without delta
					// label support. We still inject the new status's labels,
					// but cannot strip stale ones — those providers should
					// add `add_labels`/`remove_labels` to use the new path.
					const map = readLabelStatusMap(additionalContext);
					const delta = computeLabelDeltaOnPush(
						null,
						story.statusId,
						pmLabelValues(story),
						map,
					);
					const merged = [
						...pmLabelValues(story),
						...delta.addLabels,
					];
					if (merged.length > 0) {
						updateArgs[tagsLabelsParam] = merged;
					}
				}

				// Add additional context if tool supports them (skip statusColumnMap - used above)
				if (additionalContext) {
					for (const [key, value] of Object.entries(
						additionalContext,
					)) {
						if (key === "statusColumnMap") {
							continue;
						}
						if (
							typeof value !== "string" &&
							typeof value !== "number" &&
							typeof value !== "boolean"
						) {
							continue;
						}
						if (updateTool.allParams.some((p) => p.name === key)) {
							updateArgs[key] = value;
						}
					}
				}

				// Add container ID (board_id, project_id, etc.) if needed
				// Some PM tools require container context even for updates
				if (containerId) {
					const containerParams = [
						"board_id",
						"project_id",
						"project_key",
						"team_id",
						"repo",
						"list_id",
					];
					for (const param of containerParams) {
						if (
							updateTool.allParams.some((p) => p.name === param)
						) {
							updateArgs[param] = containerId;
							break;
						}
					}
				}

				const updateResult = await executeMcpTool({
					toolName: updateTool.toolName,
					args: updateArgs,
					userId,
					organizationId,
					// Read-only mode write-gate keys off projectId
					projectId,
					mcpConfigId,
				});

				if (!updateResult.success) {
					let errorDetail = "Unknown error";
					const out = updateResult.output;
					if (typeof out === "string") {
						errorDetail = out;
					} else if (
						typeof out === "object" &&
						out !== null &&
						Array.isArray((out as Record<string, unknown>).content)
					) {
						const textItem = (
							(out as Record<string, unknown>).content as Array<{
								type?: string;
								text?: string;
							}>
						).find((c) => c.type === "text");
						errorDetail = textItem?.text ?? JSON.stringify(out);
					} else {
						errorDetail = JSON.stringify(out);
					}
					throw ApplicationFailure.nonRetryable(
						`Failed to update work item ${externalId}: ${errorDetail}`,
					);
				}

				logger.info("[Story Sync] Updated existing task", {
					externalId,
					tool: updateTool.toolName,
				});
			} else if (externalId && !capabilities.taskUpdate) {
				throw ApplicationFailure.nonRetryable(
					`Story ${story.identifier} is linked to external ID ${externalId} but the PM tool does not support updates. ` +
						"Disconnect the story first or use a PM tool that supports updating work items.",
				);
			} else if (capabilities.taskCreation) {
				// Create new task
				const createTool = capabilities.taskCreation;
				let createArgs: Record<string, unknown>;

				if (createTool.fieldsBased) {
					// Azure DevOps MCP expects fields as array: [{ name, value, format? }]
					// See: https://github.com/microsoft/azure-devops-mcp/blob/main/src/tools/work-items.ts
					//
					// We send `format: "Html"` because `description` here is
					// either clean HTML (Fabric-authored, processed by
					// `convertEmbeddedHtmlTablesToCleanHtml` above) or already-
					// HTML from a previous ADO pull. This keeps the create and
					// update paths symmetric — the ADO MCP server's
					// `wit_update_work_item` JSON Patch entries do not accept
					// a format hint, so the update path implicitly renders the
					// value as HTML, and the create path must match.
					const fieldsArray: Array<{
						name: string;
						value: string;
						format?: "Html" | "Markdown";
					}> = [
						{
							name: createTool.fieldsBased.titleKey,
							value: title,
						},
						{
							name: createTool.fieldsBased.descriptionKey,
							value: description || "",
							format: "Html",
						},
					];
					if (
						additionalContext?.areaPath &&
						!additionalContext.areaPath.trim().startsWith("http")
					) {
						fieldsArray.push({
							name: "System.AreaPath",
							value: normalizeAreaPathForAdo(
								additionalContext.areaPath,
							),
						});
					}
					if (
						additionalContext?.iterationPath &&
						!additionalContext.iterationPath
							.trim()
							.startsWith("http")
					) {
						fieldsArray.push({
							name: "System.IterationPath",
							value: normalizeAreaPathForAdo(
								additionalContext.iterationPath,
							),
						});
					}
					// An ADO **Bug**'s body renders in "Repro Steps"
					// (`Microsoft.VSTS.TCM.ReproSteps`), NOT System.Description,
					// which isn't on the Bug form — a bug pushed with only
					// System.Description shows an empty body. Mirror the body into
					// ReproSteps too: ReproSteps makes it visible, and keeping
					// System.Description means every existing read/pull path keeps
					// working unchanged. `fieldsBased` is ADO-only, so
					// `story.kind === "BUG"` is sufficient here.
					if (story.kind === "BUG") {
						fieldsArray.push({
							name: "Microsoft.VSTS.TCM.ReproSteps",
							value: description || "",
							format: "Html",
						});
					}
					// A UserStory carries a `kind` (FEATURE / USER_STORY / BUG).
					// Bugs must land in ADO as a "Bug" work item, not the
					// project's default story type — mirrors the hierarchy-sync
					// mapping (`ITEM_TYPE_TO_ADO_TYPE`, `bug → "Bug"`) so the
					// manual per-story Push button agrees with the auto-push /
					// AI-update path (which already derives `itemType: "bug"`
					// from `kind`). Verified the official `@azure-devops/mcp`
					// `wit_create_work_item` creates a "Bug" fine. Non-bug kinds
					// keep the existing project-default behavior unchanged.
					const workItemType =
						process.env.FEATURE_PM_TYPE_MAPPING === "true"
							? resolveWorkItemType(
									story.kind as StoryKindValue,
									{
										mapping: parseWorkItemTypeMapping(
											additionalContext as
												| Record<string, unknown>
												| undefined,
										),
										legacyFallback:
											story.kind === "BUG"
												? "Bug"
												: (additionalContext?.workItemType ??
													"User Story"),
									},
								)
							: story.kind === "BUG"
								? "Bug"
								: (additionalContext?.workItemType ??
									"User Story");
					createArgs = {
						[createTool.containerParam]: containerId,
						[createTool.fieldsBased.workItemTypeParam]:
							workItemType,
						[createTool.fieldsBased.fieldsParam]: fieldsArray,
					};
				} else {
					createArgs = {
						[createTool.containerParam]: containerId,
						[createTool.titleParam]: title,
					};
					if (createTool.descriptionParam) {
						createArgs[createTool.descriptionParam] = description;
					}
				}

				// Push column/status when tool supports it so card lands in right column
				const columnStatusParam = createTool.allParams.find((p) =>
					/^column_id$|^status_id$|^list_id$|^status$/i.test(p.name),
				)?.name;
				if (
					columnStatusParam &&
					story.statusId &&
					additionalContext?.statusColumnMap
				) {
					const map =
						additionalContext.statusColumnMap as unknown as Record<
							string,
							string
						>;
					const pmColumnId = map[story.statusId];
					if (pmColumnId) {
						createArgs[columnStatusParam] = pmColumnId;
					}
				}

				// Push labels/tags on create. No previous status to remove;
				// just compute the labels for the current status and merge
				// with story labels.
				const createTagsParam = createTool.allParams.find(
					(p) => /^tags?$/i.test(p.name) || /^labels?$/i.test(p.name),
				)?.name;
				if (createTagsParam) {
					const map = readLabelStatusMap(additionalContext);
					const delta = computeLabelDeltaOnPush(
						null,
						story.statusId,
						pmLabelValues(story),
						map,
					);
					const merged = [
						...pmLabelValues(story),
						...delta.addLabels,
					];
					if (merged.length > 0) {
						createArgs[createTagsParam] = merged;
					}
				}

				// Add additional context if tool supports them (skip statusColumnMap - used above)
				if (additionalContext) {
					for (const [key, value] of Object.entries(
						additionalContext,
					)) {
						if (key === "statusColumnMap") {
							continue;
						}
						// `workItemType` is resolved above with kind-awareness
						// (bugs → "Bug") and the ADO create tool exposes it as a
						// param — without this skip the raw project-default would
						// clobber the resolved value and a bug would push as the
						// default type again. Mirrors the hierarchy-sync loop.
						if (key === "workItemType") {
							continue;
						}
						if (
							typeof value !== "string" &&
							typeof value !== "number" &&
							typeof value !== "boolean"
						) {
							continue;
						}
						if (createTool.allParams.some((p) => p.name === key)) {
							createArgs[key] = value;
						}
					}
				}

				// Atlassian Rovo `createJiraIssue` requires `cloudId` and
				// `issueTypeName`, neither of which is carried in the project's
				// container context. Resolve them just-in-time. `cloudId` may
				// already be present when the picker persisted it on a newer
				// save (forwarded by the additionalContext loop above); if not,
				// resolve it via getAccessibleAtlassianResources so a stale or
				// pre-fix saved config still works.
				if (detectedType === "jira") {
					const needsCloudId =
						createArgs.cloudId == null &&
						createTool.allParams.some((p) => p.name === "cloudId");
					const needsIssueType =
						createArgs.issueTypeName == null &&
						createTool.allParams.some(
							(p) => p.name === "issueTypeName",
						);
					if (needsCloudId || needsIssueType) {
						const cloudId =
							(typeof createArgs.cloudId === "string"
								? createArgs.cloudId
								: undefined) ??
							(await resolveAtlassianCloudId({
								mcpConfigId,
								userId,
								organizationId,
								availableTools: capabilities.availableTools,
							}));
						if (needsCloudId && cloudId) {
							createArgs.cloudId = cloudId;
						}
						if (needsIssueType) {
							createArgs.issueTypeName =
								await resolveJiraDefaultIssueType({
									projectKey: String(containerId),
									cloudId,
									mcpConfigId,
									userId,
									organizationId,
									availableTools: capabilities.availableTools,
								});
						}
					}
				}

				logger.info("[Story Sync] Calling create tool", {
					tool: createTool.toolName,
					argKeys: Object.keys(createArgs),
					project: containerId,
				});

				const createResult = await executeMcpTool({
					toolName: createTool.toolName,
					args: createArgs,
					userId,
					organizationId,
					// Read-only mode write-gate keys off projectId
					projectId,
					mcpConfigId,
				});

				if (createResult.success) {
					// DYNAMIC: Use update tool's idParam to know which field to extract
					// This adapts to any PM tool's ID convention via MCP schema discovery
					const extracted = extractExternalInfo(createResult.output, {
						baseUrl: pmToolBaseUrl,
						idParamHint: capabilities.taskUpdate?.idParam,
					});
					externalId = extracted.externalId;
					externalUrl = extracted.externalUrl;

					// Silent-success guard: some MCP wrappers report success
					// without isError:true even when the underlying PM tool
					// rejected the create (e.g. invalid ADO areaPath inherited
					// from a legacy synthesized config). If we can't find an
					// external id in the response, treat it as failure so the
					// UI shows an error instead of a misleading success toast.
					if (!externalId) {
						let responseText: string | undefined;
						if (
							typeof createResult.output === "object" &&
							createResult.output !== null &&
							"content" in createResult.output
						) {
							const content = (
								createResult.output as {
									content?: Array<{
										type?: string;
										text?: string;
									}>;
								}
							)?.content;
							if (Array.isArray(content)) {
								responseText = content.find(
									(c) => c.type === "text",
								)?.text;
							}
						}
						logger.error(
							"[Story Sync] Create succeeded but no external id extracted",
							{
								tool: createTool.toolName,
								project: containerId,
								responsePreview: responseText?.slice(0, 500),
							},
						);
						const errorMessage = `PM tool accepted the request but did not return a work item id. This usually means the item was rejected server-side (e.g. invalid AreaPath/IterationPath). Re-save the project's PM settings and try again. Response: ${
							responseText?.slice(0, 300) ?? "(no response text)"
						}`;
						// Stamp `lastPmSyncStatus = FAILED` on the row BEFORE
						// throwing. The function-level catch (line 2920+)
						// writes a FAILURE row to `PmSyncLog` for the audit
						// trail, but never updates the story's sync-status
						// field — which means an orphan via this path would
						// stay in silent "Unsynced" on the roadmap with no
						// error badge, exactly the user-reported bug ("ticket
						// pushed but Fabric shows Unsynced"). With this
						// stamp, the roadmap renders the standard "PM sync
						// failed" badge linking to a side-panel with the
						// error message above. Mirrors the equivalent guard
						// in `syncWorkItemToPM` (hierarchy-sync.ts CREATE
						// branch). Non-fatal: a failed stamp must not mask
						// the underlying throw, so swallow + warn-log.
						try {
							await recordPmSyncFailure({
								itemId: storyId,
								itemType: "story",
								errorMessage,
								errorClass: "create_orphan",
								triggerSource: "manual-edit",
								pmTool: capabilities.detectedType ?? undefined,
								actorUserId: userId,
							});
						} catch (stampError) {
							logger.warn(
								"[Story Sync] failed to stamp lastPmSyncStatus=FAILED before throw",
								{
									storyId,
									error:
										stampError instanceof Error
											? stampError.message
											: String(stampError),
								},
							);
						}
						throw new Error(errorMessage);
					}

					logger.info("[Story Sync] Created new task", {
						externalId,
						externalUrl,
						tool: createTool.toolName,
					});

					// Jira hybrid Cloud — POST-CREATE pass: now that we
					// have the new issue key, upload images via REST
					// attachment API and push a second update to swap the
					// description for one with site-direct
					// `/secure/attachment/{id}/{filename}` URLs. The first
					// create call shipped the description with external
					// signed URLs (small, well under the 32 KB ADF text
					// limit) — Atlassian Media will briefly show
					// "Preview unavailable" until the second update lands.
					if (
						jiraCloudTarget &&
						externalId &&
						capabilities.taskUpdate &&
						detectedType === "jira"
					) {
						try {
							// Resolve the issue's own site from the create's
							// externalUrl; degrade when it's not among the
							// token's granted resources (multi-site safety).
							const issueSite = resolveIssueSite(
								jiraCloudTarget,
								externalUrl,
							);
							const result = issueSite
								? await uploadJiraImagesAndRewriteDescription(
										description,
										jiraCloudTarget,
										issueSite,
										externalId,
									)
								: {
										description,
										uploaded: 0,
										failed: 0,
										errors: [
											"issue site is not among the Cloud token's granted accessible-resources",
										],
									};
							// Log at warn when any image failed so the specific
							// reason (network-threw vs HTTP 4xx vs site-not-granted)
							// is visible in the worker log — the previous info-only
							// log hid the cause and the sync still reported SUCCESS.
							const postCreateLog =
								result.failed > 0
									? logger.warn.bind(logger)
									: logger.info.bind(logger);
							postCreateLog(
								"[Story Sync] Jira hybrid Cloud — post-create attachment upload",
								{
									externalId,
									cloudId: issueSite?.cloudId ?? null,
									uploaded: result.uploaded,
									failed: result.failed,
									errors: result.errors,
								},
							);
							if (result.uploaded > 0) {
								const followUpUpdateTool =
									capabilities.taskUpdate;
								const followUpArgs: Record<string, unknown> = {
									[followUpUpdateTool.idParam]: externalId,
								};
								if (followUpUpdateTool.descriptionParam) {
									followUpArgs[
										followUpUpdateTool.descriptionParam
									] = result.description;
								}
								await executeMcpTool({
									toolName: followUpUpdateTool.toolName,
									args: followUpArgs,
									userId,
									organizationId,
									projectId,
									mcpConfigId,
								});
							}
						} catch (err) {
							// Never fail the create on attachment-upload
							// failure — degrade silently to the original
							// description (no inline images, but the rest
							// of the body is in place).
							logger.warn(
								"[Story Sync] Jira hybrid Cloud — post-create attachment upload failed; description retains original URLs",
								{
									externalId,
									error:
										err instanceof Error
											? err.message
											: String(err),
								},
							);
						}
					}

					// Persist the new external link with a brief retry. If this
					// write is lost (e.g. a transient DB blip) the story keeps
					// `externalId = null`, so the NEXT sync re-runs the CREATE path
					// and creates a DUPLICATE PM ticket. The item already exists in
					// the PM tool, so a short retry is strictly safer than losing the
					// link. On permanent failure we re-throw to the function-level
					// catch, which records a FAILURE row and returns {success:false}
					// (it does not re-throw, so Temporal never auto-retries the
					// create — no duplicate from this path).
					for (
						let persistAttempt = 1;
						persistAttempt <= 3;
						persistAttempt++
					) {
						try {
							await updateStory(storyId, projectId, {
								externalId,
								externalUrl,
								externalMcpServerId:
									activeServerId ?? undefined,
							});
							break;
						} catch (persistErr) {
							logger.warn(
								"[Story Sync] Failed to persist new external link; retrying",
								{
									storyId,
									externalId,
									attempt: persistAttempt,
									error:
										persistErr instanceof Error
											? persistErr.message
											: String(persistErr),
								},
							);
							if (persistAttempt >= 3) {
								throw persistErr;
							}
							await new Promise((resolve) =>
								setTimeout(resolve, 200 * persistAttempt),
							);
						}
					}
				} else {
					// Surface as much of the PM tool's real error as possible.
					// Join ALL text content items (not just the first) and fall
					// back to the stringified raw output when none are present —
					// some MCP wrappers (notably the ADO server) collapse a real
					// Azure DevOps error like "TF401347: Invalid tree name …
					// 'System.AreaPath'" down to a generic "Work item was not
					// created", so we also log the full raw output for triage.
					let errorDetail = "Unknown error";
					if (
						typeof createResult.output === "object" &&
						createResult.output !== null &&
						"content" in createResult.output
					) {
						const content = (
							createResult.output as {
								content?: Array<{
									type?: string;
									text?: string;
								}>;
							}
						)?.content;
						const text = content
							?.filter((c) => c.type === "text" && c.text)
							.map((c) => c.text)
							.join("\n")
							.trim();
						errorDetail =
							text || JSON.stringify(createResult.output);
					} else if (createResult.output != null) {
						errorDetail =
							typeof createResult.output === "object"
								? // Hosted MCP wrappers (e.g. Fizzy) return a plain
									// `{ error: … }`-shaped object with no `content`
									// array. `String(obj)` collapses to
									// "[object Object]" and hides the real reason —
									// serialize the whole object so the toast/log
									// shows the actual PM-tool error.
									JSON.stringify(createResult.output)
								: String(createResult.output);
					}
					logger.error("[Story Sync] Create task failed", {
						tool: createTool.toolName,
						project: containerId,
						createArgs,
						errorDetail,
						// Full raw output — the trimmed `errorDetail` can hide the
						// real reason when the MCP wrapper swallows it.
						rawOutput: createResult.output,
					});
					throw new Error(
						`Failed to create task in PM tool: ${errorDetail}`,
					);
				}
			} else {
				throw ApplicationFailure.nonRetryable(
					"PM tool does not support task creation",
				);
			}
		}

		// 4. Pull from PM tool
		if (
			(direction === "pull" || direction === "bidirectional") &&
			capabilities.taskGet
		) {
			if (externalId) {
				const getTool = capabilities.taskGet;
				const getArgs: Record<string, unknown> = {
					[getTool.idParam]: externalId,
				};

				// #1360: a stamped link's deletion is owned by the poll (streak +
				// human Accept), so Pull preserves it on a *classified* not-found.
				// A null-provenance (legacy) link cannot be flagged by the poll
				// (it skips null externalMcpServerId), so a classified not-found
				// self-heals (unlinks). A NON-not-found (transient/auth/server)
				// failure NEVER unlinks — preserve and surface a retryable error.
				const hasStampedProvenance = Boolean(story.externalMcpServerId);
				const isNotFoundMessage = (msg: string) =>
					/cannot read prop|not found|does not exist|404|no such/i.test(
						msg,
					);

				// Shared resolver for a classified not-found pull failure (used by
				// every genuine not-found branch below).
				const resolveNotFoundReturn = async (
					phase: string,
				): Promise<StorySyncResult> => {
					if (hasStampedProvenance) {
						await logStoryOutcome("FAILURE", {
							errorCode: "EXTERNAL_ID_NOT_FOUND",
							phase,
						});
						return {
							success: false,
							error: "The linked ticket was not found in the PM tool. The link is kept; if it was deleted, the scheduled sync will flag it for review.",
							errorCode: "EXTERNAL_ID_NOT_FOUND" as const,
							linkPreserved: true,
							syncedAt: new Date(),
							direction,
						};
					}
					await updateStory(storyId, projectId, {
						externalId: null,
						externalUrl: null,
						externalMcpServerId: null,
					});
					await logStoryOutcome("FAILURE", {
						errorCode: "EXTERNAL_ID_NOT_FOUND",
						phase,
					});
					return {
						success: false,
						error: "The external item was not found in the current PM tool. The sync link has been removed.",
						errorCode: "EXTERNAL_ID_NOT_FOUND" as const,
						syncedAt: new Date(),
						direction,
					};
				};

				// Add additional required params
				for (const param of getTool.additionalRequiredParams) {
					if (
						param.includes("board") ||
						param.includes("container") ||
						param === "project"
					) {
						getArgs[param] = containerId;
					} else if (additionalContext?.[param]) {
						getArgs[param] = additionalContext[param];
					}
				}

				// Some PM tools (e.g. Azure DevOps wit_get_work_item) have optional
				// project/container params that, when omitted, trigger interactive
				// elicitation — which our headless client cannot handle. Pre-fill them
				// to bypass elicitation.
				const projectLikeParams = [
					"project",
					"project_id",
					"project_key",
					"board_id",
				];
				for (const param of projectLikeParams) {
					if (!getArgs[param] && containerId) {
						const hasParam = getTool.allParams?.some(
							(p) => p.name === param,
						);
						if (hasParam) {
							getArgs[param] = containerId;
							break;
						}
					}
				}

				// Atlassian Rovo's getJiraIssue requires `cloudId` (same as the
				// create path). It may already be present via additionalContext;
				// if not, resolve it so the pull doesn't fail / silently no-op.
				if (
					(capabilities.detectedType ?? "").toLowerCase() ===
						"jira" &&
					getArgs.cloudId == null &&
					getTool.allParams?.some((p) => p.name === "cloudId")
				) {
					const cloudId = await resolveAtlassianCloudId({
						mcpConfigId,
						userId,
						organizationId,
						availableTools: capabilities.availableTools,
					});
					if (cloudId) {
						getArgs.cloudId = cloudId;
					}
				}

				let getResult: { success: boolean; output?: unknown };
				try {
					getResult = await executeMcpTool({
						toolName: getTool.toolName,
						args: getArgs,
						userId,
						organizationId,
						mcpConfigId,
					});
				} catch (mcpError) {
					// #1360: classify before deciding. A *classified* not-found
					// resolves per provenance (preserve stamped, self-heal
					// legacy). A NON-not-found throw (transient/auth/server) is
					// retryable and NEVER unlinks — preserve the link either way.
					const msg =
						mcpError instanceof Error
							? mcpError.message
							: String(mcpError);
					if (isNotFoundMessage(msg)) {
						return await resolveNotFoundReturn("pull-fetch-threw");
					}
					logger.warn(
						"[Story Sync] Pull threw (transient) — preserving link",
						{
							storyId,
							identifier: story.identifier,
							externalId,
							isLegacySync,
							error: msg,
						},
					);
					await logStoryOutcome("FAILURE", { errorMessage: msg });
					return {
						success: false,
						error: msg,
						syncedAt: new Date(),
						direction,
					};
				}

				if (getResult.success) {
					const parsed = parsePMItemFromGetOutput(getResult.output, {
						baseUrl: pmToolBaseUrl,
						idParamHint: capabilities.taskGet?.idParam,
						fieldMapping: {
							connectedProvider: capabilities.detectedType,
							config: fieldMappingCtx.config,
							enabled: fieldMappingCtx.enabled,
						},
					});

					// Legacy self-heal: if the PM tool returned success but
					// no recognizable item, the externalId likely belongs to
					// a different tool. Clear the stale link.
					if (isLegacySync && !parsed.title && !parsed.externalId) {
						logger.warn(
							"[Story Sync] Legacy pull returned empty — clearing stale external link",
							{
								storyId,
								identifier: story.identifier,
								externalId,
							},
						);
						await updateStory(storyId, projectId, {
							externalId: null,
							externalUrl: null,
							externalMcpServerId: null,
						});
						await logStoryOutcome("FAILURE", {
							errorCode: "EXTERNAL_ID_NOT_FOUND",
							phase: "legacy-pull-empty",
						});
						return {
							success: false,
							error: "The external item was not found in the current PM tool. The sync link has been removed.",
							errorCode: "EXTERNAL_ID_NOT_FOUND" as const,
							syncedAt: new Date(),
							direction,
						};
					}

					const updatePayload: {
						title?: string;
						description?: string | null;
						labels?: string[];
						statusId?: string;
						externalId?: string;
						externalUrl?: string;
						externalMcpServerId?: string;
					} = {};

					// Stamp externalMcpServerId on first successful pull
					if (!story.externalMcpServerId && activeServerId) {
						updatePayload.externalMcpServerId = activeServerId;
					}

					if (
						parsed.externalUrl &&
						parsed.externalUrl !== externalUrl
					) {
						externalUrl = parsed.externalUrl;
						updatePayload.externalUrl = parsed.externalUrl;
					}
					if (
						parsed.externalId &&
						String(parsed.externalId) !== String(externalId ?? "")
					) {
						externalId = parsed.externalId;
						updatePayload.externalId = parsed.externalId;
					}
					if (parsed.title != null) {
						updatePayload.title = parsed.title;
					}
					if (parsed.description !== undefined) {
						// Symmetric inverse of the push pipeline. For Fizzy,
						// we sent HTML (markdownToSimpleHtml output) on
						// push; on pull we receive HTML and need to bring
						// it back to Fabric's canonical form:
						//
						//   1. `simpleHtmlToMarkdown` converts the HTML body
						//      back to markdown (preserving heading levels)
						//      AND converts the HTML `<a>View in Fabric</a>`
						//      back to `[View in Fabric](url)` as a side
						//      effect of its generic <a> handling. The
						//      output is consistent markdown.
						//   2. `normalizeBackLinkFromProvider` rewrites the
						//      `[View in Fabric](url)` link back to the
						//      canonical HTML anchor (Fabric's DB
						//      invariant) so Tiptap renders it as a
						//      clickable link in our UI.
						//
						// For every other provider, step 1 is skipped
						// (description forwarded verbatim) and step 2 is
						// identity. Round-trip stability is verified in
						// fabric-back-link.test.ts.
						const isFizzy =
							(capabilities.detectedType ?? "").toLowerCase() ===
							"fizzy";
						const markdownDesc =
							isFizzy && parsed.description
								? simpleHtmlToMarkdown(parsed.description)
								: cleanAdoCodeBlocks(
										parsed.description,
										capabilities.detectedType,
									);
						updatePayload.description =
							normalizeBackLinkFromProvider(
								markdownDesc,
								capabilities.detectedType,
							);
					}
					if (parsed.labels != null) {
						updatePayload.labels = parsed.labels;
					}

					// Pull-direction image ingest (ADO): the pulled description
					// embeds ADO attachment URLs that require a PAT the browser
					// can't send (broken image icon). Download each with the
					// user's PAT, store it in Fabric, and rewrite to a Fabric-
					// hosted <img> so it renders. Mirror of the push upload path.
					if (
						typeof updatePayload.description === "string" &&
						updatePayload.description.length > 0 &&
						(capabilities.detectedType ?? "").toLowerCase() ===
							"azure-devops"
					) {
						const adoTarget =
							await resolveAdoAttachmentTarget(mcpConfig);
						if (adoTarget?.pat) {
							// ADO file attachments live as work-item relations,
							// not in the description — fetch them and append as
							// links so the ingester below re-hosts them too.
							if (externalId) {
								try {
									const attachments =
										await fetchAdoAttachmentRelations(
											externalId,
											adoTarget,
										);
									updatePayload.description =
										appendAdoAttachmentLinks(
											updatePayload.description ?? "",
											attachments,
										);
								} catch (relErr) {
									logger.warn(
										"[Story Sync] ADO attachment relations fetch failed",
										{
											storyId,
											error:
												relErr instanceof Error
													? relErr.message
													: String(relErr),
										},
									);
								}
							}
							try {
								const ingest = await ingestPulledImages({
									description: updatePayload.description,
									projectId,
									storyId,
									store: createStoryMediaPullStore(),
									...buildAdoIngestOptions(adoTarget.pat),
								});
								updatePayload.description =
									ingest.description ??
									updatePayload.description;
								if (
									ingest.ingested ||
									ingest.reused ||
									ingest.failed
								) {
									logger.info(
										"[Story Sync] ADO pull image ingest",
										{
											storyId,
											ingested: ingest.ingested,
											reused: ingest.reused,
											failed: ingest.failed,
											skipped: ingest.skipped,
										},
									);
								}
							} catch (err) {
								logger.warn(
									"[Story Sync] ADO pull image ingest failed",
									{
										storyId,
										error:
											err instanceof Error
												? err.message
												: String(err),
									},
								);
							}
						}
					}

					// Pull-direction image ingest (Fizzy): same as the ADO block
					// above, but Fizzy media lives behind the Rails ActiveStorage
					// endpoint authenticated with the user's API key. NON-FATAL —
					// any failure keeps the original description so the pull lands.
					if (
						typeof updatePayload.description === "string" &&
						updatePayload.description.length > 0 &&
						(capabilities.detectedType ?? "").toLowerCase() ===
							"fizzy"
					) {
						const fizzyTarget = await resolveFizzyAttachmentTarget(
							mcpConfig,
							additionalContext as
								| Record<string, unknown>
								| null
								| undefined,
						);
						if (fizzyTarget) {
							try {
								const ingest = await ingestPulledImages({
									description: updatePayload.description,
									projectId,
									storyId,
									store: createStoryMediaPullStore(),
									...buildFizzyIngestOptions(
										fizzyTarget.apiKey,
										fizzyTarget.accountSlug,
									),
								});
								updatePayload.description =
									ingest.description ??
									updatePayload.description;
								if (
									ingest.ingested ||
									ingest.reused ||
									ingest.failed
								) {
									logger.info(
										"[Story Sync] Fizzy pull image ingest",
										{
											storyId,
											ingested: ingest.ingested,
											reused: ingest.reused,
											failed: ingest.failed,
											skipped: ingest.skipped,
										},
									);
								}
							} catch (err) {
								logger.warn(
									"[Story Sync] Fizzy pull image ingest failed",
									{
										storyId,
										error:
											err instanceof Error
												? err.message
												: String(err),
									},
								);
							}
						}
					}

					// Resolve status from PM column (by name or by statusColumnMap)
					let resolvedStatusId: string | undefined;
					if (parsed.columnId && additionalContext?.statusColumnMap) {
						const map =
							additionalContext.statusColumnMap as unknown as Record<
								string,
								string
							>;
						resolvedStatusId = Object.keys(map).find(
							(k) => map[k] === parsed.columnId,
						);
					}
					if (!resolvedStatusId && parsed.columnName) {
						const statuses = await listStoryStatuses(projectId);
						const match = statuses.find(
							(s) =>
								s.name.toLowerCase().trim() ===
								parsed.columnName?.toLowerCase().trim(),
						);
						if (match) {
							resolvedStatusId = match.id;
						}
					}
					if (resolvedStatusId) {
						updatePayload.statusId = resolvedStatusId;
					}

					if (Object.keys(updatePayload).length > 0) {
						await updateStory(storyId, projectId, updatePayload);
					}

					logger.info("[Story Sync] Fetched from PM tool", {
						externalId,
						tool: getTool.toolName,
						updatedTitle: !!parsed.title,
						updatedDescription: parsed.description != null,
						updatedLabels: parsed.labels != null,
						updatedStatus: !!resolvedStatusId,
						updatedExternalId: !!updatePayload.externalId,
					});

					// #1360: run the STORY terminal-status reconcile for this card
					// using the RAW payload we just fetched — no extra MCP
					// roundtrip. The raw object (NOT parsePMItemFromGetOutput's
					// result, which drops `closed`/`column`) is what carries the
					// closure signal into normalizePolledState. Non-fatal: a
					// reconcile failure NEVER fails the content pull.
					try {
						const rawObj =
							getResult.output &&
							typeof getResult.output === "object" &&
							Array.isArray(
								(getResult.output as { content?: unknown })
									.content,
							)
								? safeParseMaybeJson(
										(
											getResult.output as {
												content: Array<{
													type?: string;
													text?: string;
												}>;
											}
										).content.find(
											(c) => c?.type === "text",
										)?.text,
									)
								: (getResult.output as
										| Record<string, unknown>
										| undefined);

						// `extract-pm-item-state` imports runtime helpers FROM this
						// module, so a static import back would close a cycle —
						// import it lazily (matches the dynamic-import pattern used
						// for gitlab-rest-story-sync).
						const { normalizePolledState } = await import(
							"./extract-pm-item-state"
						);
						const summary: PMWorkItemSummary = {
							id: externalId ?? "",
							title: parsed.title,
							description: parsed.description ?? null,
							raw: (rawObj ?? {}) as Record<string, unknown>,
						};
						const n = normalizePolledState(summary, {
							kind: "mcp",
							pmTool: capabilities.detectedType ?? undefined,
						});

						const reconcileStory = await getStoryById(
							storyId,
							projectId,
						);
						if (reconcileStory) {
							const project = await db.project.findUnique({
								where: { id: projectId },
								select: {
									pmTerminalStatuses: true,
									pmAutoCloseEnabled: true,
									organizationId: true,
									userId: true,
								},
							});
							const terminalSet =
								project?.pmTerminalStatuses &&
								project.pmTerminalStatuses.length > 0
									? project.pmTerminalStatuses
									: ["Closed", "Done", "Removed"];
							const r = await reconcileStoryTerminalStatus({
								projectId,
								item: {
									externalId: externalId ?? "",
									state: n.statusString ?? "",
									stateChangedDate: n.changedDate
										? n.changedDate.toISOString()
										: null,
									isClosed: n.isClosed,
									labels: n.labels,
								},
								fabricItem: {
									entityType: "STORY",
									entityId: storyId,
									draftingStage: reconcileStory.draftingStage,
									pmAutoHidden:
										reconcileStory.pmAutoHidden ?? false,
									lastSyncedPmHash: null,
									lastPmSyncStatus: null,
								},
								terminalLc: new Set(
									terminalSet.map((s) => s.toLowerCase()),
								),
								autoCloseEnabled:
									project?.pmAutoCloseEnabled ?? false,
								tenant: {
									organizationId:
										project?.organizationId ?? null,
									userId: project?.userId ?? null,
								},
							});
							lifecycle = {
								terminalApplied: r.terminalApplied,
								action: r.action,
								terminalStatusLabel: r.terminalStatusLabel,
							};
						}
					} catch (lifecycleError) {
						lifecycleReconciled = false;
						logger.warn(
							"[Story Sync] terminal-status reconcile failed (non-fatal)",
							{
								storyId,
								error:
									lifecycleError instanceof Error
										? lifecycleError.message
										: String(lifecycleError),
							},
						);
					}
				} else {
					// Pull failed — check if the error indicates the item
					// no longer exists in the active PM tool. If so, the
					// stored externalId is stale and should be cleared
					// (in both legacy and stamped cases). For other errors
					// (auth, rate limit, transient), preserve the link so
					// the user can retry.
					const errorText =
						typeof getResult.output === "string"
							? getResult.output
							: JSON.stringify(getResult.output ?? "");
					const isNotFound =
						/not found|does not exist|404|no such|cannot read prop/i.test(
							errorText,
						);
					logger.warn("[Story Sync] Pull returned failure", {
						storyId,
						identifier: story.identifier,
						externalId,
						isLegacySync,
						isNotFound,
						errorPreview: errorText.slice(0, 500),
					});
					if (isNotFound) {
						// #1360: provenance-gated — preserve stamped link,
						// self-heal null-provenance (legacy) link.
						return await resolveNotFoundReturn(
							"pull-fetch-not-found",
						);
					}
					// Surface non-not-found errors as a clean failure
					// instead of letting the function silently return success.
					await logStoryOutcome("FAILURE", {
						phase: "pull-fetch-failed",
						errorPreview: errorText.slice(0, 200),
					});
					return {
						success: false,
						error: `Failed to fetch from PM tool: ${errorText.slice(0, 200)}`,
						syncedAt: new Date(),
						direction,
					};
				}
			}
		}

		// Record the statusId we just pushed so the next push can compute
		// a label delta (strip stale status labels) instead of a full
		// replace. Only on push or bidirectional — pull-only sync doesn't
		// imply we wrote the status to the remote tracker. Read-only mode
		// skips the push half of a bidirectional sync, so it
		// must NOT stamp "we pushed this status" either — otherwise the next
		// real push would compute a wrong delta against a status never sent.
		if (
			!pushBlockedByReadOnly &&
			(direction === "push" || direction === "bidirectional")
		) {
			try {
				// `lastSyncedStatusId` is an internal sync marker that users
				// never edit, so we intentionally omit `versionContext`: no
				// expected-version check is needed and we don't want a
				// concurrent user edit to make this best-effort write fail.
				await updateStory(storyId, projectId, {
					lastSyncedStatusId: story.statusId,
					...(!story.externalMcpServerId && activeServerId
						? { externalMcpServerId: activeServerId }
						: {}),
				});
			} catch (err) {
				// Non-fatal: failing to record the sync marker doesn't
				// invalidate the push — worst case the next push duplicates
				// a status label until that, too, is reconciled.
				logger.warn(
					"[Story Sync] Failed to update lastSyncedStatusId",
					{
						storyId,
						error: err instanceof Error ? err.message : err,
					},
				);
			}

			// Clear any stale FAILED badge from a prior failed push (e.g. a
			// push against a previously-configured PM tool) — the create/update
			// above succeeded, so the card must stop showing "PM sync failed".
			// Scoped to push/bidirectional: a successful pull doesn't prove a
			// push would now succeed. Non-fatal (helper swallows write errors)
			// so a stamp blip can't mask a real success.
			await recordPmSyncSuccessState({
				itemId: storyId,
				itemType: "story",
			});
		}

		await logStoryOutcome("SUCCESS");
		return {
			success: true,
			externalId,
			externalUrl,
			syncedAt: new Date(),
			direction,
			// #1360: thread the per-item pull terminal-status reconcile outcome.
			// `lifecycle` is null on push / when the reconcile didn't run;
			// `lifecycleReconciled` is true unless the (non-fatal) reconcile threw.
			terminalApplied: lifecycle?.terminalApplied,
			lifecycleAction: lifecycle?.action,
			lifecycleReconciled,
			terminalStatusLabel: lifecycle?.terminalStatusLabel,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		const errorStack = error instanceof Error ? error.stack : undefined;
		logger.error("[Story Sync] Failed", {
			storyId,
			error: errorMessage,
			stack: errorStack,
		});

		// FAILURE log row for a thrown sync. The try-scoped `logStoryOutcome`
		// closure isn't visible here, so snapshot the story directly. NON-FATAL
		// (`recordPmSyncLog` swallows its own write errors). A failure to fetch
		// the snapshot must not break the catch path, so guard the read.
		try {
			const failedStory = await getStoryById(storyId, projectId);
			if (failedStory) {
				await recordPmSyncLog({
					direction: direction === "pull" ? "pull" : "push",
					entityType: "STORY",
					entityId: storyId,
					title: failedStory.title,
					pmTool: detectedPmTool,
					status: "FAILURE",
					errorPayload: {
						errorMessage: errorMessage.slice(0, 500),
						phase: "sync-threw",
					},
					actorUserId: userId,
					externalId: failedStory.externalId ?? null,
					externalUrl: failedStory.externalUrl ?? null,
					organizationId: organizationId ?? null,
					userId: organizationId ? null : userId,
					projectId,
				});
			}
		} catch (logError) {
			logger.warn("[Story Sync] FAILURE log snapshot failed", {
				storyId,
				error:
					logError instanceof Error
						? logError.message
						: String(logError),
			});
		}

		// Self-heal: if the throw happened during a pull AND the error
		// pattern matches a stale-link signal (the active PM tool's MCP
		// stack typically throws "cannot read properties of null" or
		// similar when handed a stored externalId that doesn't exist on
		// the active server), clear the stale link and surface a clean
		// EXTERNAL_ID_NOT_FOUND so the API maps it to BAD_REQUEST.
		const isPull = direction === "pull";
		const looksLikeStaleLink =
			/cannot read prop|not found|does not exist|404|no such/i.test(
				errorMessage,
			);
		if (isPull && looksLikeStaleLink) {
			try {
				const storyForHeal = await getStoryById(storyId, projectId);
				if (storyForHeal?.externalId) {
					// #1360: this branch only fires on a *classified* not-found
					// throw (the regex above already matched). Apply the same
					// provenance gate as the in-try `resolveNotFoundReturn`
					// helper — that helper isn't in scope here (it lives inside
					// the pull `if`), so the logic is inlined. A stamped link's
					// deletion is owned by the poll, so PRESERVE it; a
					// null-provenance (legacy) link can't be flagged by the poll,
					// so keep the self-heal unlink.
					if (storyForHeal.externalMcpServerId) {
						logger.warn(
							"[Story Sync] Pull threw with stale-link signature on a stamped link — preserving (deletion owned by poll)",
							{
								storyId,
								identifier: storyForHeal.identifier,
								externalId: storyForHeal.externalId,
								error: errorMessage,
							},
						);
						return {
							success: false,
							error: "The linked ticket was not found in the PM tool. The link is kept; if it was deleted, the scheduled sync will flag it for review.",
							errorCode: "EXTERNAL_ID_NOT_FOUND" as const,
							linkPreserved: true,
							syncedAt: new Date(),
							direction,
						};
					}
					logger.warn(
						"[Story Sync] Pull threw with stale-link signature — clearing external link",
						{
							storyId,
							identifier: storyForHeal.identifier,
							externalId: storyForHeal.externalId,
							error: errorMessage,
						},
					);
					await updateStory(storyId, projectId, {
						externalId: null,
						externalUrl: null,
						externalMcpServerId: null,
					});
					return {
						success: false,
						error: "The external item was not found in the current PM tool. The sync link has been removed.",
						errorCode: "EXTERNAL_ID_NOT_FOUND" as const,
						syncedAt: new Date(),
						direction,
					};
				}
			} catch (healError) {
				logger.warn("[Story Sync] Self-heal attempt failed", {
					storyId,
					error:
						healError instanceof Error
							? healError.message
							: String(healError),
				});
			}
		}

		return {
			success: false,
			error: errorMessage,
			syncedAt: new Date(),
			direction,
		};
	}
}

/**
 * Result item from listing work items in a PM tool
 */
export interface PMWorkItemSummary {
	id: string;
	/** User-friendly display ID shown in the UI (e.g. "914" for Fizzy, "PROJ-123" for Jira, "42" for GitHub).
	 *  Differs from `id` which is the internal/hash identifier used for syncing. */
	displayId?: string;
	title?: string;
	description?: string | null;
	url?: string | null;
	/** Work-item type (e.g. "Feature", "Bug", "User Story") when available from the adapter. */
	workItemType?: string;
	/** Current state / status of the item (e.g. "New", "Active", "Done") when available from the adapter. */
	state?: string;
	/** Raw item for get tool / full details */
	raw?: Record<string, unknown>;
}

/** An available state on the fetched board with adapter-derived terminal flag. */
export interface PMAvailableState {
	name: string;
	isTerminal: boolean;
}

/** Result returned by listWorkItemsFromPM, including pagination metadata. */
export interface ListWorkItemsResult {
	items: PMWorkItemSummary[];
	/** Total number of items available in the PM tool for this query (may be undefined if the tool does not return a total). */
	total?: number;
	/** Whether there are more pages available. */
	hasNextPage: boolean;
	/** IDs that were requested but could not be fetched (tool error or exception). */
	failedIds?: string[];
	/**
	 * Subset of `failedIds` whose failure is positive evidence the ticket is
	 * ABSENT (404 / "not found" / null GitLab fetch), as opposed to a transient /
	 * auth / config error. Only this set may feed the FLAG_MISSING missing-streak
	 * (#1360 review Fix A). `notFoundIds ⊆ failedIds`.
	 */
	notFoundIds?: string[];
	/** Human-readable error details keyed by failed ID (for surfacing to the user). */
	failedIdErrors?: Record<string, string>;
	/** Distinct work-item types present on the fetched board (populated by Group 3). */
	availableWorkItemTypes?: string[];
	/** Distinct states present on the fetched board with adapter-derived terminal flag (populated by Group 3). */
	availableStates?: PMAvailableState[];
}

/**
 * Result of the ADO batch-get fast path for ticket IDs.
 *
 * Returned by `getWorkItemsByIdsFromPM`. Contains the resolved items plus any
 * per-ID resolution issues (`not_found`, `wrong_board`) detected from the
 * adapter response.
 */
export interface GetWorkItemsByIdsResult {
	items: PMWorkItemSummary[];
	availableWorkItemTypes: string[];
	availableStates: PMAvailableState[];
	notFoundIds: number[];
	wrongBoardIds: number[];
}

/**
 * ADO fast path that wraps `wit_get_work_items_batch_by_ids` to resolve only
 * the requested IDs, skipping the full-board fetch loop.
 *
 * Detection semantics:
 *   - `notFoundIds`: IDs that the batch tool silently dropped (requested \
 *     returned). These never appear in `items[]`.
 *   - `wrongBoardIds`: returned IDs whose `System.TeamProject` does not match
 *     the project's container name. Excluded from `items[]`.
 *   - When `System.TeamProject` is absent on the response, wrong-board
 *     detection is unavailable for that item — it is kept in `items[]` and
 *     surfaced to the caller (the caller can still treat unknown container as
 *     a `not_found` via the procedure-level unknown-container fallback).
 *
 * Already-imported filtering is the procedure's responsibility (see
 * `list-pm-tickets.ts`). This activity's `ids` input has already had those
 * removed, so a single ID never doubles up as both `already_imported` note
 * and `not_found` / `wrong_board` error.
 */
export async function getWorkItemsByIdsFromPM(input: {
	mcpConfigId: string;
	containerId: string;
	containerName?: string;
	additionalContext?: Record<string, string>;
	userId: string;
	organizationId?: string;
	ids: number[];
	/** Override the requested ADO fields (poll needs ChangedDate + Description). */
	fields?: string[];
	/**
	 * When true, a malformed/unparseable/unrecognized SUCCESSFUL payload THROWS
	 * instead of silently treating every id as not-found. The poll passes
	 * strict:true so malformed responses become transient failedIds, not false
	 * deletions. Default false preserves list-pm-tickets behavior.
	 */
	strict?: boolean;
}): Promise<GetWorkItemsByIdsResult> {
	const {
		mcpConfigId,
		containerId,
		containerName,
		additionalContext,
		userId,
		organizationId,
		ids,
		fields: fieldsOverride,
		strict,
	} = input;

	if (ids.length === 0) {
		return {
			items: [],
			availableWorkItemTypes: [],
			availableStates: [],
			notFoundIds: [],
			wrongBoardIds: [],
		};
	}

	const capabilities = await discoverPMToolCapabilities({
		mcpConfigId,
		userId,
		organizationId,
	});

	if (!capabilities) {
		throw ApplicationFailure.nonRetryable(
			"Failed to discover PM tool capabilities",
		);
	}

	// Match the discovered tool name via regex so non-prefixed ADO MCP
	// (`wit_get_work_items_batch_by_ids`) and prefixed variants
	// (`mcp__azure-devops__wit_get_work_items_batch_by_ids`) both resolve.
	const batchToolName = capabilities.availableTools.find((t) =>
		/wit_get_work_items_batch_by_ids$/i.test(t),
	);
	if (!batchToolName) {
		throw ApplicationFailure.nonRetryable(
			"Azure DevOps MCP server does not expose wit_get_work_items_batch_by_ids",
		);
	}

	// ADO project arg: prefer the human-readable container name (e.g. "MyProject"),
	// fall back to containerId. This mirrors the procedure's `containerValue`
	// selection for ADO.
	const project = containerName ?? containerId;

	// Explicitly request the fields we normalize on. The tool's default field
	// set is not guaranteed to include `System.TeamProject`, which we need for
	// wrong-board detection. Callers may override via
	// `fieldsOverride` (e.g. the FLAG_MISSING poll adds ChangedDate + Description).
	const fields = fieldsOverride ?? [
		"System.Id",
		"System.Title",
		"System.WorkItemType",
		"System.State",
		"System.TeamProject",
	];

	const result = await executeMcpTool({
		toolName: batchToolName,
		args: { project, ids, fields },
		userId,
		organizationId,
		mcpConfigId,
	});

	if (!result.success) {
		let err = "Unknown error";
		if (typeof result.output === "object" && result.output !== null) {
			const out = result.output as Record<string, unknown>;
			if (typeof out.error === "string" && out.error) {
				err = out.error;
			} else if (Array.isArray(out.content)) {
				const textItem = (
					out.content as Array<{ type?: string; text?: string }>
				).find((c) => c.type === "text");
				if (textItem?.text) {
					err = textItem.text;
				}
			}
		}
		throw new Error(`Failed to batch-fetch work items: ${err}`);
	}

	// Unwrap MCP content envelope — same shape handling as listWorkItemsFromPM.
	let data: unknown = result.output;
	if (data && typeof data === "object") {
		const obj = data as Record<string, unknown>;
		if (Array.isArray(obj.content)) {
			const textItem = (
				obj.content as Array<{ type?: string; text?: string }>
			).find((c) => c.type === "text");
			if (textItem?.text) {
				try {
					data = JSON.parse(textItem.text);
				} catch {
					if (strict) {
						throw ApplicationFailure.nonRetryable(
							"Malformed batch response (unparseable JSON content)",
						);
					}
					// non-strict: fall through; `arr` defaults to [] (silent-drop).
				}
			}
		}
	}

	let arr: unknown[] = [];
	let recognizedArray = false;
	if (Array.isArray(data)) {
		arr = data;
		recognizedArray = true;
	} else if (data && typeof data === "object") {
		const d = data as Record<string, unknown>;
		const sub =
			(Array.isArray(d.workItems) ? d.workItems : null) ??
			(Array.isArray(d.value) ? d.value : null) ??
			(Array.isArray(d.items) ? d.items : null);
		if (sub) {
			arr = sub;
			recognizedArray = true;
		}
	}
	if (strict && !recognizedArray) {
		throw ApplicationFailure.nonRetryable(
			"Malformed batch response (unrecognized envelope)",
		);
	}

	const items: PMWorkItemSummary[] = [];
	const returnedIds = new Set<number>();
	const wrongBoardIds: number[] = [];

	for (const raw of arr) {
		if (!raw || typeof raw !== "object") {
			continue;
		}
		const rec = raw as Record<string, unknown>;
		const fieldsObj = rec.fields as Record<string, unknown> | undefined;

		const numericId =
			typeof rec.id === "number"
				? rec.id
				: typeof rec.id === "string"
					? Number.parseInt(rec.id, 10)
					: Number.NaN;
		if (!Number.isFinite(numericId)) {
			continue;
		}
		returnedIds.add(numericId);

		const title =
			(fieldsObj?.["System.Title"] as string | undefined) ??
			(rec.title as string | undefined) ??
			`Work Item ${numericId}`;

		const workItemType = extractWorkItemType(rec, fieldsObj);
		const state = extractItemState(rec, fieldsObj);

		const teamProject = fieldsObj?.["System.TeamProject"];
		// Wrong-board detection is only possible when the adapter returns a
		// container identity. When containerName is not configured on the
		// project or `System.TeamProject` is absent we can't discriminate —
		// keep the item and let the caller apply the unknown-container fallback.
		if (
			containerName &&
			typeof teamProject === "string" &&
			teamProject.length > 0 &&
			teamProject !== containerName
		) {
			wrongBoardIds.push(numericId);
			continue;
		}

		const links = rec._links as { web?: { href?: string } } | undefined;
		const url =
			links?.web?.href ??
			((rec.url ?? rec.webUrl ?? rec.link) as string | null | undefined);

		items.push({
			id: String(numericId),
			displayId: String(numericId),
			title,
			description:
				(fieldsObj?.["System.Description"] as
					| string
					| null
					| undefined) ?? null,
			url: url ?? null,
			workItemType,
			state,
			raw: rec,
		});
	}

	const notFoundIds = ids.filter((id) => !returnedIds.has(id));

	// Reuse the shared type/state computation so ADO StateCategory terminal
	// flags stay consistent with listWorkItemsFromPM.
	const { availableWorkItemTypes, availableStates } =
		await computeAvailableTypesAndStates({
			items,
			detectedType: capabilities.detectedType,
			additionalContext: additionalContext ?? {},
			containerId,
			containerParam: capabilities.taskList?.containerParam ?? "project",
			mcpConfigId,
			userId,
			organizationId,
			availableTools: capabilities.availableTools,
		});

	logger.info("[Get Work Items By IDs] ADO batch fetch complete", {
		tool: batchToolName,
		requested: ids.length,
		returned: returnedIds.size,
		notFound: notFoundIds.length,
		wrongBoard: wrongBoardIds.length,
	});

	return {
		items,
		availableWorkItemTypes,
		availableStates,
		notFoundIds,
		wrongBoardIds,
	};
}

/**
 * Map workItemType to ADO backlog categoryReferenceName.
 * These values must match the `categoryReferenceName` returned by wit_list_backlogs,
 * NOT the WIT type strings. See fetch-pm-hierarchy.ts for the canonical reference.
 */
const ADO_WORK_ITEM_TYPE_TO_BACKLOG: Record<string, string> = {
	"User Story": "Microsoft.RequirementCategory",
	Story: "Microsoft.RequirementCategory",
	Stories: "Microsoft.RequirementCategory",
	// Basic process template uses "Issue" instead of "User Story"
	Issue: "Microsoft.RequirementCategory",
	Issues: "Microsoft.RequirementCategory",
	Feature: "Microsoft.FeatureCategory",
	Features: "Microsoft.FeatureCategory",
	Epic: "Microsoft.EpicCategory",
	Epics: "Microsoft.EpicCategory",
	// Bug has no standard ADO backlog category; falls through to name-based matching
};

/**
 * Resolve backlogId for Azure DevOps wit_list_backlog_work_items.
 * Calls the backlogs list tool to get backlogs, then picks one matching workItemType.
 * Uses dynamically discovered tool name (e.g. wit_list_backlogs, mcp_ado_wit_list_backlogs).
 */
async function resolveAdoBacklogId(params: {
	project: string;
	team: string;
	workItemType: string;
	mcpConfigId: string;
	userId: string;
	organizationId?: string;
	/** Discovered tool name for listing backlogs (e.g. wit_list_backlogs) */
	backlogsListToolName: string;
}): Promise<string | undefined> {
	const {
		project,
		team,
		workItemType,
		mcpConfigId,
		userId,
		organizationId,
		backlogsListToolName,
	} = params;

	const result = await executeMcpTool({
		toolName: backlogsListToolName,
		args: { project, team },
		userId,
		organizationId,
		mcpConfigId,
	});

	if (!result.success) {
		logger.warn(
			"[List Work Items] backlogs list tool failed, cannot resolve backlogId",
			{
				toolName: backlogsListToolName,
				project,
				team,
			},
		);
		return undefined;
	}

	let backlogs: Array<{
		id?: string;
		name?: string;
		categoryReferenceName?: string;
	}> = [];
	try {
		const output = result.output as Record<string, unknown>;
		const content = output?.content as
			| Array<{ type?: string; text?: string }>
			| undefined;
		const textItem = content?.find((c) => c.type === "text");
		const text = textItem?.text;
		if (text) {
			const parsed = JSON.parse(text);
			backlogs = Array.isArray(parsed) ? parsed : [];
		}
	} catch (e) {
		logger.warn(
			"[List Work Items] Failed to parse backlogs list response",
			{
				toolName: backlogsListToolName,
				error: String(e),
			},
		);
		return undefined;
	}

	if (backlogs.length === 0) {
		logger.warn(
			"[List Work Items] backlogs list tool returned no backlogs",
			{
				toolName: backlogsListToolName,
			},
		);
		return undefined;
	}

	// ADO backlogs use id field for category (e.g. "Microsoft.RequirementCategory"),
	// not categoryReferenceName (which is often undefined). Check both.
	const targetRef = ADO_WORK_ITEM_TYPE_TO_BACKLOG[workItemType];
	if (targetRef) {
		const match = backlogs.find(
			(b) => (b.categoryReferenceName ?? b.id) === targetRef,
		);
		if (match) {
			return match.categoryReferenceName ?? match.id;
		}
	}

	// Name-based fallback: find backlog whose name mentions the work item type
	const nameMatch = backlogs.find((b) =>
		b.name?.toLowerCase().includes(workItemType.toLowerCase()),
	);
	if (nameMatch) {
		return nameMatch.categoryReferenceName ?? nameMatch.id;
	}

	// Do NOT fall back to backlogs[0] — that's typically the Epic backlog, which returns nothing
	return undefined;
}

/**
 * Parse MCP tool output to extract an array (handles content wrapper, direct array, or object with common keys).
 * Supports Fizzy: accounts, identity.accounts, items, cards, data, results.
 */
export function parseMcpArrayFromOutput(output: unknown): unknown[] {
	if (Array.isArray(output)) {
		return output;
	}
	if (output && typeof output === "object") {
		const obj = output as Record<string, unknown>;
		if (Array.isArray(obj.content)) {
			const textItem = (
				obj.content as Array<{ type?: string; text?: string }>
			).find((c) => c.type === "text");
			if (textItem?.text) {
				try {
					const parsed = JSON.parse(textItem.text) as unknown;
					if (Array.isArray(parsed)) {
						return parsed;
					}
					if (parsed && typeof parsed === "object") {
						const p = parsed as Record<string, unknown>;
						// Fizzy get_identity returns { accounts: [...] }; get_accounts may return array or { accounts }
						const identity = p.identity as
							| Record<string, unknown>
							| undefined;
						return ((Array.isArray(p.accounts)
							? p.accounts
							: null) ??
							(identity && Array.isArray(identity.accounts)
								? identity.accounts
								: null) ??
							(Array.isArray(p.items) ? p.items : null) ??
							(Array.isArray(p.cards) ? p.cards : null) ??
							(Array.isArray(p.data) ? p.data : null) ??
							(Array.isArray(p.results) ? p.results : null) ??
							[]) as unknown[];
					}
					return [];
				} catch {
					return [];
				}
			}
		}
		const identity = obj.identity as Record<string, unknown> | undefined;
		const arr =
			(Array.isArray(obj.accounts) ? obj.accounts : null) ??
			(identity && Array.isArray(identity.accounts)
				? identity.accounts
				: null) ??
			(Array.isArray(obj.items) ? obj.items : null) ??
			(Array.isArray(obj.cards) ? obj.cards : null) ??
			(Array.isArray(obj.data) ? obj.data : null) ??
			[];
		return arr;
	}
	return [];
}

/**
 * Extract a work-item type string from a PM item's raw payload.
 *
 * Per-adapter source (in priority order):
 *   - ADO:    `fields["System.WorkItemType"]`
 *   - Jira:   `fields.issuetype.name`
 *   - Generic/GitHub: `rec.type` / `rec.workItemType` / `rec.work_item_type`
 *
 * Returns `undefined` when no type field is present so that the caller can
 * treat "missing type" as an absence for filtering (spec AC-11 — only types
 * actually present on the fetched board are reported).
 */
function extractWorkItemType(
	rec: Record<string, unknown>,
	fields: Record<string, unknown> | undefined,
): string | undefined {
	const ado = fields?.["System.WorkItemType"];
	if (typeof ado === "string" && ado.length > 0) {
		return ado;
	}
	const jira = fields?.issuetype;
	if (jira && typeof jira === "object") {
		const name = (jira as Record<string, unknown>).name;
		if (typeof name === "string" && name.length > 0) {
			return name;
		}
	}
	const generic =
		rec.workItemType ?? rec.work_item_type ?? rec.type ?? rec.issueType;
	if (typeof generic === "string" && generic.length > 0) {
		return generic;
	}
	return undefined;
}

/**
 * Extract current state/status from a PM item's raw payload.
 *
 * Per-adapter source:
 *   - ADO:    `fields["System.State"]` (e.g. "New", "Active", "Resolved", "Closed")
 *   - Jira:   `fields.status.name`
 *   - GitHub: `rec.state` ("open" | "closed")
 *   - Generic: `rec.status` / `rec.state`
 *
 * For Fizzy, state comes from the column name — populated by
 * `listAllFizzyCards` rather than here since per-card payloads don't carry it.
 */
export function extractItemState(
	rec: Record<string, unknown>,
	fields: Record<string, unknown> | undefined,
): string | undefined {
	const ado = fields?.["System.State"];
	if (typeof ado === "string" && ado.length > 0) {
		return ado;
	}
	const jiraStatus = fields?.status;
	if (jiraStatus && typeof jiraStatus === "object") {
		const name = (jiraStatus as Record<string, unknown>).name;
		if (typeof name === "string" && name.length > 0) {
			return name;
		}
	}
	const generic = rec.state ?? rec.status;
	if (typeof generic === "string" && generic.length > 0) {
		return generic;
	}
	return undefined;
}

/**
 * Extract a normalized "last changed" timestamp from a raw PM item across
 * tools: ADO `System.ChangedDate`, or a generic `updated_at` / `updatedAt` /
 * `changed_date`. Returns a parsed `Date`, or `null` when absent or
 * unparseable. Exported for the poll's normalize step
 * (`extract-pm-item-state.ts`). When null, the poll skips the incremental
 * "changed since last poll" optimization and re-evaluates the item (idempotent
 * — reconcile dedups via `upsertPendingChange`).
 */
export function extractChangedDate(
	rec: Record<string, unknown>,
	fields: Record<string, unknown> | undefined,
): Date | null {
	const value =
		(fields?.["System.ChangedDate"] as unknown) ??
		rec.updated_at ??
		rec.updatedAt ??
		rec.changed_date ??
		rec.last_active_at;
	if (typeof value !== "string" || value.length === 0) {
		return null;
	}
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Read the Jira statusCategory key for a raw item if present.
 *
 * Jira exposes terminal states via `fields.status.statusCategory.key === "done"`
 * — the only way to detect terminals without name heuristics.
 */
function extractJiraStatusCategoryKey(
	rec: Record<string, unknown>,
): string | undefined {
	const fields = rec.fields as Record<string, unknown> | undefined;
	const status = fields?.status;
	if (status && typeof status === "object") {
		const category = (status as Record<string, unknown>).statusCategory;
		if (category && typeof category === "object") {
			const key = (category as Record<string, unknown>).key;
			if (typeof key === "string") {
				return key;
			}
		}
	}
	return undefined;
}

/**
 * Fetch ADO `StateCategory` mapping for a single work-item type.
 *
 * Uses `mcp__azure-devops__wit_get_work_item_type` (or the bare
 * `wit_get_work_item_type` alias) which returns
 * `states: [{ name, category: "Proposed" | "InProgress" | "Resolved" | "Completed" | "Removed" }]`.
 * Per spec, terminal = `Completed | Removed`.
 *
 * Returns `null` on any failure so the caller can fall back to
 * `isTerminal: false` without breaking the listing.
 */
async function fetchAdoStateCategoryMap(params: {
	workItemType: string;
	project: string;
	mcpConfigId: string;
	userId: string;
	organizationId?: string;
	availableTools: string[];
}): Promise<Map<string, boolean> | null> {
	const toolName = params.availableTools.find((t) =>
		/wit_get_work_item_type$/i.test(t),
	);
	if (!toolName) {
		return null;
	}
	try {
		const result = await executeMcpTool({
			toolName,
			args: { project: params.project, type: params.workItemType },
			userId: params.userId,
			organizationId: params.organizationId,
			mcpConfigId: params.mcpConfigId,
		});
		if (!result.success) {
			return null;
		}
		let data: unknown = result.output;
		if (data && typeof data === "object") {
			const obj = data as Record<string, unknown>;
			if (Array.isArray(obj.content)) {
				const textItem = (
					obj.content as Array<{ type?: string; text?: string }>
				).find((c) => c.type === "text");
				if (textItem?.text) {
					try {
						data = JSON.parse(textItem.text);
					} catch {
						return null;
					}
				}
			}
		}
		if (!data || typeof data !== "object") {
			return null;
		}
		const states = (data as Record<string, unknown>).states;
		if (!Array.isArray(states)) {
			return null;
		}
		const map = new Map<string, boolean>();
		for (const s of states) {
			if (!s || typeof s !== "object") {
				continue;
			}
			const rec = s as Record<string, unknown>;
			const name = rec.name;
			const category = rec.category;
			if (typeof name === "string" && typeof category === "string") {
				map.set(
					name,
					category === "Completed" || category === "Removed",
				);
			}
		}
		return map;
	} catch (error) {
		logger.warn(
			"[computeAvailableTypesAndStates] wit_get_work_item_type failed",
			{
				workItemType: params.workItemType,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return null;
	}
}

/**
 * Compute `availableWorkItemTypes` and `availableStates` from parsed items.
 *
 * The `isTerminal` flag is always derived from an adapter-provided category:
 *
 *   - Jira:   `fields.status.statusCategory.key === "done"`
 *   - GitHub: per-item `state === "closed"`
 *   - ADO:    `wit_get_work_item_type.states[].category ∈ {Completed,Removed}`
 *             (one MCP call per distinct type; results cached in this
 *             invocation).
 *   - Fizzy / unknown: `isTerminal: false` for every state.
 */
async function computeAvailableTypesAndStates(params: {
	items: PMWorkItemSummary[];
	detectedType: string | undefined;
	additionalContext: Record<string, string>;
	containerId: string;
	containerParam: string;
	mcpConfigId: string;
	userId: string;
	organizationId?: string;
	availableTools: string[];
}): Promise<{
	availableWorkItemTypes: string[];
	availableStates: PMAvailableState[];
}> {
	const types = new Set<string>();
	for (const item of params.items) {
		if (item.workItemType) {
			types.add(item.workItemType);
		}
	}
	const availableWorkItemTypes = Array.from(types);

	const stateMap = new Map<string, boolean>();
	const detected = (params.detectedType ?? "").toLowerCase();
	const isAdo = detected === "azure-devops" || detected === "ado";
	const isJira = detected === "jira";
	const isGithub = detected === "github";

	// ADO: batch-fetch StateCategory per distinct type. Project arg comes from
	// containerId when containerParam is "project"; else fall back to
	// additionalContext.project.
	const adoTypeCategoryCache = new Map<string, Map<string, boolean> | null>();
	const adoProject =
		params.containerParam === "project"
			? params.containerId
			: (params.additionalContext.project ??
				params.additionalContext.projectId ??
				params.containerId);

	if (isAdo && availableWorkItemTypes.length > 0) {
		for (const type of availableWorkItemTypes) {
			if (!adoTypeCategoryCache.has(type)) {
				const map = await fetchAdoStateCategoryMap({
					workItemType: type,
					project: adoProject,
					mcpConfigId: params.mcpConfigId,
					userId: params.userId,
					organizationId: params.organizationId,
					availableTools: params.availableTools,
				});
				adoTypeCategoryCache.set(type, map);
			}
		}
	}

	for (const item of params.items) {
		const name = item.state;
		if (!name || name.length === 0) {
			continue;
		}
		if (stateMap.has(name)) {
			continue;
		}

		let isTerminal = false;
		if (isJira) {
			isTerminal =
				extractJiraStatusCategoryKey(item.raw ?? {}) === "done";
		} else if (isGithub) {
			isTerminal = name === "closed";
		} else if (isAdo && item.workItemType) {
			const catMap = adoTypeCategoryCache.get(item.workItemType);
			if (catMap) {
				isTerminal = catMap.get(name) === true;
			}
		}
		stateMap.set(name, isTerminal);
	}

	const availableStates: PMAvailableState[] = Array.from(
		stateMap.entries(),
	).map(([name, isTerminal]) => ({ name, isTerminal }));

	return { availableWorkItemTypes, availableStates };
}

/**
 * Bound one listing page's items for an activity return (#1997): shorten
 * bodies until the serialized payload fits the Temporal frame, dropping raw
 * provider payloads last. Warns when degradation fired and fails with a
 * named error when identity fields alone exceed the budget.
 */
function boundedListingItems(
	items: PMWorkItemSummary[],
	label: string,
	meta: Record<string, unknown>,
): PMWorkItemSummary[] {
	const slimmed = slimWorkItemSummaries(items, PAYLOAD_HARD_LIMIT_BYTES);
	if (!slimmed.fits) {
		assertPayloadWithinLimit(slimmed.items, label);
	}
	if (slimmed.elidedDescriptions > 0 || slimmed.droppedRaw > 0) {
		logger.warn(
			`${label}: exceeded the Temporal payload budget — bodies truncated`,
			{
				...meta,
				serializedBytes: slimmed.bytes,
				elidedDescriptions: slimmed.elidedDescriptions,
				droppedRaw: slimmed.droppedRaw,
			},
		);
	}
	return slimmed.items;
}

/**
 * List work items from the PM tool (e.g. ADO backlog).
 * Used for pull flow to import work items into Fabric.
 */
export async function listWorkItemsFromPM(input: {
	mcpConfigId: string | null;
	mcpServerId?: string;
	containerId: string;
	additionalContext?: Record<string, string>;
	userId: string;
	organizationId?: string;
	/** 1-based page number to fetch from the PM tool (when the tool supports pagination). Default: 1 */
	page?: number;
	/** Number of items per page to request from the PM tool. Default: 50 */
	pageSize?: number;
}): Promise<ListWorkItemsResult> {
	const {
		mcpConfigId: maybeMcpConfigId,
		containerId,
		additionalContext,
		userId,
		organizationId,
		page = 1,
		pageSize = 50,
	} = input;

	// REST-GitLab branch: when mcpConfigId is null, dispatch through the REST
	// adapter via callPmToolWithFallback. End-to-end REST listing requires
	// PM-side parity work tracked separately; for now we resolve the source
	// and forward minimal pagination filters.
	if (maybeMcpConfigId == null) {
		if (!input.mcpServerId) {
			throw ApplicationFailure.nonRetryable(
				"listWorkItemsFromPM: mcpConfigId is null but no mcpServerId provided to resolve REST source",
			);
		}
		const source = await resolvePmSource({
			mcpServerId: input.mcpServerId,
			mcpConfigId: null,
			userId,
			organizationId: organizationId ?? null,
			containerId,
		});
		if (source.kind !== "rest-gitlab") {
			throw ApplicationFailure.nonRetryable(
				"listWorkItemsFromPM: resolved source is not rest-gitlab and mcpConfigId is null",
			);
		}
		const restResult = (await callPmToolWithFallback({
			source,
			call: { tool: "listWorkItems", filters: { page, pageSize } },
			userId,
			organizationId: organizationId ?? null,
		})) as ListWorkItemsResult;
		return {
			...restResult,
			items: boundedListingItems(
				restResult.items,
				"listWorkItemsFromPM page (rest-gitlab)",
				{
					page,
					count: restResult.items.length,
				},
			),
		};
	}

	const mcpConfigId = maybeMcpConfigId;

	const capabilities = await discoverPMToolCapabilities({
		mcpConfigId,
		userId,
		organizationId,
	});

	if (!capabilities?.taskList) {
		throw ApplicationFailure.nonRetryable(
			"PM tool does not support listing work items",
		);
	}

	const listTool = capabilities.taskList;

	// Fizzy fallback: if account_slug is missing, fetch from get_accounts or get_identity
	// (for projects created before additionalContext was saved, or when PM settings lack account context)
	let resolvedContext = additionalContext ?? {};
	if (
		/fizzy/i.test(listTool.toolName) &&
		!resolvedContext.account_slug &&
		!resolvedContext.slug
	) {
		const tryFetchAccounts = async (
			toolName: string,
		): Promise<string | null> => {
			try {
				const result = await executeMcpTool({
					toolName,
					args: {},
					userId,
					organizationId,
					mcpConfigId,
				});
				if (!result.success || !result.output) {
					return null;
				}
				const accounts = parseMcpArrayFromOutput(result.output);
				const first = accounts[0] as
					| Record<string, unknown>
					| undefined;
				if (!first) {
					return null;
				}
				// Fizzy accounts may have slug, id, key, or account_slug
				const slug = String(
					first.slug ??
						first.account_slug ??
						first.id ??
						first.key ??
						"",
				);
				return slug || null;
			} catch {
				return null;
			}
		};

		// Try fizzy_get_accounts first, then fizzy_get_identity (identity has embedded accounts)
		const accountsTool = capabilities.availableTools.find(
			(name) =>
				/fizzy_(?:get|list)_accounts?$/i.test(name) ||
				/(?:get|list)_accounts?$/i.test(name),
		);
		const identityTool = capabilities.availableTools.find((name) =>
			/fizzy_get_identity$/i.test(name),
		);

		let slug: string | null = null;
		if (accountsTool) {
			slug = await tryFetchAccounts(accountsTool);
		}
		if (!slug && identityTool) {
			slug = await tryFetchAccounts(identityTool);
		}

		if (slug) {
			resolvedContext = {
				...resolvedContext,
				account_slug: slug,
			};
			logger.info("[List Work Items] Resolved account_slug from Fizzy", {
				account_slug: slug,
			});
		}
	}

	// Merge additionalContext for tools like Fizzy that need account_slug, ADO that needs team, etc.
	// For account-level tools (account_slug, workspace_id): use context value, not containerId (which is board_id)
	const isAccountLevelContainer = /^account_slug$|^workspace_id$/i.test(
		listTool.containerParam,
	);
	const containerValue = isAccountLevelContainer
		? (resolvedContext[listTool.containerParam] ?? containerId)
		: containerId;

	// Fizzy get_cards requires account_slug (and board_id) - fail fast with clear message.
	// containerParam may be board_id, but account_slug is always required for Fizzy API.
	if (
		/fizzy/i.test(listTool.toolName) &&
		!resolvedContext.account_slug &&
		!resolvedContext.slug
	) {
		throw ApplicationFailure.nonRetryable(
			"Pull from Fizzy requires account_slug. Re-save the project's PM settings (e.g. re-select the board) to store account context, or create the project via the 'Existing Project' flow.",
		);
	}

	const listArgs: Record<string, unknown> = {
		[listTool.containerParam]: containerValue,
	};
	// Pass through context keys the tool actually accepts. Spreading the
	// whole resolvedContext leaked stored fields (e.g. workItemType,
	// areaPath, account metadata) into strict provider schemas like
	// GitLab's list_issues, which then rejected the call.
	const allowedParams = new Set(listTool.allParams.map((p) => p.name));
	for (const [key, value] of Object.entries(resolvedContext)) {
		if (key === listTool.containerParam) {
			continue;
		}
		if (allowedParams.has(key)) {
			listArgs[key] = value;
		}
	}

	// Fizzy get_cards: always pass board_id when a board is selected, so we pull only from that board.
	// The tool may use account_slug as containerParam (for API path), but board_id is required to filter.
	if (/fizzy/i.test(listTool.toolName) && containerId && !listArgs.board_id) {
		listArgs.board_id = containerId;
	}

	// Ensure filter params from context are included (status, team, backlogId, etc.)
	for (const param of listTool.filterParams) {
		if (resolvedContext[param]) {
			listArgs[param] = resolvedContext[param];
		}
	}

	// Azure DevOps wit_list_backlog_work_items requires project, team, backlogId.
	// Resolve team and backlogId when missing.
	if (/wit_list_backlog_work_items/i.test(listTool.toolName)) {
		if (!listArgs.team) {
			// Auto-resolve: the wizard hierarchy doesn't capture the team
			// in additionalContext. Resolve by calling core_list_project_teams.
			const resolvedTeam = await resolveAdoDefaultTeam({
				project: String(
					listArgs[listTool.containerParam] ?? containerId,
				),
				mcpConfigId,
				userId,
				organizationId,
				availableTools: capabilities.availableTools,
			});
			if (!resolvedTeam) {
				throw ApplicationFailure.nonRetryable(
					"Pull from Azure DevOps requires a team but none could be resolved. " +
						"Ensure the project has at least one team in Azure DevOps.",
				);
			}
			listArgs.team = resolvedTeam;
		}
		if (!listArgs.backlogId) {
			const backlogsListToolName =
				findBacklogsListTool(capabilities.availableTools) ??
				"wit_list_backlogs"; // fallback for non-prefixed ADO MCP
			const backlogId = await resolveAdoBacklogId({
				project: String(
					listArgs[listTool.containerParam] ?? containerId,
				),
				team: String(listArgs.team),
				workItemType: resolvedContext?.workItemType ?? "User Story",
				mcpConfigId,
				userId,
				organizationId,
				backlogsListToolName,
			});
			if (backlogId) {
				listArgs.backlogId = backlogId;
			} else {
				throw ApplicationFailure.nonRetryable(
					"Could not resolve backlog. Ensure the team has backlogs configured in Azure DevOps.",
					"NoBacklogConfigured",
				);
			}
		}
	}

	// Inject pagination params into the request based on the detected style.
	// cursor style is not mapped to numbered pages — fall back to in-memory pagination.
	const { paginationInfo } = listTool;
	if (paginationInfo.style === "offset-page") {
		if (paginationInfo.pageParam) {
			listArgs[paginationInfo.pageParam] = page;
		}
		if (paginationInfo.pageSizeParam) {
			listArgs[paginationInfo.pageSizeParam] = pageSize;
		}
	} else if (paginationInfo.style === "offset-skip") {
		if (paginationInfo.skipParam) {
			listArgs[paginationInfo.skipParam] = (page - 1) * pageSize;
		}
		if (paginationInfo.pageSizeParam) {
			listArgs[paginationInfo.pageSizeParam] = pageSize;
		}
	}
	// "cursor" and "none" styles: no pagination params added; in-memory fallback applied after parsing.

	const result = await executeMcpTool({
		toolName: listTool.toolName,
		args: listArgs,
		userId,
		organizationId,
		mcpConfigId,
	});

	if (!result.success) {
		let err = "Unknown error";
		if (typeof result.output === "object" && result.output !== null) {
			const out = result.output as Record<string, unknown>;
			if (typeof out.error === "string" && out.error) {
				err = out.error;
			} else if (Array.isArray(out.content)) {
				const textItem = (
					out.content as Array<{ type?: string; text?: string }>
				).find((c) => c.type === "text");
				if (textItem?.text) {
					err = textItem.text;
				}
			}
		}
		throw new Error(`Failed to list work items: ${err}`);
	}

	// Parse response - support various PM tool formats
	const items: PMWorkItemSummary[] = [];
	let data: unknown = result.output;

	let isWrapped = false;
	if (data && typeof data === "object") {
		const obj = data as Record<string, unknown>;
		if (Array.isArray(obj.content)) {
			isWrapped = true;
			const textItem = (
				obj.content as Array<{ type?: string; text?: string }>
			).find((c) => c.type === "text");
			if (textItem?.text) {
				try {
					data = JSON.parse(textItem.text);
				} catch {
					logger.warn("[List Work Items] JSON parse failure", {
						toolName: listTool.toolName,
						textSnippet: textItem.text.slice(0, 200),
					});
					// NEVER treat an unparseable page as an empty one: downstream,
					// an empty full-pull deletes every Fabric story synced from
					// this board. Fail loudly and let the retry/failure surface
					// name the real cause (#1997 review finding).
					throw new Error(
						`PM tool returned an unparseable work-item page (${listTool.toolName})`,
					);
				}
			}
		}
	}

	// Extract array: workItems, value, workItemRefs (ADO), cards (Fizzy), items, data, or direct array
	// Also try to extract total count from common pagination envelope fields.
	let arr: unknown[] = [];
	let responseTotal: number | undefined;
	if (Array.isArray(data)) {
		arr = data;
	} else if (data && typeof data === "object") {
		const d = data as Record<string, unknown>;
		arr =
			(Array.isArray(d.workItems) ? d.workItems : null) ??
			(Array.isArray(d.value) ? d.value : null) ??
			(Array.isArray(d.workItemRefs) ? d.workItemRefs : null) ??
			(Array.isArray(d.cards) ? d.cards : null) ??
			(Array.isArray(d.items) ? d.items : null) ??
			(Array.isArray(d.data) ? d.data : null) ??
			(Array.isArray(d.results) ? d.results : null) ??
			[];

		// Parse total from envelope: total | totalCount | total_count | meta.total | pagination.total
		// NOTE: d.count intentionally excluded — many APIs use "count" to mean items returned
		// in this page, not the total dataset size, which would break hasNextPage detection.
		const rawTotal =
			d.total ??
			d.totalCount ??
			d.total_count ??
			(d.meta && typeof d.meta === "object"
				? (d.meta as Record<string, unknown>).total
				: undefined) ??
			(d.pagination && typeof d.pagination === "object"
				? (d.pagination as Record<string, unknown>).total
				: undefined);
		if (typeof rawTotal === "number" && rawTotal >= 0) {
			responseTotal = rawTotal;
		}
	}

	logger.info("[List Work Items] mcp call result", {
		toolName: listTool.toolName,
		success: result.success,
		isWrapped,
		arrLen: arr.length,
		responseTotal,
		page,
		pageSize,
	});

	for (const item of arr) {
		if (!item || typeof item !== "object") {
			continue;
		}
		let rec = item as Record<string, unknown>;

		// ADO wit_list_backlog_work_items wraps items under "target": { id, url }
		if (rec.target && typeof rec.target === "object") {
			rec = rec.target as Record<string, unknown>;
		}

		const fields = rec.fields as Record<string, unknown> | undefined;

		// Azure DevOps: id + fields["System.Title"], _links.web.href
		// workItemRefs: { id, url } only
		// Fizzy uses card_number (e.g. "#123") or card_id; ADO uses id; Jira uses key
		const id = String(
			rec.id ??
				rec.card_number ??
				rec.number ??
				rec.card_id ??
				rec.issue_id ??
				rec.issue_key ??
				"",
		);
		let title: string | undefined;
		let description: string | null | undefined;
		let url: string | null | undefined;

		if (fields) {
			title = (fields["System.Title"] ?? fields["System.Name"]) as string;
			description = (fields["System.Description"] ??
				fields["System.History"]) as string | null | undefined;
		}
		if (!title) {
			title = (rec.title ??
				rec.name ??
				rec.summary ??
				rec.subject) as string;
		}
		if (description === undefined && !fields) {
			description = (rec.description ?? rec.body ?? rec.content) as
				| string
				| null
				| undefined;
		}

		const links = rec._links as { web?: { href?: string } } | undefined;
		url =
			links?.web?.href ??
			((rec.url ?? rec.webUrl ?? rec.link ?? rec.html_url) as
				| string
				| null
				| undefined);

		if (id) {
			// Extract a user-friendly display ID from the raw record.
			// Priority: card_number (Fizzy "#914") > issue_key (Jira "PROJ-123") >
			//           identifier (Linear "ENG-456") > number (GitHub/general) > key
			// Strip a leading "#" so the UI shows plain "914" not "#914".
			const rawDisplayId =
				rec.card_number ??
				rec.issue_key ??
				rec.identifier ??
				rec.number ??
				rec.key;
			const displayId =
				rawDisplayId != null
					? String(rawDisplayId).replace(/^#/, "").trim() || undefined
					: undefined;

			// Work-item type extraction (adapter-specific paths):
			//   ADO:    fields["System.WorkItemType"]
			//   Jira:   fields.issuetype.name
			//   Generic/GitHub: rec.type / rec.workItemType / rec.work_item_type
			const workItemType = extractWorkItemType(rec, fields);

			// State extraction:
			//   ADO:    fields["System.State"]
			//   Jira:   fields.status.name
			//   GitHub: rec.state ("open"/"closed")
			//   Generic: rec.status / rec.state
			const state = extractItemState(rec, fields);

			items.push({
				id,
				displayId: displayId !== id ? displayId : undefined,
				title: title ?? `Work Item ${id}`,
				description: description ?? null,
				url: url ?? null,
				workItemType,
				state,
				raw: rec,
			});
		}
	}

	// ADO list tools (e.g. wit_list_backlog_work_items) may return sparse refs
	// (id + url only, no titles). Enrich via batch-get when available — single
	// call instead of N+1 individual fetches.
	const sparseItems = items.filter(
		(item) => !item.title || item.title.startsWith("Work Item "),
	);
	if (sparseItems.length > 0) {
		const batchToolName = capabilities.availableTools.find((t) =>
			/wit_get_work_items_batch_by_ids$/i.test(t),
		);

		if (batchToolName) {
			const sparseIds = sparseItems.map((item) => Number(item.id));
			const BATCH_CHUNK_SIZE = 200;
			const batchFields = [
				"System.Id",
				"System.Title",
				"System.WorkItemType",
				"System.State",
				"System.Description",
			];

			logger.info(
				"[List Work Items] Enriching sparse items via batch-get",
				{ count: sparseIds.length, tool: batchToolName },
			);

			const enrichedMap = new Map<string, Record<string, unknown>>();

			for (
				let offset = 0;
				offset < sparseIds.length;
				offset += BATCH_CHUNK_SIZE
			) {
				const chunk = sparseIds.slice(
					offset,
					offset + BATCH_CHUNK_SIZE,
				);
				try {
					const batchResult = await executeMcpTool({
						toolName: batchToolName,
						args: {
							project: containerValue,
							ids: chunk,
							fields: batchFields,
						},
						userId,
						organizationId,
						mcpConfigId,
					});
					if (!batchResult.success) {
						continue;
					}

					let batchData: unknown = batchResult.output;
					if (
						batchData &&
						typeof batchData === "object" &&
						Array.isArray(
							(batchData as Record<string, unknown>).content,
						)
					) {
						const textItem = (
							(batchData as Record<string, unknown>)
								.content as Array<{
								type?: string;
								text?: string;
							}>
						).find((c) => c.type === "text");
						if (textItem?.text) {
							try {
								batchData = JSON.parse(textItem.text);
							} catch {
								continue;
							}
						}
					}

					let arr: unknown[] = [];
					if (Array.isArray(batchData)) {
						arr = batchData;
					} else if (batchData && typeof batchData === "object") {
						const d = batchData as Record<string, unknown>;
						arr =
							(Array.isArray(d.workItems) ? d.workItems : null) ??
							(Array.isArray(d.value) ? d.value : null) ??
							(Array.isArray(d.items) ? d.items : null) ??
							[];
					}

					for (const raw of arr) {
						if (!raw || typeof raw !== "object") {
							continue;
						}
						const rec = raw as Record<string, unknown>;
						const id = String(rec.id ?? "");
						if (id) {
							enrichedMap.set(id, rec);
						}
					}
				} catch {
					// Keep sparse items on batch failure
				}
			}

			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item.title && !item.title.startsWith("Work Item ")) {
					continue;
				}
				const rec = enrichedMap.get(item.id);
				if (!rec) {
					continue;
				}

				const fields = rec.fields as
					| Record<string, unknown>
					| undefined;
				const links = rec._links as
					| { html?: { href?: string }; web?: { href?: string } }
					| undefined;
				items[i] = {
					...item,
					title:
						(fields?.["System.Title"] as string) ??
						(rec.title as string) ??
						item.title,
					description:
						(fields?.["System.Description"] as string) ??
						item.description,
					url:
						links?.html?.href ??
						links?.web?.href ??
						(rec.url as string) ??
						item.url,
					workItemType:
						extractWorkItemType(rec, fields) ?? item.workItemType,
					state: extractItemState(rec, fields) ?? item.state,
					raw: rec,
				};
			}
		} else if (capabilities.taskGet) {
			// Fallback: no batch tool available, enrich one-by-one
			const getTool = capabilities.taskGet;
			const additionalArgs: Record<string, unknown> = {};
			for (const param of getTool.additionalRequiredParams) {
				if (["project", "projectId", "project_id"].includes(param)) {
					additionalArgs[param] = containerId;
				} else if (additionalContext?.[param]) {
					additionalArgs[param] = additionalContext[param];
				}
			}

			logger.info(
				"[List Work Items] Enriching items one-by-one (no batch tool)",
				{ count: sparseItems.length, tool: getTool.toolName },
			);

			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item.title && !item.title.startsWith("Work Item ")) {
					continue;
				}
				try {
					const getResult = await executeMcpTool({
						toolName: getTool.toolName,
						args: {
							[getTool.idParam]: Number(item.id),
							...additionalArgs,
						},
						userId,
						organizationId,
						mcpConfigId,
					});
					if (!getResult.success) {
						continue;
					}

					let data = getResult.output as Record<string, unknown>;
					if (Array.isArray(data.content)) {
						const textItem = (
							data.content as Array<{
								type?: string;
								text?: string;
							}>
						).find((c) => c.type === "text");
						if (textItem?.text) {
							try {
								data = JSON.parse(textItem.text);
							} catch {
								continue;
							}
						}
					}

					const fields = data.fields as
						| Record<string, unknown>
						| undefined;
					const links = data._links as
						| {
								html?: { href?: string };
								web?: { href?: string };
						  }
						| undefined;
					items[i] = {
						...item,
						title:
							(fields?.["System.Title"] as string) ??
							(data.title as string) ??
							item.title,
						description:
							(fields?.["System.Description"] as string) ??
							item.description,
						url:
							links?.html?.href ??
							links?.web?.href ??
							(data.url as string) ??
							item.url,
						workItemType:
							extractWorkItemType(data, fields) ??
							item.workItemType,
						state: extractItemState(data, fields) ?? item.state,
						raw: data,
					};
				} catch {
					// Keep original sparse item on failure
				}
			}
		}
	}

	// For tools without native pagination (style "none" or "cursor"), the full result
	// is returned in one call. For paginated calls the PM tool already scoped the page.
	//
	// PM tools may silently cap page size below what we requested (e.g. Fizzy
	// returns max ~15 items even when we ask for 100). Two strategies:
	//
	// 1. When responseTotal is available: compare cumulative items actually
	//    received against responseTotal (not the requested pageSize).
	// 2. When responseTotal is NOT available (Fizzy, etc.): keep fetching as
	//    long as the page returned any items. This costs one extra empty-page
	//    call at the end but guarantees we collect all items regardless of
	//    the tool's internal page-size cap.
	const itemsFetchedSoFar = (page - 1) * items.length + items.length;
	const hasNextPage =
		paginationInfo.style === "none" || paginationInfo.style === "cursor"
			? false // in-memory pagination handled by the caller
			: responseTotal != null
				? items.length > 0 && itemsFetchedSoFar < responseTotal
				: items.length > 0; // no total available — keep going until an empty page

	logger.info("[List Work Items] Fetched from PM", {
		tool: listTool.toolName,
		count: items.length,
		total: responseTotal,
		page,
		pageSize,
		paginationStyle: paginationInfo.style,
		hasNextPage,
	});

	// Compute distinct types + states with adapter-derived `isTerminal`.
	// For ADO we fetch work-item-type definitions once per distinct type to
	// derive `StateCategory` → terminal flag (§11 "never from state-name").
	const { availableWorkItemTypes, availableStates } =
		await computeAvailableTypesAndStates({
			items,
			detectedType: capabilities.detectedType,
			additionalContext: resolvedContext,
			containerId,
			containerParam: listTool.containerParam,
			mcpConfigId,
			userId,
			organizationId,
			availableTools: capabilities.availableTools,
		});

	// Bound the page payload (#1997): a page of full card bodies crosses this
	// boundary as ONE Temporal message, and past the gRPC frame the completion
	// RPC is rejected and the pull stalls (#1741 class). Degrade instead of
	// stall — keep every item's identity, shorten bodies until it fits.
	const boundedItems = boundedListingItems(
		items,
		"listWorkItemsFromPM page",
		{ tool: listTool.toolName, page, count: items.length },
	);

	return {
		items: boundedItems,
		total: responseTotal,
		hasNextPage,
		availableWorkItemTypes,
		availableStates,
	};
}

/**
 * Server-side keyword search via the PM tool's native search endpoint
 * (currently Azure DevOps `search_workitem`). Bypasses the backlog-listing
 * path entirely — no team backlog dependency, no 2000-item ceiling, and the
 * PM tool's own relevance ranking decides what comes back.
 *
 * Caller responsibility: only invoke when a search-capable tool is available
 * on this MCP config. On failure, the procedure should log + fall back to
 * `listWorkItemsFromPM` + in-memory filtering so a transient or shape-level
 * error never breaks keyword search end-to-end.
 *
 * Throws `ApplicationFailure` (non-retryable) with `type="NoSearchCapability"`
 * when no `search_workitem`-style tool is registered for the connected MCP.
 */
export async function searchWorkItemsFromPM(input: {
	mcpConfigId: string;
	containerId: string;
	additionalContext?: Record<string, string>;
	userId: string;
	organizationId?: string;
	/** Free-text query string to send to the PM tool's search endpoint. */
	query: string;
	/** Max results to request (clamped 1..200, default 100). */
	top?: number;
}): Promise<ListWorkItemsResult> {
	const { mcpConfigId, containerId, userId, organizationId, query } = input;
	const top = Math.min(Math.max(input.top ?? 100, 1), 200);

	const capabilities = await discoverPMToolCapabilities({
		mcpConfigId,
		userId,
		organizationId,
	});

	// Match `search_workitem`, `search_workitems`, and any prefixed variants
	// emitted by gateway MCP servers (e.g. `mcp_ado_search_workitem`).
	const searchToolName = capabilities?.availableTools?.find((name) =>
		/(?:^|_)search_workitems?$/i.test(name),
	);
	if (!searchToolName) {
		throw ApplicationFailure.nonRetryable(
			"PM tool does not expose a work-item search capability",
			"NoSearchCapability",
		);
	}

	// ADO Work Item Search REST contract: `searchText`, `$top`, optional
	// `filters: { Project: [...], "System.WorkItemType": [...] }`. The MCP
	// tool wrapper accepts the same shape with `project` as a convenience
	// alias for the project filter.
	const searchArgs: Record<string, unknown> = {
		searchText: query,
		project: containerId,
		$top: top,
	};

	const result = await executeMcpTool({
		toolName: searchToolName,
		args: searchArgs,
		userId,
		organizationId,
		mcpConfigId,
	});

	if (!result.success) {
		let err = "Unknown error";
		if (typeof result.output === "object" && result.output !== null) {
			const out = result.output as Record<string, unknown>;
			if (typeof out.error === "string" && out.error) {
				err = out.error;
			} else if (Array.isArray(out.content)) {
				const textItem = (
					out.content as Array<{ type?: string; text?: string }>
				).find((c) => c.type === "text");
				if (textItem?.text) {
					err = textItem.text;
				}
			}
		}
		throw new Error(`Failed to search work items: ${err}`);
	}

	// Unwrap MCP content envelope (same pattern as listWorkItemsFromPM).
	let data: unknown = result.output;
	if (data && typeof data === "object") {
		const obj = data as Record<string, unknown>;
		if (Array.isArray(obj.content)) {
			const textItem = (
				obj.content as Array<{ type?: string; text?: string }>
			).find((c) => c.type === "text");
			if (textItem?.text) {
				try {
					data = JSON.parse(textItem.text);
				} catch {
					logger.warn("[Search Work Items] JSON parse failure", {
						toolName: searchToolName,
						textSnippet: textItem.text.slice(0, 200),
					});
					return { items: [], total: 0, hasNextPage: false };
				}
			}
		}
	}

	// ADO Work Item Search response: { count, results: [{ project, fields, url }] }
	let arr: unknown[] = [];
	let responseTotal: number | undefined;
	if (Array.isArray(data)) {
		arr = data;
	} else if (data && typeof data === "object") {
		const d = data as Record<string, unknown>;
		arr =
			(Array.isArray(d.results) ? d.results : null) ??
			(Array.isArray(d.value) ? d.value : null) ??
			(Array.isArray(d.workItems) ? d.workItems : null) ??
			(Array.isArray(d.items) ? d.items : null) ??
			[];
		const rawTotal = d.totalCount ?? d.total ?? d.count;
		if (typeof rawTotal === "number" && rawTotal >= 0) {
			responseTotal = rawTotal;
		}
	}

	logger.info("[Search Work Items] mcp call result", {
		toolName: searchToolName,
		success: result.success,
		arrLen: arr.length,
		responseTotal,
		queryLength: query.length,
	});

	const items: PMWorkItemSummary[] = [];
	for (const item of arr) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const rec = item as Record<string, unknown>;

		// ADO Work Item Search uses lowercased field keys (`system.id`,
		// `system.title`, `system.workitemtype`, `system.state`, …) whereas
		// the standard work-item REST shape uses PascalCase (`System.Title`).
		// Normalize via a case-insensitive lookup so both shapes work.
		const rawFields = (rec.fields ?? {}) as Record<string, unknown>;
		const fields: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(rawFields)) {
			fields[k.toLowerCase()] = v;
		}
		const getField = (...names: string[]): unknown => {
			for (const n of names) {
				const v = fields[n.toLowerCase()];
				if (v !== undefined && v !== null && v !== "") {
					return v;
				}
			}
			return undefined;
		};

		const id = String(getField("system.id") ?? rec.id ?? "");
		if (!id) {
			continue;
		}

		const title = (getField("system.title", "system.name") ??
			rec.title ??
			rec.name ??
			rec.summary) as string | undefined;
		const description = (getField("system.description") ??
			rec.description ??
			null) as string | null;
		const workItemType = (getField("system.workitemtype") ??
			rec.workItemType ??
			rec.type) as string | undefined;
		const state = (getField("system.state") ?? rec.state ?? rec.status) as
			| string
			| undefined;

		const links = rec._links as { web?: { href?: string } } | undefined;
		const url =
			links?.web?.href ??
			((rec.url ?? rec.webUrl ?? rec.html_url) as
				| string
				| null
				| undefined) ??
			null;

		items.push({
			id,
			// ADO uses the numeric id as the displayId — same as the rest of
			// the codebase (callers fall back `displayId ?? id`).
			displayId: undefined,
			title: title ?? `Work Item ${id}`,
			description: description ?? null,
			url,
			workItemType,
			state,
			raw: rec,
		});
	}

	// Search returns a ranked top-N — caller does not paginate further.
	return {
		items,
		total: responseTotal ?? items.length,
		hasNextPage: false,
	};
}

/**
 * Fetch specific PM items directly by ID using the PM tool's taskGet capability.
 *
 * Used by selective pull to bypass backlog/list pagination entirely — avoids
 * the `wit_list_backlogs` resolver failure mode where ADO returns null for teams
 * whose backlog categories the MCP server cannot enumerate (even when the UI
 * shows them configured). As long as the user has valid work item IDs, we can
 * always fetch them one-by-one via `wit_get_work_item`.
 */
// Conservative not-found classifier (#1360 review Fix A). Returns true ONLY on
// positive evidence the ticket is absent; every ambiguous/transient/auth/config
// error returns false (we under-flag rather than risk a false deletion — only a
// definite not-found may feed the FLAG_MISSING streak).
//
// Permission-ambiguity veto (#1360 review HIGH finding). ADO, GitHub, and Jira
// deliberately conflate "does not exist" with "you do not have permission" in a
// single message (e.g. ADO TF401232: "Work item 42 does not exist, or you do
// not have permissions to read it"). Such a message is NOT positive deletion
// evidence — a still-valid ticket the caller temporarily can't read would
// otherwise be classified as deleted and, over three poll cycles, produce a
// false "Unlink" proposal. These patterns are checked FIRST and short-circuit
// the classifier to `false`, even when the message also contains not-found text.
const PM_PERMISSION_AMBIGUITY_PATTERNS = [
	/permission/i,
	/not authorized/i,
	/unauthorized/i,
	/access denied/i,
	/forbidden/i,
	/do not have/i,
	/don't have/i,
	/\b401\b/,
	/\b403\b/,
	/access token/i,
];

// Positive not-found evidence — ONLY unambiguous generic phrases. The over-broad
// `/no .* (found|exists)/i` clause and the bare ADO codes (TF401232 / VS402371)
// were removed: their real messages say "or you do not have permissions", so
// they are caught by the veto above; matching the bare code without that
// explanatory text risked classifying a permission error as a deletion.
//
// ACCEPTED RESIDUAL (#1360, deliberate — do NOT silently tighten or loosen):
// a bare `404` / "not found" is itself irreducibly ambiguous for tools that mask
// private-but-valid items as 404 (e.g. GitHub) to avoid leaking existence — there
// is no text signal that distinguishes "deleted" from "you can't see it". We keep
// these patterns anyway because dropping them would make FLAG_MISSING near-inert
// for every MCP tool (ADO/GitHub/Jira/Fizzy/Linear), leaving only GitLab's
// structural null-return. The masked-private risk is contained, NOT by this
// classifier, but by the layers downstream: the 3-cycle streak, the outage guard
// (mass-masking → suppressed), the positive active-server source scope, the
// server-scoped unlink guard, and — critically — a MANDATORY human Accept (nothing
// auto-unlinks; a user seeing a known-valid ticket flagged "deleted?" dismisses
// it). Provider-aware 404 classification is the proper fix and is backlogged.
//
// UPDATE (#1360 structural cycle): ADO no longer relies on this text classifier
// for not-found — the poll uses wit_get_work_items_batch_by_ids silent-drop
// (structural). This classifier still serves non-ADO MCP providers. ADO's
// residual is the deleted-vs-permission conflation (batch omits both), contained
// by the same streak/outage/source/human-Accept layers; recycle-bin
// disambiguation is backlogged.
const PM_NOT_FOUND_PATTERNS = [
	/\bnot found\b/i,
	/does not exist/i,
	/could not be found/i,
	/\b404\b/,
];

/**
 * True only when the error message is positive, unambiguous evidence the PM
 * ticket is absent (404 / "not found" / "does not exist" / "could not be
 * found"). A permission-ambiguity veto runs FIRST: any auth/permission/access
 * signal ("permission", "forbidden", "401"/"403", "access token", …) forces
 * `false`, even if the message also contains not-found-looking text — because
 * deletion evidence must be unambiguous. Auth, rate limit, timeout, empty, and
 * null all return false. Used by the FLAG_MISSING producer to classify which
 * `failedIds` are definite not-found.
 */
export function isPmNotFoundError(message: string | null | undefined): boolean {
	if (!message) {
		return false;
	}
	// Veto first: a permission/auth/access signal means this is NOT proof of
	// deletion, regardless of any not-found-looking text in the same message.
	if (PM_PERMISSION_AMBIGUITY_PATTERNS.some((re) => re.test(message))) {
		return false;
	}
	return PM_NOT_FOUND_PATTERNS.some((re) => re.test(message));
}

/**
 * Extract a human-readable error string from an `executeMcpTool` result's
 * `output`, across the shapes it can take:
 *   1. MCP isError content — `{ content: [{ type:"text", text }] }`
 *   2. executeMcpTool catch shape — `{ error: string }` (a thrown tool error /
 *      JSON-RPC protocol error surfaced by the MCP client; e.g. Fizzy's relay
 *      returns `error{code:-32603, message:"Resource not found: …"}` on a 404).
 *   3. fallback — `String(output)`.
 * Before this helper the `{ error }` shape was stringified to "[object Object]",
 * destroying the not-found signal for any provider whose MCP throws a JSON-RPC
 * error on a missing item (#1360 Fizzy delete).
 */
export function extractMcpErrorText(output: unknown): string {
	if (output && typeof output === "object") {
		const o = output as {
			content?: Array<{ type?: string; text?: string }>;
			error?: unknown;
		};
		if (Array.isArray(o.content)) {
			return o.content.find((c) => c.type === "text")?.text ?? "";
		}
		if (typeof o.error === "string") {
			return o.error;
		}
	}
	return String(output ?? "");
}

/**
 * True when `data` carries at least one field the `fetchPMItemsByIds` extractor
 * can turn into a NON-fallback item (a real title/description/url source).
 * Bare `id`/`key`/`state` do NOT count — an id is just our own requested id
 * echoed back, not evidence the item exists (#1360 non-ado structural
 * not-found, Codex R2). Mirrors the extractor's field set so no response that
 * would yield real content is ever dropped.
 */
export function hasUsablePmContent(data: unknown): boolean {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return false;
	}
	const d = data as Record<string, unknown>;
	const fields = d.fields as Record<string, unknown> | undefined;
	const links = d._links as
		| { html?: { href?: string }; web?: { href?: string } }
		| undefined;
	const str = (v: unknown): boolean => typeof v === "string" && v.length > 0;

	const hasTitle =
		str(fields?.["System.Title"]) ||
		str(fields?.summary) ||
		str(d.title) ||
		str(d.name);
	// Mirror the extractor EXACTLY (Codex plan-R1): the builder uses
	// `descriptionToText(fields?.description)`, which yields text only for
	// strings / non-empty ADF docs (a non-ADF object or empty ADF → undefined or
	// ""). A `!= null` shortcut would over-admit `{ fields: { description: {} } }`
	// as present → fallback "Work Item N" phantom.
	const descFromAdf = descriptionToText(fields?.description);
	const hasDescription =
		str(fields?.["System.Description"]) ||
		(typeof descFromAdf === "string" && descFromAdf.length > 0) ||
		str(d.description);
	const hasUrl =
		str(links?.html?.href) || str(links?.web?.href) || str(d.url);

	return hasTitle || hasDescription || hasUrl;
}

/** Bounds for the recursive permission-veto string scan (#1360, Codex R7). */
const PM_VETO_MAX_DEPTH = 6;
const PM_VETO_MAX_NODES = 200;

/**
 * Bounded recursive walk collecting every string value in a response. Sets
 * `state.truncated = true` if the depth or node cap is hit (some strings left
 * unscanned) so the caller can fail closed (Codex plan-R2).
 */
function collectPmResponseStrings(
	data: unknown,
	out: string[],
	depth: number,
	budget: { n: number },
	state: { truncated: boolean },
): void {
	if (state.truncated) {
		return; // stop entirely once the cap was hit
	}
	// Count EVERY visited node against the budget (Codex plan-R3) — not just
	// strings — so a wide object/array payload actually hits the 200-node cap and
	// the scan stays bounded; any truncation then fails closed in the caller.
	if (budget.n <= 0) {
		state.truncated = true;
		return;
	}
	budget.n--;
	if (depth > PM_VETO_MAX_DEPTH) {
		state.truncated = true;
		return;
	}
	if (typeof data === "string") {
		out.push(data);
		return;
	}
	// Loops BREAK the instant the budget is exhausted and never materialize the
	// child set (no Object.values/Object.keys — those allocate the whole array
	// up front). Total work therefore stays bounded by PM_VETO_MAX_NODES even on
	// a pathologically wide payload (Codex plan-R4).
	if (Array.isArray(data)) {
		for (let i = 0; i < data.length && !state.truncated; i++) {
			collectPmResponseStrings(data[i], out, depth + 1, budget, state);
		}
		return;
	}
	if (data && typeof data === "object") {
		const obj = data as Record<string, unknown>;
		for (const key in obj) {
			if (state.truncated) {
				break;
			}
			if (!Object.hasOwn(obj, key)) {
				continue;
			}
			collectPmResponseStrings(obj[key], out, depth + 1, budget, state);
		}
	}
}

/**
 * True only when a SUCCESSFUL `taskGet` response is high-confidence evidence
 * the item is absent, safe on a generic MCP boundary (#1360 non-ado structural
 * not-found). FAIL-CLOSED:
 *   Step 0 — a global RECURSIVE permission veto runs first: any permission/auth
 *     text anywhere in the response (Codex R6/R7) forces `false`, governing the
 *     sentinels too.
 *   Then `true` only for (1) an explicit `found===false`/`exists===false`
 *     sentinel, or (2) not-found text in a DEDICATED error field
 *     (`error`/`errorMessages`). `null`/`[]`/`message`/`detail`/raw
 *     `content[].text` are NOT absent (→ caller treats as ambiguous).
 * Intended to run only AFTER `hasUsablePmContent` returns false (content-wins).
 */
export function isStructurallyAbsentPmResponse(data: unknown): boolean {
	// Step 0: global recursive permission veto.
	const strings: string[] = [];
	const state = { truncated: false };
	collectPmResponseStrings(data, strings, 0, { n: PM_VETO_MAX_NODES }, state);
	if (
		strings.some((s) =>
			PM_PERMISSION_AMBIGUITY_PATTERNS.some((re) => re.test(s)),
		)
	) {
		return false;
	}
	// Fail closed on truncation: if the scan hit the depth/node cap we cannot
	// prove no permission text exists beyond it, so never classify as absent
	// (treat as ambiguous → caller routes to failedIds). (Codex plan-R2)
	if (state.truncated) {
		return false;
	}

	// Positive signals require an object (null/[]/primitives are NOT absent).
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return false;
	}
	const d = data as Record<string, unknown>;

	// 1. explicit negative sentinel.
	if (d.found === false || d.exists === false) {
		return true;
	}

	// 2. not-found text in a dedicated error-carrier field (veto already ran).
	const errorTexts: string[] = [];
	if (typeof d.error === "string") {
		errorTexts.push(d.error);
	}
	if (typeof d.errorMessages === "string") {
		errorTexts.push(d.errorMessages);
	}
	if (Array.isArray(d.errorMessages)) {
		for (const m of d.errorMessages) {
			if (typeof m === "string") {
				errorTexts.push(m);
			}
		}
	}
	return errorTexts.some((s) =>
		PM_NOT_FOUND_PATTERNS.some((re) => re.test(s)),
	);
}

export async function fetchPMItemsByIds(input: {
	mcpConfigId: string | null;
	mcpServerId?: string;
	containerId: string;
	externalIds: string[];
	additionalContext?: Record<string, string>;
	userId: string;
	organizationId?: string;
	/**
	 * Maximum number of in-flight `taskGet` MCP calls. Defaults to 1 so
	 * existing callers (e.g. `story-sync-workflow.ts`) keep their original
	 * serial behavior. Procedure-level callers that want a fast path can
	 * pass a higher value (e.g. 5) to bound a worker-pool.
	 */
	concurrency?: number;
	/** Opt-in per-`executeMcpTool` timeout (ms). Forwarded as `timeoutMs` to the
	 *  per-card gets AND to capability discovery. */
	callTimeoutMs?: number;
	/**
	 * Opt-in soft budget (ms) for the WHOLE MCP fetch. Converted to one absolute
	 * `deadlineAt = entry + budgetMs` (DEC-7) so pre-pool work (discovery + slug
	 * probe) counts too; the pool stops pulling past it and un-attempted ids
	 * become transient `failedIds`.
	 */
	budgetMs?: number;
}): Promise<ListWorkItemsResult> {
	const {
		mcpConfigId: maybeMcpConfigId,
		containerId,
		externalIds,
		additionalContext,
		userId,
		organizationId,
		concurrency = 1,
		callTimeoutMs,
		budgetMs,
	} = input;

	// REST-GitLab branch: dispatch each externalId fetch through the REST
	// adapter. PM-side response shaping is normalized by getGitLabIssueForPM
	// to match PmItem; we collect them into ListWorkItemsResult.
	if (maybeMcpConfigId == null) {
		if (!input.mcpServerId) {
			throw ApplicationFailure.nonRetryable(
				"fetchPMItemsByIds: mcpConfigId is null but no mcpServerId provided to resolve REST source",
			);
		}
		const source = await resolvePmSource({
			mcpServerId: input.mcpServerId,
			mcpConfigId: null,
			userId,
			organizationId: organizationId ?? null,
			containerId,
		});
		if (source.kind !== "rest-gitlab") {
			throw ApplicationFailure.nonRetryable(
				"fetchPMItemsByIds: resolved source is not rest-gitlab and mcpConfigId is null",
			);
		}
		const items: PMWorkItemSummary[] = [];
		const failedIds: string[] = [];
		const notFoundIds: string[] = [];
		const failedIdErrors: Record<string, string> = {};
		for (const id of externalIds) {
			try {
				// `fetchItem` resolves to getGitLabIssueForPM, which returns the
				// issue's content fields but NOT the IID — so we attach `id`
				// ourselves. Without it, the workflow's selective-pull filter
				// (`filterSet.has(item.id)`) drops every fetched item.
				const fetched = (await callPmToolWithFallback({
					source,
					call: { tool: "fetchItem", externalId: id },
					userId,
					organizationId: organizationId ?? null,
				})) as {
					title?: string;
					description?: string | null;
					externalUrl?: string | null;
					labels?: string[];
				} | null;
				if (fetched) {
					items.push({
						id,
						displayId: id,
						title: fetched.title,
						description: fetched.description ?? null,
						url: fetched.externalUrl ?? null,
						workItemType: "Issue",
						raw: fetched as unknown as Record<string, unknown>,
					});
				} else {
					// A null GitLab fetch is the REST adapter's "issue absent"
					// signal — positive not-found evidence (#1360 review Fix A).
					failedIds.push(id);
					notFoundIds.push(id);
					failedIdErrors[id] = "not found";
				}
			} catch (err) {
				// A thrown error is transient/auth/network — NOT proof of absence.
				failedIds.push(id);
				failedIdErrors[id] =
					err instanceof Error ? err.message : String(err);
			}
		}
		return {
			items,
			total: items.length,
			hasNextPage: false,
			failedIds,
			notFoundIds,
			failedIdErrors,
		};
	}

	const mcpConfigId = maybeMcpConfigId;

	// One absolute deadline for the WHOLE MCP path (DEC-7): pre-pool work
	// (discovery + slug probe) is charged against the same clock as the pool, so
	// total wall time stays under the activity `startToCloseTimeout`.
	const deadlineAt =
		budgetMs !== undefined ? Date.now() + budgetMs : undefined;

	// Bound discovery via its own internal timeout (Step 3c) so a hung connect/
	// list can't stall the poll before the pool exists. A DISCOVERY_TIMEOUT is
	// TRANSIENT → empty partial (complete=false, anchor untouched — DEC-6); any
	// other failure keeps the existing "does not support fetching" throw.
	const disc = await discoverPMToolCapabilitiesResult({
		mcpConfigId,
		userId,
		organizationId,
		timeoutMs: callTimeoutMs,
	});
	if (!disc.ok && disc.error.code === "DISCOVERY_TIMEOUT") {
		logger.warn(
			"[Fetch PM Items By IDs] Capability discovery timed out — returning empty (transient)",
			{ count: externalIds.length, timeoutMs: callTimeoutMs },
		);
		const failedIdErrors: Record<string, string> = {};
		for (const id of externalIds) {
			failedIdErrors[id] = "discovery timed out (not attempted)";
		}
		return {
			items: [],
			total: 0,
			hasNextPage: false,
			failedIds: [...externalIds],
			notFoundIds: [],
			failedIdErrors,
		};
	}
	const capabilities = disc.ok ? disc.capabilities : null;

	if (!capabilities?.taskGet) {
		throw ApplicationFailure.nonRetryable(
			"PM tool does not support fetching items by ID",
		);
	}

	// Fast-path early return: avoid building additionalArgs, allocating
	// itemSlots, spawning workers, and awaiting Promise.all when there's
	// nothing to fetch. Placed after the capability check so callers passing
	// an empty array against an unconfigured tool still see the contract
	// failure.
	if (externalIds.length === 0) {
		return {
			items: [],
			total: 0,
			hasNextPage: false,
			failedIds: [],
			notFoundIds: [],
		};
	}

	const getTool = capabilities.taskGet;
	const isADO =
		/azure|ado|wit_/i.test(getTool.toolName) ||
		capabilities.availableTools.some((n) => /^wit_/i.test(n));

	// Fizzy `taskGet` (`fizzy_get_card`) requires `account_slug`. Projects
	// created before that field was wired through to `additionalContext` —
	// or whose PM settings were saved without re-selecting the board —
	// don't have it set, so every call here would fail with "Account slug
	// is required" (observed live: 117 such failures in 45 min on staging).
	// The sibling `listWorkItemsFromPM` already had this fallback inline;
	// extracted to `fizzy-account-slug.ts` so both paths share it.
	const { additionalContext: resolvedContext } =
		await resolveFizzyAccountSlug({
			toolName: getTool.toolName,
			availableTools: capabilities.availableTools,
			additionalContext,
			mcpConfigId,
			userId,
			organizationId,
			callTimeoutMs,
		});

	const additionalArgs: Record<string, unknown> = {};
	for (const param of getTool.additionalRequiredParams) {
		if (["project", "projectId", "project_id"].includes(param)) {
			additionalArgs[param] = containerId;
		} else if (resolvedContext[param]) {
			additionalArgs[param] = resolvedContext[param];
		}
	}

	// ADO marks `project` as optional in the tool schema, but without it the
	// call fails or prompts for interactive selection. Always inject it.
	if (isADO && containerId && !additionalArgs.project) {
		additionalArgs.project = containerId;
	}

	logger.info("[Fetch PM Items By IDs] Fetching", {
		count: externalIds.length,
		tool: getTool.toolName,
		additionalArgs: Object.keys(additionalArgs),
		concurrency,
	});

	// Slot-based result reassembly: workers pull indices off a shared cursor
	// and write to `itemSlots[idx]`, so the final `items` list is in input
	// order regardless of which worker finishes first.
	const itemSlots: Array<PMWorkItemSummary | null> = new Array(
		externalIds.length,
	).fill(null);
	const failedIds: string[] = [];
	const notFoundIds: string[] = [];
	const failedIdErrors: Record<string, string> = {};

	const fetchOne = async (idx: number): Promise<void> => {
		const externalId = externalIds[idx];
		try {
			let idValue: string | number = externalId;
			if (isADO) {
				const asNum = Number(externalId);
				if (!Number.isFinite(asNum)) {
					logger.warn(
						"[Fetch PM Items By IDs] Skipping non-numeric ADO id",
						{ externalId },
					);
					failedIds.push(externalId);
					failedIdErrors[externalId] = "Non-numeric ADO work item ID";
					return;
				}
				idValue = asNum;
			}
			const getResult = await executeMcpTool({
				toolName: getTool.toolName,
				args: {
					[getTool.idParam]: idValue,
					...additionalArgs,
				},
				userId,
				organizationId,
				mcpConfigId,
				timeoutMs: callTimeoutMs,
			});

			if (!getResult.success) {
				const errorPreview = extractMcpErrorText(
					getResult.output,
				).slice(0, 300);
				// A card deleted upstream is the expected end of its life, not a
				// fault: the classifier below already treats a positive
				// not-found as proof of deletion and feeds the FLAG_MISSING
				// streak with it. Logging it at ERROR anyway put ~8,500 lines a
				// week into production for a condition nobody can act on, and
				// buried the auth and rate-limit failures that do need someone.
				const benignNotFound = isPmNotFoundError(errorPreview);
				const logFailure = benignNotFound
					? logger.info.bind(logger)
					: logger.error.bind(logger);
				logFailure("[Fetch PM Items By IDs] Tool failed for item", {
					externalId,
					tool: getTool.toolName,
					errorPreview,
					deletedUpstream: benignNotFound,
				});
				failedIds.push(externalId);
				failedIdErrors[externalId] =
					errorPreview || "Unknown MCP tool error";
				// Classify (#1360 review Fix A): only a positive not-found message
				// (404 / "does not exist") is proof of deletion and may feed the
				// FLAG_MISSING streak. Auth/rate-limit/timeout stay failedIds-only.
				if (isPmNotFoundError(errorPreview)) {
					notFoundIds.push(externalId);
				}
				return;
			}

			let data = getResult.output as Record<string, unknown>;
			if (Array.isArray(data.content)) {
				const textItem = (
					data.content as Array<{ type?: string; text?: string }>
				).find((c) => c.type === "text");
				if (textItem?.text) {
					try {
						data = JSON.parse(textItem.text);
					} catch {
						// Keep raw shape
					}
				}
			}

			// #1360 non-ADO structural not-found — content-wins three-way
			// classification. A successful response with no usable content is
			// either a high-confidence absence (→ notFoundIds + failedIds, keeping
			// the documented `notFoundIds ⊆ failedIds` invariant) or ambiguous
			// (→ failedIds). Never fabricate a phantom `Work Item N` present item.
			if (!hasUsablePmContent(data)) {
				if (isStructurallyAbsentPmResponse(data)) {
					notFoundIds.push(externalId);
					failedIds.push(externalId);
					failedIdErrors[externalId] = "structurally absent";
				} else {
					failedIds.push(externalId);
					failedIdErrors[externalId] = "ambiguous empty success";
				}
				return;
			}

			const fields = data.fields as Record<string, unknown> | undefined;
			const links = data._links as
				| { html?: { href?: string }; web?: { href?: string } }
				| undefined;

			// Jira (Rovo) nests summary/description under `fields` and returns
			// the description as ADF — without this the poll reads title as
			// undefined (→ "Work Item N") and description as null, so the
			// content-drift hash never matches and every poll flags a conflict.
			const title =
				(fields?.["System.Title"] as string | undefined) ??
				(typeof fields?.summary === "string"
					? fields.summary
					: undefined) ??
				(data.title as string | undefined) ??
				(data.name as string | undefined);
			const description =
				(fields?.["System.Description"] as string | undefined) ??
				descriptionToText(fields?.description) ??
				(data.description as string | undefined) ??
				null;
			const url =
				links?.html?.href ??
				links?.web?.href ??
				(data.url as string | undefined) ??
				null;

			itemSlots[idx] = {
				id: String(externalId),
				displayId: String(externalId),
				title: title ?? `Work Item ${externalId}`,
				description,
				url,
				workItemType: extractWorkItemType(data, fields),
				raw: data,
			};
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			logger.error("[Fetch PM Items By IDs] Exception fetching item", {
				externalId,
				tool: getTool.toolName,
				error: errMsg,
			});
			failedIds.push(externalId);
			failedIdErrors[externalId] = errMsg;
		}
	};

	// Bounded worker-pool against the single absolute deadline (DEC-7). With
	// `concurrency = 1` and no deadline this is behavior-equivalent to the
	// previous serial loop.
	const { skipped } = await runBoundedWorkerPool({
		total: externalIds.length,
		concurrency,
		deadlineAt,
		task: fetchOne,
	});
	// Ids never attempted because the deadline was hit are TRANSIENT failures —
	// never not-found (must not feed FLAG_MISSING / the outage guard).
	for (const idx of skipped) {
		const id = externalIds[idx];
		failedIds.push(id);
		failedIdErrors[id] = "poll budget exceeded (not attempted)";
	}

	const items: PMWorkItemSummary[] = itemSlots.filter(
		(slot): slot is PMWorkItemSummary => slot !== null,
	);

	logger.info("[Fetch PM Items By IDs] Done", {
		requested: externalIds.length,
		fetched: items.length,
		failed: failedIds.length,
		notFound: notFoundIds.length,
		failedIds: failedIds.length > 0 ? failedIds : undefined,
	});

	return {
		items,
		total: items.length,
		hasNextPage: false,
		failedIds,
		notFoundIds,
		failedIdErrors:
			Object.keys(failedIdErrors).length > 0 ? failedIdErrors : undefined,
	};
}

/**
 * Fetch ALL cards from a Fizzy board using the per-column strategy.
 *
 * The bulk `fizzy_get_cards` API returns only the most recent ~15 cards.
 * To get every card on a board we:
 *   1. Call `fizzy_get_columns` to discover board columns
 *   2. Call `fizzy_get_cards` for each column (with `column_id`)
 *   3. Deduplicate by card ID
 *
 * Returns `null` when required tools or context aren't available so the
 * caller can fall back to the generic `listWorkItemsFromPM` path.
 *
 * `fields: "summary"` opts into the server-side projection fizzy-mcp added for
 * list tools: the card drops `description` / `description_html` (by far the
 * bulk of the payload — a 15-card page measures ~578KB full vs ~3.8KB summary)
 * and gains a 200-char `description_preview`. Because this function fans out
 * one call PER COLUMN, a full-mode board listing is several MB — enough to
 * push the upstream Worker isolate over its memory budget, which is what
 * produced the intermittent Cloudflare 1101s (Fabric-Pro/fizzy-mcp#29).
 *
 * ONLY pass "summary" when the caller provably never reads `description`.
 * `fetch-pm-hierarchy` feeds the RAG backlog snapshot, and
 * `story-sync-workflow`'s non-selective pull writes the list-derived
 * description into the story at create time. That create-time value is
 * normally overwritten moments later by the post-create `syncStoryToPM`
 * content pull, which does re-fetch the full card — but that pull is
 * best-effort and its failure is caught and logged, so on a bad day summary
 * mode would leave a brand-new story holding whatever the listing supplied.
 * Left unset the `fields` arg is omitted entirely, so the request is
 * byte-identical to before and a fizzy-mcp deployment predating the
 * projection is unaffected.
 */
export async function listAllFizzyCards(input: {
	mcpConfigId: string | null;
	mcpServerId?: string;
	containerId: string;
	additionalContext?: Record<string, string>;
	userId: string;
	organizationId?: string;
	capabilities: PMToolCapabilities;
	fields?: "summary" | "full";
}): Promise<ListWorkItemsResult | null> {
	const {
		mcpConfigId: maybeMcpConfigId,
		containerId,
		additionalContext,
		userId,
		organizationId,
		capabilities,
		fields,
	} = input;

	// REST-GitLab is never a Fizzy-style listing target, but the input shape
	// is widened for workflow uniformity. Null mcpConfigId here means the
	// caller mis-routed; return null to surface "no fizzy result" rather than
	// crash, matching the activity's existing failure mode.
	if (maybeMcpConfigId == null) {
		logger.warn(
			"[listAllFizzyCards] mcpConfigId is null; Fizzy-style listing requires MCP",
		);
		return null;
	}
	const mcpConfigId = maybeMcpConfigId;

	// account_slug is required for all Fizzy API calls.
	// If not in additionalContext, auto-resolve from get_accounts or get_identity.
	let accountSlug =
		additionalContext?.account_slug ??
		additionalContext?.slug ??
		additionalContext?.account_id;

	if (!accountSlug) {
		logger.info(
			"[listAllFizzyCards] No account_slug in additionalContext, attempting auto-resolve",
		);

		const tryFetchAccountSlug = async (
			toolName: string,
		): Promise<string | null> => {
			try {
				const result = await executeMcpTool({
					toolName,
					args: {},
					userId,
					organizationId,
					mcpConfigId,
				});
				if (!result.success || !result.output) {
					return null;
				}
				const accounts = parseMcpArrayFromOutput(result.output);
				const first = accounts[0] as
					| Record<string, unknown>
					| undefined;
				if (!first) {
					return null;
				}
				return (
					String(
						first.slug ??
							first.account_slug ??
							first.id ??
							first.key ??
							"",
					) || null
				);
			} catch {
				return null;
			}
		};

		const accountsTool = capabilities.availableTools.find(
			(name) =>
				/fizzy_(?:get|list)_accounts?$/i.test(name) ||
				/(?:get|list)_accounts?$/i.test(name),
		);
		const identityTool = capabilities.availableTools.find((name) =>
			/fizzy_get_identity$/i.test(name),
		);

		if (accountsTool) {
			accountSlug =
				(await tryFetchAccountSlug(accountsTool)) ?? undefined;
		}
		if (!accountSlug && identityTool) {
			accountSlug =
				(await tryFetchAccountSlug(identityTool)) ?? undefined;
		}

		if (accountSlug) {
			logger.info(
				"[listAllFizzyCards] Auto-resolved account_slug from Fizzy",
				{ account_slug: accountSlug },
			);
		} else {
			logger.warn(
				"[listAllFizzyCards] Could not resolve account_slug, falling back to generic",
			);
			return null;
		}
	}

	// Locate fizzy_get_columns and fizzy_get_cards tools
	const getColumnsTool = capabilities.availableTools.find((t) =>
		/get_columns$/i.test(t),
	);
	const getCardsTool = capabilities.availableTools.find((t) =>
		/get_cards$/i.test(t),
	);

	if (!getColumnsTool || !getCardsTool) {
		logger.warn(
			"[listAllFizzyCards] Required Fizzy tools not found, falling back to generic",
			{ getColumnsTool, getCardsTool },
		);
		return null;
	}

	try {
		// Step 1: Fetch columns for the board
		const columnsResult = await executeMcpTool({
			toolName: getColumnsTool,
			args: { account_slug: accountSlug, board_id: containerId },
			userId,
			organizationId,
			mcpConfigId,
		});

		if (!columnsResult.success) {
			logger.warn(
				"[listAllFizzyCards] get_columns call failed, falling back to generic",
			);
			return null;
		}

		// Parse columns response (MCP content wrapper → array of { id, name })
		const columns = parseFizzyColumnsResponse(columnsResult.output);
		if (columns.length === 0) {
			logger.warn("[listAllFizzyCards] No columns found for board", {
				boardId: containerId,
			});
			return null;
		}

		logger.info("[listAllFizzyCards] Fetching cards per column", {
			boardId: containerId,
			columnCount: columns.length,
			columnNames: columns.map((c) => c.name),
		});

		// Step 2: Fetch cards for each column and deduplicate
		const allCards: PMWorkItemSummary[] = [];
		const seenCardIds = new Set<string>();

		for (const column of columns) {
			try {
				const cardsResult = await executeMcpTool({
					toolName: getCardsTool,
					args: {
						account_slug: accountSlug,
						column_id: column.id,
						// Omitted unless explicitly requested — see the note on
						// this function's contract. An older fizzy-mcp ignores an
						// unknown `fields` (its guard rejects only the removed
						// status/due_before/due_after filters), so the worst case
						// against a stale server is today's full payload.
						...(fields === "summary" ? { fields: "summary" } : {}),
					},
					userId,
					organizationId,
					mcpConfigId,
				});

				if (!cardsResult.success) {
					continue;
				}

				// Parse the card list from the MCP response. Stamp the card
				// `state` with the column name so the UI state filter works
				// (Fizzy cards don't carry state themselves — the column IS
				// the state).
				const cards = parseFizzyCardsResponse(cardsResult.output);
				for (const card of cards) {
					if (!seenCardIds.has(card.id)) {
						seenCardIds.add(card.id);
						allCards.push({
							...card,
							state: card.state ?? column.name,
						});
					}
				}
			} catch (error) {
				logger.warn(
					"[listAllFizzyCards] Failed to fetch cards for column",
					{
						columnId: column.id,
						columnName: column.name,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
			}
		}

		logger.info("[listAllFizzyCards] Per-column fetch complete", {
			boardId: containerId,
			totalUniqueCards: allCards.length,
			columnsQueried: columns.length,
		});

		// Derive available types + states from the full per-column result.
		// Fizzy has no adapter-provided "terminal column" signal in either the
		// capability manifest or the raw column payload (`{id, name, color}`),
		// so every Fizzy state surfaces as `isTerminal: false`. Spec §11
		// explicitly forbids name-based terminal detection; if Fizzy ever
		// exposes a column category we will surface it here. The default
		// "exclude terminals" state filter therefore selects all columns.
		const availableWorkItemTypes = Array.from(
			new Set(
				allCards
					.map((c) => c.workItemType)
					.filter((t): t is string => !!t && t.length > 0),
			),
		);
		const seenStates = new Set<string>();
		const availableStates: PMAvailableState[] = [];
		for (const col of columns) {
			if (!seenStates.has(col.name) && col.name.length > 0) {
				seenStates.add(col.name);
				availableStates.push({ name: col.name, isTerminal: false });
			}
		}

		// Bound the board listing (#1997): the whole board crosses this
		// boundary as ONE Temporal message — a full-mode listing of a large
		// board is several MB (this function's own doc note above), past the
		// gRPC frame the completion RPC is rejected and the pull stalls
		// silently (#1741 class). Degrade instead of stall — keep every
		// card's identity, shorten bodies until it fits. Known cost, accepted:
		// when the post-create full-card pull cannot run (no taskGet tool,
		// or it fails), an elided body persists as the story's content; the
		// elision marker keeps that visible and triggers the re-fetch on the
		// next createOrUpdate pass where a get tool exists.
		const boundedCards = boundedListingItems(
			allCards,
			"listAllFizzyCards result",
			{ boardId: containerId, cards: allCards.length },
		);

		return {
			items: boundedCards,
			total: allCards.length,
			hasNextPage: false,
			availableWorkItemTypes,
			availableStates,
		};
	} catch (error) {
		logger.warn(
			"[listAllFizzyCards] Per-column fetch failed, falling back to generic",
			{ error: error instanceof Error ? error.message : String(error) },
		);
		return null;
	}
}

/**
 * Parse a Fizzy columns response (MCP content wrapper → array of { id, name }).
 */
function parseFizzyColumnsResponse(
	output: unknown,
): Array<{ id: string; name: string }> {
	let data: unknown = output;

	if (data && typeof data === "object") {
		const obj = data as Record<string, unknown>;
		if (Array.isArray(obj.content)) {
			const textItem = (
				obj.content as Array<{ type?: string; text?: string }>
			).find((c) => c.type === "text");
			if (textItem?.text) {
				try {
					data = JSON.parse(textItem.text);
				} catch {
					return [];
				}
			}
		}
	}

	if (!Array.isArray(data)) {
		return [];
	}

	return data
		.filter(
			(item): item is Record<string, unknown> =>
				!!item && typeof item === "object",
		)
		.map((item) => ({
			id: String(item.id ?? ""),
			name: String(item.name ?? item.title ?? ""),
		}))
		.filter((col) => col.id.length > 0);
}

/**
 * Parse a Fizzy cards response into PMWorkItemSummary array.
 * Handles MCP content wrapper and various Fizzy field names.
 */
function parseFizzyCardsResponse(output: unknown): PMWorkItemSummary[] {
	const items: PMWorkItemSummary[] = [];
	let data: unknown = output;

	if (data && typeof data === "object") {
		const obj = data as Record<string, unknown>;
		if (Array.isArray(obj.content)) {
			const textItem = (
				obj.content as Array<{ type?: string; text?: string }>
			).find((c) => c.type === "text");
			if (textItem?.text) {
				try {
					data = JSON.parse(textItem.text);
				} catch {
					return items;
				}
			}
		}
	}

	let arr: unknown[] = [];
	if (Array.isArray(data)) {
		arr = data;
	} else if (data && typeof data === "object") {
		const d = data as Record<string, unknown>;
		arr =
			(Array.isArray(d.cards) ? d.cards : null) ??
			(Array.isArray(d.items) ? d.items : null) ??
			(Array.isArray(d.data) ? d.data : null) ??
			(Array.isArray(d.results) ? d.results : null) ??
			[];
	}

	for (const item of arr) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const rec = item as Record<string, unknown>;

		const id = String(
			rec.id ?? rec.card_number ?? rec.number ?? rec.card_id ?? "",
		);

		const title = (rec.title ?? rec.name ?? rec.summary) as
			| string
			| undefined;
		// Under `fields: "summary"` the server sends no `description` at all —
		// only a 200-char `description_preview`. That preview is deliberately
		// NOT back-filled here: a caller that opts into summary on a path which
		// persists descriptions should see them come back empty (loud) rather
		// than silently truncated to 200 chars (invisible, and permanent once
		// written to a story). `listAllFizzyCards` documents which callers may
		// opt in.
		const description = (rec.description ?? rec.body ?? rec.content) as
			| string
			| null
			| undefined;
		const url = (rec.url ?? rec.webUrl ?? rec.link ?? rec.html_url) as
			| string
			| null
			| undefined;

		// Extract user-friendly display ID (strip leading "#")
		const rawDisplayId = rec.card_number ?? rec.number ?? rec.key;
		const displayId =
			rawDisplayId != null
				? String(rawDisplayId).replace(/^#/, "").trim() || undefined
				: undefined;

		if (id) {
			// Fizzy cards rarely carry an explicit work-item type, but honor
			// `type` / `card_type` when present so downstream filtering works.
			const rawType = rec.type ?? rec.card_type ?? rec.workItemType;
			const workItemType =
				typeof rawType === "string" && rawType.length > 0
					? rawType
					: undefined;

			items.push({
				id,
				displayId: displayId !== id ? displayId : undefined,
				title: title ?? `Card ${id}`,
				description: description ?? null,
				url: url ?? null,
				workItemType,
				raw: rec,
			});
		}
	}

	return items;
}

/**
 * Create or update a Fabric story from a PM work item.
 * For pull: create if no match by externalId, else update.
 */
export async function createOrUpdateStoryFromPMItem(input: {
	projectId: string;
	externalId: string;
	title: string;
	description?: string | null;
	externalUrl?: string | null;
	userId: string;
	mcpConfigId: string | null;
	mcpServerId?: string;
	containerId: string;
	additionalContext?: Record<string, string>;
	organizationId?: string;
	capabilities?: PMToolCapabilities;
	workItemType?: string | null;
	// Whether PM work-item-type → StoryKind reverse-mapping is on. Resolved from
	// `FEATURE_PM_TYPE_MAPPING` in the runtime that OWNS the flag (the API /
	// workflow start sites) and threaded in, so the mapping no longer silently
	// depends on the Temporal worker's own `process.env`. Falls back to this
	// activity's `process.env` only when the caller leaves it unset (#1305).
	enableTypeMapping?: boolean;
}): Promise<{
	storyId: string;
	identifier: string;
	created: boolean;
	externalId: string;
	externalUrl?: string;
}> {
	const {
		projectId,
		externalId,
		title,
		description,
		externalUrl,
		userId,
		mcpConfigId,
		containerId,
		additionalContext,
		organizationId,
		capabilities: preCapabilities,
		workItemType,
		enableTypeMapping,
	} = input;

	// Honour the caller's threaded flag; only fall back to the worker's own env
	// when the caller left it unset (keeps older call sites behaving as before).
	const typeMappingEnabled =
		enableTypeMapping ?? process.env.FEATURE_PM_TYPE_MAPPING === "true";

	// Resolve mcpServerId: prefer explicit input, else look up from config.
	// On the REST-GitLab path mcpConfigId is null — mcpServerId MUST come
	// from input; we can't look it up.
	let mcpServerId = input.mcpServerId;
	if (!mcpServerId && mcpConfigId != null) {
		const cfg = await getMcpConfigById(mcpConfigId, {
			userId,
			organizationId,
		});
		mcpServerId = cfg?.mcpServerId ?? undefined;
	}

	// Record the inbound import as a "pull" so it shows in the Sync History tab.
	// The existing-story taskGet branch below already logs via
	// `syncStoryToPM(direction:"pull")`; this closure covers the gaps that wrote
	// nothing — the no-taskGet/REST update and the new-story create.
	// `recordPmSyncLog` is non-fatal (swallows its own write errors).
	const logImportPull = (args: {
		storyId: string;
		storyTitle: string;
		pmTool: string;
		pmExternalUrl: string | null;
	}): Promise<void> =>
		recordPmSyncLog({
			direction: "pull",
			entityType: "STORY",
			entityId: args.storyId,
			title: args.storyTitle,
			pmTool: args.pmTool,
			status: "SUCCESS",
			actorUserId: userId,
			externalId,
			externalUrl: args.pmExternalUrl,
			...(organizationId
				? { organizationId, userId: null }
				: { organizationId: null, userId }),
			projectId,
		});

	// Check if we already have this story
	const existing = await db.userStory.findFirst({
		where: { projectId, externalId },
		select: { id: true, identifier: true, kind: true },
	});

	if (existing) {
		// Update from PM (fetch full details if we have get tool)
		const capabilities =
			preCapabilities ??
			(await discoverPMToolCapabilities({
				mcpConfigId,
				userId,
				organizationId,
			}));

		let freshUrl = externalUrl;
		// Gate the syncStoryToPM call on mcpConfigId != null: that helper has an
		// explicit non-retryable guard for REST-GitLab (mcpConfigId === null) and
		// throws "REST-GitLab path is not yet supported". On the REST path the
		// title/description supplied here already come from getGitLabIssueForPM
		// (via the workflow's fetchPMItemsByIds activity), so we can fall through
		// to the lightweight updateStory branch — no need to re-fetch via MCP.
		if (capabilities?.taskGet && mcpConfigId != null) {
			const result = await syncStoryToPM({
				storyId: existing.id,
				projectId,
				mcpConfigId,
				containerId,
				additionalContext,
				direction: "pull",
				userId,
				organizationId,
				capabilities,
			});
			if (result.externalUrl) {
				freshUrl = result.externalUrl;
				await updateStory(existing.id, projectId, {
					externalUrl: result.externalUrl,
				});
			}
		} else {
			// No get tool - just update title/description if we have them.
			// Symmetric inverse of the Fizzy push pipeline: convert HTML
			// body → markdown body via simpleHtmlToMarkdown, then
			// normalizeBackLinkFromProvider restores the canonical HTML
			// back-link anchor. For every other provider the description
			// is forwarded verbatim. See the main syncStoryToPM pull path
			// for the full rationale.
			const isFizzy =
				(capabilities?.detectedType ?? "").toLowerCase() === "fizzy";
			const markdownDesc =
				isFizzy && description
					? simpleHtmlToMarkdown(description)
					: cleanAdoCodeBlocks(
							description,
							capabilities?.detectedType,
						);
			// Skip normalize for missing/null/empty so we never accidentally
			// write the empty-anchor result back to DB.
			const finalDesc = markdownDesc
				? normalizeBackLinkFromProvider(
						markdownDesc,
						capabilities?.detectedType,
					)
				: undefined;
			await updateStory(existing.id, projectId, {
				title,
				description: finalDesc ?? undefined,
				externalUrl: externalUrl ?? undefined,
			});
			// No-taskGet / REST update path logs nothing on its own — record it.
			await logImportPull({
				storyId: existing.id,
				storyTitle: title,
				pmTool: capabilities?.detectedType ?? "unknown",
				pmExternalUrl: externalUrl ?? null,
			});
		}

		// flag-on drift log: warn when pulled type disagrees with stored kind
		if (typeMappingEnabled && workItemType) {
			const resolvedKind = resolveKindFromPmType(
				workItemType,
				parseWorkItemTypeMapping(
					additionalContext as Record<string, unknown> | null,
				),
			);
			if (resolvedKind !== existing.kind) {
				logger.warn(
					"[PM Sync] Pulled item type disagrees with stored kind (no reclassify)",
					{
						storyId: existing.id,
						storedKind: existing.kind,
						workItemType,
						resolvedKind,
					},
				);
			}
		}

		return {
			storyId: existing.id,
			identifier: existing.identifier,
			created: false,
			externalId,
			externalUrl: freshUrl ?? undefined,
		};
	}

	// For new stories: fetch full details from get tool if we have minimal info
	let finalTitle = title;
	let finalDescription = description;
	let finalUrl = externalUrl;

	// Resolve capabilities the same way the existing-story branch does. We need
	// detectedType to set UserStory.source correctly — without it, every
	// PM-tool-synced new story would silently fall back to MANUAL.
	const caps =
		preCapabilities ??
		(await discoverPMToolCapabilities({
			mcpConfigId,
			userId,
			organizationId,
		}));
	// Custom field read-mapping context. Loaded for ADO only so
	// other providers add no DB read. Drives replace-mode on first-time creation
	// via the forced re-fetch below (option a); it also engages on every
	// existing-story pull-update through syncStoryToPM → parsePMItemFromGetOutput.
	const fieldMappingCtx =
		caps?.detectedType === "azure-devops"
			? await loadProjectFieldMappingContext(projectId)
			: { enabled: false, config: null };
	// Custom field read-mapping: when replace-mode is
	// ACTIVE (ADO + config + non-empty fields + provider match + flag on), a
	// brand-new story imported for the first time must get the aggregated
	// custom-field body immediately — not only on the next sync. The list/fetch
	// path (~L6512) parses only `System.Description`, and the default re-fetch
	// guard (`!title || synthetic`) skips the full get for a real-titled ADO
	// story, so replace-mode would otherwise never engage on first creation.
	// Forcing the re-fetch routes the body through `parsePMItemFromGetOutput`
	// with the fieldMapping options. Inactive (flag off / no config / non-ADO /
	// mismatch) → `engaged: false` → no extra fetch, zero cost, unchanged path.
	const replaceModeActive = evaluateReplaceModeActivation({
		connectedProvider: caps?.detectedType,
		config: fieldMappingCtx.config,
		enabled: fieldMappingCtx.enabled,
	}).engaged;
	// Fetch full details from get tool when title is missing/synthetic, OR when
	// replace-mode is active (to compose the configured-field body on create).
	// Description handling mirrors the syncStoryToPM pull path: for Fizzy
	// we receive HTML from the source, run simpleHtmlToMarkdown to bring
	// it back to Fabric's canonical markdown form (which preserves heading
	// levels, list items, and bold so the next push reproduces the same
	// HTML bytes). For every other provider the description is forwarded
	// verbatim — Tiptap handles HTML pulled from Jira/GitHub/GitLab/ADO,
	// and the always-HTML back-link anchor that createStory adds later
	// sits cleanly alongside whatever format the source returned.
	if (
		caps?.taskGet &&
		(!title ||
			title.startsWith("Work Item ") ||
			replaceModeActive ||
			// An elided listing body must not be persisted as canonical
			// content — pull the full card when we can (#1997).
			description?.includes(ELISION_MARKER.trim()) === true)
	) {
		try {
			const getTool = caps.taskGet;
			const getResult = await executeMcpTool({
				toolName: getTool.toolName,
				args: (() => {
					const args: Record<string, unknown> = {
						[getTool.idParam]: externalId,
					};
					for (const param of getTool.additionalRequiredParams) {
						if (
							param.includes("board") ||
							param.includes("container") ||
							param === "project"
						) {
							args[param] = containerId;
						} else if (additionalContext?.[param]) {
							args[param] = additionalContext[param];
						}
					}
					return args;
				})(),
				userId,
				organizationId,
				mcpConfigId: mcpConfigId ?? undefined,
			});
			if (getResult.success) {
				const parsed = parsePMItemFromGetOutput(getResult.output, {
					fieldMapping: {
						connectedProvider: caps?.detectedType,
						config: fieldMappingCtx.config,
						enabled: fieldMappingCtx.enabled,
					},
				});
				if (parsed.title) {
					finalTitle = parsed.title;
				}
				if (parsed.description !== undefined) {
					const isFizzy =
						(caps?.detectedType ?? "").toLowerCase() === "fizzy";
					const markdownDesc =
						isFizzy && parsed.description
							? simpleHtmlToMarkdown(parsed.description)
							: cleanAdoCodeBlocks(
									parsed.description,
									caps?.detectedType,
								);
					// Re-emit the canonical HTML back-link anchor so the new
					// story row matches Fabric's DB invariant (createStory
					// would otherwise call appendFabricBackLink which is a
					// no-op if a markdown `[View in Fabric]` is already
					// present — leaving the row in a non-canonical form).
					finalDescription = markdownDesc
						? normalizeBackLinkFromProvider(
								markdownDesc,
								caps?.detectedType,
							)
						: markdownDesc;
				} else if (replaceModeActive) {
					// Replace-mode engaged but every configured field is blank →
					// don't clobber: leave the body empty rather than leaking the
					// list-path `System.Description` (the legacy chain replace-mode
					// replaces). Matches the pull-update `description: undefined`
					// semantics so a real-titled first import stays consistent.
					finalDescription = undefined;
				}
				if (parsed.externalUrl) {
					finalUrl = parsed.externalUrl;
				}
			}
		} catch {
			// Keep minimal info on failure
		}
	}

	// Resolve kind from PM work-item type (flag-gated, typeless items preserved as default FEATURE)
	const importedKind =
		typeMappingEnabled && workItemType
			? resolveKindFromPmType(
					workItemType,
					parseWorkItemTypeMapping(
						additionalContext as Record<string, unknown> | null,
					),
				)
			: undefined;

	// Create new story
	const story = await createStory({
		projectId,
		title: finalTitle,
		description: finalDescription ?? undefined,
		createdById: userId,
		source: pmDetectedTypeToStorySource(caps?.detectedType),
		...(importedKind ? { kind: importedKind as StoryKind } : {}),
	});

	// Stories created from an inbound PM item are PM-linked at birth, so they
	// opt into auto-sync immediately — matching the import-from-pm path and
	// keeping observable behavior unchanged from the pre-toggle world. Fabric-
	// only create paths leave the column at its `false` default.
	await db.userStory.update({
		where: { id: story.id },
		data: {
			externalId,
			externalUrl: finalUrl ?? undefined,
			externalMcpServerId: mcpServerId ?? undefined,
			pmAutoSyncEnabled: true,
		},
	});

	// Bulk pull ("Pull from PM") creates the story straight from the list
	// payload — which has no re-hosted media and, depending on the provider, an
	// incomplete body or no file attachments at all:
	//   - Fizzy collapses attachments to `[filename]` placeholders and the rich
	//     `description_html` only comes from a single-card GET.
	//   - ADO keeps inline images as raw `_apis/wit/attachments/…` URLs (which
	//     need a PAT to fetch) and its FILE attachments live in work-item
	//     *relations*, never in `System.Description` (ADO WI #224).
	// Re-run the pull through syncStoryToPM — the SAME path the existing-story
	// branch above and the re-sync use — so it re-fetches the item, converts the
	// body, INGESTS inline images onto Fabric story-media, and (ADO) fetches +
	// appends the AttachedFile relations. Without this a freshly bulk-pulled
	// story shows un-ingested/raw media and missing file attachments.
	//
	// Gated exactly like the existing-story branch above (an MCP get tool + a
	// non-null mcpConfig). REST-only providers (e.g. REST-GitLab, mcpConfigId
	// null) keep the lighter create path — they have their own fetch upstream.
	let didContentPull = false;
	if (caps?.taskGet && mcpConfigId != null) {
		try {
			await syncStoryToPM({
				storyId: story.id,
				projectId,
				mcpConfigId,
				containerId,
				additionalContext,
				direction: "pull",
				userId,
				organizationId,
				capabilities: caps,
			});
			didContentPull = true;

			// The pull above OVERWRITES the description with the PM-tool body,
			// which on a first sync has no "View in Fabric" anchor yet — so the
			// back-link that createStory stamped is gone. Re-stamp it (idempotent
			// — no-op if already present) so it (a) renders in Fabric and (b)
			// rides along on the back-link push-back below to the PM card.
			try {
				const fabricUrl = await buildFabricStoryUrl({
					projectId,
					storyId: story.id,
					organizationId,
				});
				const pulled = await db.userStory.findUnique({
					where: { id: story.id },
					select: { description: true },
				});
				const withBackLink = appendFabricBackLink(
					pulled?.description,
					fabricUrl,
				);
				if (withBackLink !== (pulled?.description ?? "")) {
					await updateStory(story.id, projectId, {
						description: withBackLink,
					});
				}
			} catch (backLinkErr) {
				logger.warn(
					"[createOrUpdateStoryFromPMItem] post-pull back-link re-stamp failed",
					{ error: backLinkErr, storyId: story.id, externalId },
				);
			}
		} catch (pullErr) {
			logger.warn(
				"[createOrUpdateStoryFromPMItem] post-create content pull failed",
				{ error: pullErr, storyId: story.id, externalId },
			);
		}
	} else if (mcpConfigId == null && !!mcpServerId) {
		// REST-GitLab import (mcpConfigId === null): the bulk-pull list payload is
		// a RAW GitLab body (raw `/uploads/…` links + literal `{width=…}`), so the
		// create path must ALSO run the content pull — previously skipped (the
		// comment above wrongly assumed a media-aware upstream fetch). syncStoryToPM
		// requires `mcpServerId` on this path, so call the REST entry directly via
		// a dynamic import (same circular-dependency avoidance syncStoryToPM uses
		// for its own REST dispatch). It strips `{width=…}` and ingests inline
		// images AND file attachments onto Fabric story-media. Without this a
		// freshly imported GitLab story shows raw media + literal `{width=…}`.
		try {
			const { syncGitLabStoryViaRest } = await import(
				"./gitlab-rest-story-sync"
			);
			await syncGitLabStoryViaRest({
				storyId: story.id,
				projectId,
				mcpConfigId: null,
				mcpServerId,
				containerId,
				additionalContext,
				direction: "pull",
				userId,
				organizationId,
			});
			didContentPull = true;

			// The pull OVERWRITES the description with the GitLab body (no
			// "View in Fabric" anchor on a fresh import) — re-stamp it (idempotent),
			// mirroring the MCP branch above.
			try {
				const fabricUrl = await buildFabricStoryUrl({
					projectId,
					storyId: story.id,
					organizationId,
				});
				const pulled = await db.userStory.findUnique({
					where: { id: story.id },
					select: { description: true },
				});
				const withBackLink = appendFabricBackLink(
					pulled?.description,
					fabricUrl,
				);
				if (withBackLink !== (pulled?.description ?? "")) {
					await updateStory(story.id, projectId, {
						description: withBackLink,
					});
				}
			} catch (backLinkErr) {
				logger.warn(
					"[createOrUpdateStoryFromPMItem] post-pull back-link re-stamp failed (GitLab REST)",
					{ error: backLinkErr, storyId: story.id, externalId },
				);
			}
		} catch (pullErr) {
			logger.warn(
				"[createOrUpdateStoryFromPMItem] post-create GitLab REST content pull failed",
				{ error: pullErr, storyId: story.id, externalId },
			);
		}
	}

	// Record the inbound creation as a "pull". The back-link push below logs a
	// separate "push" row, so a fresh import shows a pull→push pair (intended).
	// When the Fizzy content pull above ran, syncStoryToPM(pull) already wrote
	// its own "pull" sync-log row — skip this one to avoid a duplicate.
	if (!didContentPull) {
		await logImportPull({
			storyId: story.id,
			storyTitle: finalTitle,
			pmTool: caps?.detectedType ?? "unknown",
			pmExternalUrl: finalUrl ?? null,
		});
	}

	// Push the freshly-created Fabric story back to the PM tool so the
	// source PM ticket's description picks up the "View in Fabric" link
	// that createStory persisted on the Fabric side. Best-effort — if
	// this fails the import still succeeded.
	if (caps?.taskUpdate) {
		try {
			await syncStoryToPM({
				storyId: story.id,
				projectId,
				mcpConfigId,
				containerId,
				additionalContext,
				direction: "push",
				userId,
				organizationId,
				capabilities: caps,
			});
		} catch (pushBackError) {
			logger.warn(
				"[createOrUpdateStoryFromPMItem] Back-link push-back failed",
				{ error: pushBackError, storyId: story.id, externalId },
			);
		}
	}

	return {
		storyId: story.id,
		identifier: story.identifier,
		created: true,
		externalId,
		externalUrl: finalUrl ?? undefined,
	};
}

/**
 * Sync multiple stories to the PM tool
 */
export async function syncBulkStoriesToPM(
	input: BulkStorySyncInput,
): Promise<BulkStorySyncResult> {
	const {
		projectId,
		mcpConfigId,
		containerId,
		additionalContext,
		filter,
		userId,
		organizationId,
	} = input;

	const results: BulkStorySyncResult["results"] = [];
	let syncedCount = 0;
	let failedCount = 0;

	try {
		// Build query based on filters
		const where: {
			projectId: string;
			statusId?: { in: string[] };
			externalId?: null;
		} = { projectId };

		if (filter?.statusIds && filter.statusIds.length > 0) {
			where.statusId = { in: filter.statusIds };
		}
		if (filter?.unsyncedOnly) {
			where.externalId = null;
		}

		// Fetch stories
		const stories = await db.userStory.findMany({
			where,
			orderBy: { order: "asc" },
			select: {
				id: true,
				identifier: true,
			},
		});

		logger.info("[Bulk Story Sync] Starting", {
			projectId,
			storyCount: stories.length,
			filter,
		});

		// Discover capabilities once for all stories
		// CRITICAL: Pass organizationId for proper tenant isolation
		const capabilities = await discoverPMToolCapabilities({
			mcpConfigId,
			userId,
			organizationId,
		});
		if (!capabilities || !capabilities.hasPMCapabilities) {
			throw ApplicationFailure.nonRetryable(
				"PM tool does not have required capabilities",
			);
		}

		logger.info("[Bulk Story Sync] Using capabilities", {
			detectedType: capabilities.detectedType,
			createTool: capabilities.taskCreation?.toolName,
		});

		// Sync each story with pre-discovered capabilities
		for (const story of stories) {
			const result = await syncStoryToPM({
				storyId: story.id,
				projectId,
				mcpConfigId,
				containerId,
				additionalContext,
				direction: "push",
				userId,
				organizationId,
				capabilities, // Pass pre-discovered capabilities
			});

			results.push({
				storyId: story.id,
				identifier: story.identifier,
				success: result.success,
				externalId: result.externalId,
				error: result.error,
			});

			if (result.success) {
				syncedCount++;
			} else {
				failedCount++;
			}
		}

		logger.info("[Bulk Story Sync] Completed", {
			projectId,
			totalStories: stories.length,
			syncedCount,
			failedCount,
		});

		return {
			success: failedCount === 0,
			totalStories: stories.length,
			syncedCount,
			failedCount,
			results,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		logger.error("[Bulk Story Sync] Failed", {
			projectId,
			error: errorMessage,
		});
		return {
			success: false,
			totalStories: 0,
			syncedCount,
			failedCount: failedCount + 1,
			results,
		};
	}
}

/**
 * Sync a single task to the PM tool
 */
export async function syncTaskToPM(params: {
	taskId: string;
	storyId: string;
	projectId: string;
	mcpConfigId: string;
	containerId: string;
	parentExternalId?: string;
	additionalContext?: Record<string, string>;
	userId: string;
	/** Organization ID for tenant isolation - use project's orgId, not session's */
	organizationId?: string;
}): Promise<{
	success: boolean;
	externalId?: string;
	error?: string;
}> {
	const {
		taskId,
		storyId,
		projectId,
		mcpConfigId,
		containerId,
		parentExternalId,
		additionalContext,
		userId,
		organizationId,
	} = params;

	// Tenant XOR for the owning-STORY log row (a synced PM "task" is never a
	// Fabric `StoryTask` in the log — it always logs as its owning STORY,
	// never `TASK`).
	const logTenant = {
		organizationId: organizationId ?? null,
		userId: organizationId ? null : userId,
	} as const;

	// Function-scoped so the catch-path FAILURE log can name the real tool (the
	// in-`try` `capabilities` const is out of scope there).
	let detectedPmTool = "unknown";

	try {
		// Discover PM tool capabilities
		// CRITICAL: Pass organizationId for proper tenant isolation
		const capabilities = await discoverPMToolCapabilities({
			mcpConfigId,
			userId,
			organizationId,
		});
		if (!capabilities || !capabilities.taskCreation) {
			throw ApplicationFailure.nonRetryable(
				"PM tool does not support task creation",
			);
		}
		detectedPmTool = capabilities.detectedType ?? "unknown";

		// Fetch the task
		const task = await db.storyTask.findUnique({
			where: { id: taskId },
			include: { story: true },
		});

		if (!task) {
			throw ApplicationFailure.nonRetryable(`Task ${taskId} not found`);
		}

		// Build create args using discovered tool
		const createTool = capabilities.taskCreation;
		const title = truncateTitleForProvider(
			task.title,
			capabilities.detectedType,
		);
		const description = task.description || "";

		const createArgs: Record<string, unknown> = {
			[createTool.containerParam]: containerId,
			[createTool.titleParam]: title,
		};

		if (createTool.descriptionParam) {
			createArgs[createTool.descriptionParam] = description;
		}

		// Add additional context if tool supports them
		if (additionalContext) {
			for (const [key, value] of Object.entries(additionalContext)) {
				if (createTool.allParams.some((p) => p.name === key)) {
					createArgs[key] = value;
				}
			}
		}

		// Add parent reference if supported
		if (parentExternalId) {
			const parentParams = [
				"parent_id",
				"parent_card_id",
				"parent_issue_id",
			];
			for (const param of parentParams) {
				if (createTool.allParams.some((p) => p.name === param)) {
					createArgs[param] = parentExternalId;
					break;
				}
			}
		}

		const createResult = await executeMcpTool({
			toolName: createTool.toolName,
			args: createArgs,
			userId,
			organizationId,
			// Read-only mode write-gate keys off projectId
			projectId,
			mcpConfigId,
		});

		if (createResult.success) {
			// DYNAMIC: Use update tool's idParam to know which ID field to extract
			// This adapts to any PM tool's ID convention via MCP schema discovery
			const { externalId } = extractExternalInfo(createResult.output, {
				idParamHint: capabilities.taskUpdate?.idParam,
			});

			// ATOMICITY GUARD: a successful MCP create with no extractable
			// externalId means the task was created in the PM tool but Fabric
			// could not link it back. Return `{success:false}` (NOT throw) so
			// the caller's task-loop can continue with subsequent tasks while
			// still surfacing the failure honestly. Without this, the task is
			// orphaned in the PM tool and the next sync would re-enter the
			// CREATE branch and produce a duplicate. Mirrors the equivalent
			// guards in `syncStoryToPM` (throws because callers don't loop) and
			// `syncWorkItemToPM` (returns `{status:"FAILED"}`).
			if (!externalId) {
				const errorMessage = `PM tool accepted the create but did not return a task id. The task may exist in the PM tool unlinked. Re-save the project's PM settings and try again. (tool=${createTool.toolName})`;
				logger.error(
					"[Task Sync] Create succeeded but no external id extracted",
					{
						taskId,
						identifier: task.identifier,
						tool: createTool.toolName,
					},
				);
				// Record FAILURE against the owning STORY (same pattern as the
				// catch path further down). Non-fatal log — never blocks return.
				await recordPmSyncLog({
					direction: "push",
					entityType: "STORY",
					entityId: storyId,
					title: task.story.title,
					pmTool: capabilities.detectedType ?? "unknown",
					status: "FAILURE",
					errorPayload: {
						errorMessage,
						phase: "task-sync-orphan",
						taskId,
					},
					actorUserId: userId,
					externalId: task.story.externalId ?? null,
					externalUrl: task.story.externalUrl ?? null,
					...logTenant,
					projectId,
				});
				return { success: false, error: errorMessage };
			}

			await updateTask(taskId, { externalId });

			logger.info("[Task Sync] Synced task", {
				taskId,
				identifier: task.identifier,
				externalId,
				tool: createTool.toolName,
			});

			// Log against the OWNING story (never `TASK`). Snapshot the story's
			// external refs, not the just-created task's id.
			await recordPmSyncLog({
				direction: "push",
				entityType: "STORY",
				entityId: storyId,
				title: task.story.title,
				pmTool: capabilities.detectedType ?? "unknown",
				status: "SUCCESS",
				actorUserId: userId,
				externalId: task.story.externalId ?? null,
				externalUrl: task.story.externalUrl ?? null,
				...logTenant,
				projectId,
			});

			return { success: true, externalId };
		}

		throw new Error("Failed to create task in PM tool");
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		logger.error("[Task Sync] Failed", { taskId, error: errorMessage });

		// FAILURE row against the owning STORY. Snapshot the story directly
		// (the task fetch may not have happened if discovery threw). NON-FATAL
		// + guarded so a snapshot read failure can't break the catch path.
		try {
			const ownerStory = await getStoryById(storyId, projectId);
			if (ownerStory) {
				await recordPmSyncLog({
					direction: "push",
					entityType: "STORY",
					entityId: storyId,
					title: ownerStory.title,
					pmTool: detectedPmTool,
					status: "FAILURE",
					errorPayload: {
						errorMessage: errorMessage.slice(0, 500),
						phase: "task-sync-threw",
						taskId,
					},
					actorUserId: userId,
					externalId: ownerStory.externalId ?? null,
					externalUrl: ownerStory.externalUrl ?? null,
					...logTenant,
					projectId,
				});
			}
		} catch (logError) {
			logger.warn("[Task Sync] FAILURE log snapshot failed", {
				taskId,
				error:
					logError instanceof Error
						? logError.message
						: String(logError),
			});
		}

		return { success: false, error: errorMessage };
	}
}

// =============================================================================
// Workflow Support Activities
// =============================================================================

/**
 * Get stories to sync for the workflow
 */
export async function getStoriesToSync(input: {
	projectId: string;
	organizationId?: string;
	storyIds?: string[];
	statusIds?: string[];
	unsyncedOnly?: boolean;
	direction?: "push" | "pull";
}): Promise<
	Array<{
		id: string;
		identifier: string;
		title: string;
		description?: string | null;
		acceptanceCriteria?: string | null;
		releaseNotes?: string | null;
		priority?: string;
		size?: string | null;
		storyPoints?: number | null;
		labels?: string[];
		externalId?: string | null;
		externalUrl?: string | null;
		kind?: string | null;
	}>
> {
	const where: {
		projectId: string;
		project?: { organizationId: string };
		id?: { in: string[] };
		statusId?: { in: string[] };
		externalId?: null | { not: null };
	} = {
		projectId: input.projectId,
		...(input.organizationId !== undefined
			? { project: { organizationId: input.organizationId } }
			: {}),
	};

	if (input.storyIds && input.storyIds.length > 0) {
		where.id = { in: input.storyIds };
	}
	if (input.statusIds && input.statusIds.length > 0) {
		where.statusId = { in: input.statusIds };
	}
	if (input.direction === "pull") {
		// Pull: only stories that have been pushed (have externalId)
		where.externalId = { not: null };
	} else if (input.unsyncedOnly) {
		// Push: only stories not yet synced
		where.externalId = null;
	}

	const stories = await db.userStory.findMany({
		where,
		orderBy: { order: "asc" },
		select: {
			id: true,
			identifier: true,
			title: true,
			description: true,
			acceptanceCriteria: true,
			releaseNotes: true,
			priority: true,
			size: true,
			storyPoints: true,
			labels: true,
			externalId: true,
			externalUrl: true,
			kind: true,
		},
	});

	// Fail fast past the Temporal frame (#1997): every story's full body is
	// about to cross this boundary, and an oversized return otherwise dies at
	// activity-completion with a core-layer rejection after burning all
	// retries (#1741 class). A named error here points at the actual culprit.
	const serializedBytes = assertPayloadWithinLimit(
		stories,
		"getStoriesToSync result",
	);
	logger.info("[Story Sync] Stories fetched for sync", {
		projectId: input.projectId,
		direction: input.direction ?? "push",
		count: stories.length,
		serializedBytes,
	});

	return stories;
}

/**
 * Update story with external references
 */
export async function updateStoryExternalRefs(input: {
	storyId: string;
	projectId: string;
	externalId: string;
	externalUrl?: string;
}): Promise<void> {
	await updateStory(input.storyId, input.projectId, {
		externalId: input.externalId,
		externalUrl: input.externalUrl,
	});
}

/**
 * Delete Fabric stories that no longer exist in the PM tool.
 * Called after pull sync: removes stories whose externalId is not in the PM item list.
 * Handles ID format variations (e.g. Fizzy "#123" vs "123").
 */
export async function deleteStoriesNotInPMList(input: {
	projectId: string;
	organizationId?: string;
	pmExternalIds: string[];
}): Promise<{ deletedCount: number; deletedIdentifiers: string[] }> {
	const { projectId, organizationId, pmExternalIds } = input;

	// Build set of normalized PM IDs for flexible matching
	// (Fizzy may return "#123" or "123"; we store whichever the create response gave us)
	const pmIdSet = new Set<string>();
	for (const id of pmExternalIds) {
		if (id) {
			pmIdSet.add(id.trim());
			const normalized = id.replace(/^#/, "").trim();
			if (normalized !== id) {
				pmIdSet.add(normalized);
			}
		}
	}

	const syncedStories = await db.userStory.findMany({
		where: {
			projectId,
			externalId: { not: null },
			...(organizationId !== undefined
				? { project: { organizationId } }
				: {}),
		},
		select: { id: true, identifier: true, externalId: true },
	});

	const toDelete: { id: string; identifier: string }[] = [];
	for (const story of syncedStories) {
		const extId = story.externalId?.trim();
		if (!extId) {
			continue;
		}
		const inPm = pmIdSet.has(extId) || pmIdSet.has(extId.replace(/^#/, ""));
		if (!inPm) {
			toDelete.push({ id: story.id, identifier: story.identifier });
		}
	}

	const deletedIdentifiers: string[] = [];
	const orphanedKeys: string[] = [];
	for (const { id, identifier } of toDelete) {
		try {
			// Capture attachment object keys BEFORE the cascade removes the rows.
			const attachments = await db.storyAttachment.findMany({
				where: { storyId: id },
				select: { storageKey: true },
			});
			await deleteStory(id, projectId);
			deletedIdentifiers.push(identifier);
			orphanedKeys.push(...attachments.map((a) => a.storageKey));
		} catch (e) {
			logger.warn("[Delete Orphaned] Failed to delete story", {
				storyId: id,
				identifier,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	// Best-effort reclaim the deleted stories' attachment objects (the FK cascade
	// removed StoryAttachment rows, not the underlying R2 objects). The DB delete
	// is the source of truth — object-store failures are logged, never thrown.
	if (orphanedKeys.length > 0) {
		const { errors } = await deleteObjects(orphanedKeys, {
			bucket: config.storage.bucketNames.projectContexts,
		});
		if (errors.length > 0) {
			logger.warn(
				`[attachments] orphaned ${errors.length} object(s) after PM-sync prune (project ${projectId})`,
				{ sample: errors.slice(0, 20) },
			);
		}
	}

	if (deletedIdentifiers.length > 0) {
		logger.info("[Delete Orphaned] Removed stories not in PM", {
			projectId,
			deletedCount: deletedIdentifiers.length,
			identifiers: deletedIdentifiers,
		});
	}

	return { deletedCount: deletedIdentifiers.length, deletedIdentifiers };
}
