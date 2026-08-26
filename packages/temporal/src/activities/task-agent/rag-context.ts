/**
 * RAG Context Retrieval
 *
 * Retrieves relevant project contexts from Qdrant for tasks.
 *
 * Also hosts `gatherLiveUrlSources` — the retrieval-time companion for URL
 * Context Sources. It runs in
 * parallel with the Qdrant search at AI-analysis time and contributes a
 * separate "Live URL content" block to the prompt without ever persisting
 * into Qdrant. Mounted here (rather than `@repo/rag`) to avoid a circular
 * dependency: `@repo/rag` is consumed by `@repo/temporal`, and the helper
 * needs the Firecrawl client that already lives under temporal activities.
 */

import {
	embed,
	getAIEmbeddingModelWithMetadata,
	logEmbeddingUsageAsync,
} from "@repo/ai";
import { db, getSearchProviderConfig, type Prisma } from "@repo/database";
import {
	contextMetaHeader,
	extractBaseContextId,
	searchSimilarProjectContexts,
} from "@repo/rag";
import { decryptApiKey } from "@repo/utils";
import { scrapeUrl } from "../lib/firecrawl-client";
import type { RetrieveProjectContextsInput } from "./types";

/**
 * Retrieve relevant project contexts from Qdrant for the task
 * Similar to document generation RAG retrieval
 */
export async function retrieveProjectContexts(
	input: RetrieveProjectContextsInput,
): Promise<string[]> {
	const {
		projectId,
		userId,
		organizationId,
		taskTitle,
		taskDescription,
		limit = 5,
	} = input;

	try {
		// Use centralized single entry point for embedding model access
		const {
			model: embeddingModel,
			metadata,
			trackUsage,
		} = await getAIEmbeddingModelWithMetadata({ userId, organizationId });

		// Track usage (fire-and-forget)
		trackUsage();

		// Generate embedding for the task query
		const queryText = `Task: ${taskTitle}\n${taskDescription}`;
		const embeddingStart = Date.now();
		const { embedding: queryEmbedding, usage } = await embed({
			model: embeddingModel,
			value: queryText,
		});
		logEmbeddingUsageAsync({
			context: { userId, organizationId },
			metadata,
			usageTokens: usage.tokens,
			latencyMs: Date.now() - embeddingStart,
		});

		// Search for relevant contexts using RAG
		const results = await searchSimilarProjectContexts({
			projectId,
			userId,
			organizationId,
			queryEmbedding,
			topK: limit,
			minSimilarity: 0.5,
		});

		// Fetch actual content from database using contextIds
		// Note: Qdrant stores chunk IDs like "contextId-chunk-0" but DB has original "contextId"
		// Uses extractBaseContextId from @repo/rag to strip chunk suffix
		const rawContextIds = results.map((r) => r.contextId);
		const contextIds = [
			...new Set(rawContextIds.map(extractBaseContextId)),
		];
		if (contextIds.length === 0) {
			return [];
		}

		// SECURITY: Validate project ownership when fetching contexts
		// Defense-in-depth: Qdrant already filtered by projectId, but we validate at DB level too
		const contexts = await db.projectContext.findMany({
			where: {
				id: { in: contextIds },
				project: {
					id: projectId,
					// Enforce tenant isolation - project must belong to this user/org
					...(organizationId
						? { organizationId }
						: { userId, organizationId: null }),
				},
			},
			select: {
				content: true,
				sourceType: true,
				aiInstructions: true,
			},
		});

		return contexts.map((c) => {
			if (!c.sourceType && !c.aiInstructions) {
				return c.content;
			}
			// Shared header helper from @repo/rag — same bracket-line format
			// every other custom renderer uses, so the shapes cannot drift.
			return `${contextMetaHeader(c)}${c.content}`;
		});
	} catch (error) {
		// RAG retrieval is optional - don't fail the workflow if it fails
		console.warn("Failed to retrieve project contexts:", error);
		return [];
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Live URL Sources
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum markdown size kept per Live/fallback page. Live mode is "fresh",
 * not "exhaustive" — truncating keeps the LLM context bounded when a single
 * page is huge (release notes, full sitemaps in one doc, etc.). 50 KB is a
 * sensible default; bump if Lifetime validation shows truncation cutting
 * useful content.
 */
const LIVE_URL_MARKDOWN_LIMIT_BYTES = 50_000;

/**
 * Per-URL timeout for live scrapes.
 * Keeping it tight so a single slow site can't blow the AI-analysis SLA.
 */
const LIVE_URL_SCRAPE_TIMEOUT_MS = 15_000;

export interface GatherLiveUrlSourcesInput {
	projectId: string;
	userId: string;
	organizationId?: string | null;
}

export type LiveUrlContentMode = "live" | "fallback";

export interface LiveUrlContent {
	sourceUrl: string;
	sourceTitle: string | null;
	content: string;
	mode: LiveUrlContentMode;
	/** Set when content was truncated to `LIVE_URL_MARKDOWN_LIMIT_BYTES`. */
	truncated?: boolean;
	/** User-declared type label + AI guidance (Fizzy #1888); present only
	 * when the parent row carries them. */
	sourceType?: string;
	aiInstructions?: string;
}

/**
 * Format a list of `LiveUrlContent` items into the prompt block injected
 * alongside the Qdrant retrieval payload. Returns `""` for an empty list so
 * callers can string-concat without conditionals.
 *
 * Block shape (a "Live URL content" section, kept separate from Qdrant
 * results so the LLM can tell freshly-scraped content apart from indexed
 * chunks):
 *
 * ```
 * ## Live URL content
 *
 * ### Live web source: <Title> (<URL>)
 * <markdown>
 *
 * ### Live web source: ... (re-fetched live; original crawl had failed)
 * <markdown>
 * ```
 *
 * The `(re-fetched live; original crawl had failed)` annotation on `mode =
 * 'fallback'` items mirrors the LINK-card soft-warning chip copy.
 */
export function formatLiveUrlSourcesForPrompt(items: LiveUrlContent[]): string {
	if (items.length === 0) {
		return "";
	}
	const blocks = items.map((item) => {
		// User-declared type label (Fizzy #1888) prefixes the heading; the
		// guidance line sits directly under the heading it governs. Both
		// absent when unset, so headings stay byte-identical.
		const typePart = item.sourceType ? ` [${item.sourceType}]` : "";
		const heading =
			item.mode === "fallback"
				? `### Live web source${typePart}: ${item.sourceTitle ?? item.sourceUrl} (${item.sourceUrl}) (re-fetched live; original crawl had failed)`
				: `### Live web source${typePart}: ${item.sourceTitle ?? item.sourceUrl} (${item.sourceUrl})`;
		const guidance = item.aiInstructions
			? `\n> Source guidance: ${item.aiInstructions}`
			: "";
		const suffix = item.truncated ? "\n\n_(content truncated)_" : "";
		return `${heading}${guidance}\n${item.content}${suffix}`;
	});
	return `## Live URL content\n\n${blocks.join("\n\n")}`;
}

/**
 * Gather Live + cache-miss-fallback URL content at retrieval time.
 *
 * Selection rules:
 *  - `urlRefreshMode = LIVE` → always scrape fresh, return `mode: 'live'`.
 *  - `urlRefreshMode ≠ LIVE` AND (`extractionStatus = FAILED` OR no child
 *    `ProjectContextUrlPage` rows) → one-off live scrape, stamp
 *    `metadata.lastFallbackAt = now` on the parent so the UI can surface
 *    the soft warning, return `mode: 'fallback'`.
 *  - All other LINK rows: skipped (their content is already in Qdrant).
 *
 * Errors are caught per-URL — one bad row contributes nothing rather than
 * killing the whole retrieval. The caller can safely treat a failing scrape
 * as "no live content for this URL" and proceed with the Qdrant payload.
 *
 * NOT written to Qdrant. NOT cached. Tenancy is enforced via XOR per
 * `AGENTS.md`.
 */
export async function gatherLiveUrlSources(
	input: GatherLiveUrlSourcesInput,
): Promise<LiveUrlContent[]> {
	const { projectId, userId, organizationId } = input;

	const tenantFilter = organizationId
		? { organizationId, userId }
		: { organizationId: null, userId };

	// Pull LINK rows whose retrieval-time behavior needs a live scrape.
	// Prisma's `OR` is fine here because all branches stay inside the same
	// XOR-isolated tenant scope.
	const rows = await db.projectContext.findMany({
		where: {
			projectId,
			type: "LINK",
			...tenantFilter,
			OR: [
				{ urlRefreshMode: "LIVE" },
				{
					AND: [
						{ NOT: { urlRefreshMode: "LIVE" } },
						{
							OR: [
								{ extractionStatus: "FAILED" },
								{ urlPages: { none: {} } },
							],
						},
					],
				},
			],
		},
		select: {
			id: true,
			sourceUrl: true,
			sourceTitle: true,
			urlRefreshMode: true,
			extractionStatus: true,
			metadata: true,
			sourceType: true,
			aiInstructions: true,
		},
	});

	if (rows.length === 0) {
		return [];
	}

	// Resolve Firecrawl key once per tenant — same key serves every row in
	// a single retrieval call. If missing, every row is skipped and we log
	// a single warning (one source per gathering call).
	let firecrawlApiKey: string | null;
	try {
		const config = await getSearchProviderConfig({
			providerName: "firecrawl",
			userId,
			...(organizationId ? { organizationId } : {}),
		});
		firecrawlApiKey = config?.encryptedApiKey
			? decryptApiKey(config.encryptedApiKey)
			: null;
	} catch (error) {
		console.warn(
			"[gatherLiveUrlSources] Failed to resolve Firecrawl key — skipping live URL gather",
			{ projectId, error },
		);
		return [];
	}

	if (!firecrawlApiKey) {
		console.warn(
			"[gatherLiveUrlSources] Firecrawl not configured for this tenant — skipping live URL gather",
			{ projectId, hasOrg: Boolean(organizationId) },
		);
		return [];
	}

	// Scrape every selected row concurrently. `Promise.allSettled` so one
	// failure can't sink the rest; per-row catch already turns thrown
	// errors into `null` results below, but this is belt-and-suspenders.
	const settled = await Promise.allSettled(
		rows.map((row) =>
			scrapeOneRow({
				row,
				apiKey: firecrawlApiKey as string,
			}),
		),
	);

	const out: LiveUrlContent[] = [];
	for (const result of settled) {
		if (result.status === "fulfilled" && result.value) {
			out.push(result.value);
		}
	}
	return out;
}

interface ScrapeOneRowInput {
	row: {
		id: string;
		sourceUrl: string | null;
		sourceTitle: string | null;
		urlRefreshMode: "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY" | "LIVE" | null;
		extractionStatus: string;
		metadata: unknown;
		sourceType: string | null;
		aiInstructions: string | null;
	};
	apiKey: string;
}

async function scrapeOneRow({
	row,
	apiKey,
}: ScrapeOneRowInput): Promise<LiveUrlContent | null> {
	if (!row.sourceUrl) {
		return null;
	}

	const mode: LiveUrlContentMode =
		row.urlRefreshMode === "LIVE" ? "live" : "fallback";

	try {
		const result = await scrapeUrl(row.sourceUrl, {
			apiKey,
			formats: ["markdown"],
			timeoutMs: LIVE_URL_SCRAPE_TIMEOUT_MS,
		});

		if (!result.success) {
			console.warn("[gatherLiveUrlSources] Live scrape failed", {
				contextId: row.id,
				sourceUrl: row.sourceUrl,
				mode,
				code: result.error.code,
				message: result.error.message,
			});
			return null;
		}

		const rawMarkdown = result.data.markdown ?? "";
		const truncated = rawMarkdown.length > LIVE_URL_MARKDOWN_LIMIT_BYTES;
		const content = truncated
			? rawMarkdown.slice(0, LIVE_URL_MARKDOWN_LIMIT_BYTES)
			: rawMarkdown;

		// Fallback path stamps `metadata.lastFallbackAt` so the LINK card can
		// surface the soft warning chip on the next render. Done
		// transactionally per row — Prisma's nested `update` with `data.metadata`
		// merges into a JSON column, but we need to preserve existing keys, so
		// we do a read-merge-write inside the same call via a JS object spread
		// on the metadata blob already in `row`.
		if (mode === "fallback") {
			try {
				const existingMetadata =
					typeof row.metadata === "object" && row.metadata !== null
						? (row.metadata as Record<string, unknown>)
						: {};
				const nextMetadata: Prisma.InputJsonValue = {
					...existingMetadata,
					lastFallbackAt: new Date().toISOString(),
				};
				await db.projectContext.update({
					where: { id: row.id },
					data: { metadata: nextMetadata },
				});
			} catch (metaError) {
				// Don't let a metadata-stamp failure block the live content
				// from reaching the LLM — log and move on.
				console.warn(
					"[gatherLiveUrlSources] Failed to stamp lastFallbackAt",
					{ contextId: row.id, error: metaError },
				);
			}
		}

		const liveContent: LiveUrlContent = {
			sourceUrl: result.data.pageUrl,
			sourceTitle: row.sourceTitle ?? result.data.pageTitle,
			content,
			mode,
		};
		if (truncated) {
			liveContent.truncated = true;
		}
		if (row.sourceType) {
			liveContent.sourceType = row.sourceType;
		}
		if (row.aiInstructions) {
			liveContent.aiInstructions = row.aiInstructions;
		}

		// Telemetry: `project_context_url_resynced` for the
		// retrieval-time triggers. Server-side emit as a
		// structured log event tagged `analytics_event` so the ops dashboard
		// can route it without bolting an HTTP analytics client onto the
		// retrieval path. Duration is omitted here because the surrounding
		// `Promise.allSettled` does not isolate per-row latency; pagesIndexed
		// is `1` for a single scrape result (multi-page lives in the workflow,
		// not in `gatherLiveUrlSources`).
		console.info("analytics_event", {
			event: "project_context_url_resynced",
			trigger: mode === "live" ? "live-retrieval" : "fallback",
			pagesIndexed: 1,
			durationMs: null,
			contextId: row.id,
		});

		return liveContent;
	} catch (error) {
		// Belt-and-suspenders: any unexpected throw still produces a null so
		// the parent `Promise.allSettled` reports `fulfilled` with `null`.
		console.warn("[gatherLiveUrlSources] Unexpected scrape error", {
			contextId: row.id,
			sourceUrl: row.sourceUrl,
			mode,
			error,
		});
		return null;
	}
}
