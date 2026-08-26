/**
 * Firecrawl Client Wrapper
 *
 * Small shared client over Firecrawl's `/v1/scrape` and `/v1/map` endpoints.
 * Both single-page (`scrapeUrl`) and path-prefix (`crawlSite`) callers route
 * through here so we have one place that owns the HTTP boundary, header
 * style, JSON validation, and the typed-error mapping consumed by the URL
 * Context Sources feature.
 *
 * Path-prefix crawls use a two-step map + per-URL scrape pipeline rather
 * than `/v1/crawl`. See the `crawlSite` JSDoc for the rationale.
 *
 * The caller is responsible for decrypting the API key beforehand
 * (see `getSearchProviderConfig` + `decryptApiKey`). This module never
 * touches the database or the encryption helpers.
 */
import { z } from "zod";

const FIRECRAWL_API_BASE = "https://api.firecrawl.dev/v1";

/**
 * Client-side `fetch` AbortController timeout. Set to 5 min + 30s slack so the
 * HTTP-level abort fires *after* Firecrawl's own per-request `timeout` (set
 * to `FIRECRAWL_DEFAULT_SCRAPE_TIMEOUT_MS` below) — letting Firecrawl return
 * its own typed error rather than us aborting with a generic TIMEOUT.
 */
const DEFAULT_SCRAPE_TIMEOUT_MS = 330_000;
const DEFAULT_MAP_TIMEOUT_MS = 30_000;
/**
 * Overall budget across map + parallel scrapes inside `crawlSite`. Set 1 min
 * shy of the workflow's 60-min `startToCloseTimeout` on
 * `firecrawlCrawlActivity` so the activity returns a partial-success result
 * (whatever scraped before the budget ran out) instead of being killed mid-
 * run by Temporal. Tracked across the parallel scrape loop — see
 * `crawlSite`.
 */
/**
 * Overall budget across map + per-URL scrapes inside `crawlSite`. Sized for
 * the worst case of (MAX_MAX_PAGES = 500) × (~10 s per scrape at concurrency
 * 1, including the 2 s settle wait + selector wait + extraction) = ~85 min
 * with headroom for the /v1/map call + slower pages. Capped just under the
 * workflow's 120-min `startToCloseTimeout` so the activity returns a
 * partial-success result rather than being killed by Temporal.
 */
const DEFAULT_CRAWL_OVERALL_TIMEOUT_MS = 119 * 60_000;

/**
 * Per-scrape Firecrawl timeout (forwarded as `timeout` in the request body so
 * Firecrawl applies it server-side). 5 min is enough headroom for JS-heavy
 * help-center articles and PDF-style long pages without exceeding the
 * activity heartbeat budget (15s heartbeat against a 30s threshold).
 */
const FIRECRAWL_DEFAULT_SCRAPE_TIMEOUT_MS = 300_000;

/**
 * Maximum concurrent `/v1/scrape` calls during a path-prefix crawl.
 *
 * Held at **1 (sequential)** after multi-PR investigation pinned the
 * Zendesk help-center "scrape returns SSR sidebar instead of article body"
 * bug to the combination of (Azure egress) + (parallel scrapes). The same
 * URLs scrape correctly when called sequentially from the worker AND when
 * called in parallel from a developer laptop — only the worker-egress +
 * parallel combination fails. The most likely cause is Firecrawl's render
 * pool throttling parallel scrapes from a single egress + API-key combo
 * and returning the partially-rendered SSR markup once the limit trips.
 *
 * Trade-off: large help centers crawl serially, which is significantly
 * slower than batched. Re-syncs run async with per-row UI progress, so
 * the wall-clock hit is acceptable. Concurrency 2-3 with jitter, per-key
 * tuning, or alternate scrape providers are tracked as follow-ups.
 */
const DEFAULT_CRAWL_SCRAPE_CONCURRENCY = 1;

/**
 * Per-scrape options applied to every `/v1/scrape` (and per-URL scrape inside
 * `crawlSite`) so JS-rendered article bodies actually land in the markdown.
 *
 * Two non-obvious design choices (both validated against
 * live Zendesk help-center articles via direct Firecrawl
 * API testing — see the firecrawl-debug commit for the diagnostic that
 * pinned down each one):
 *
 *  1. `onlyMainContent: false` (NOT true)
 *
 *     Firecrawl's `onlyMainContent` runs a Readability-style scoring
 *     algorithm to pick a single "main content" subtree. On Zendesk Guide
 *     (and most help centers with a prominent "Articles in this section"
 *     list of links), that algorithm scores the link-dense sidebar HIGHER
 *     than the article body and picks the sidebar instead — the article
 *     body is completely thrown away.
 *
 *     Verified directly against a live Zendesk help-center article URL via
 *     /v1/scrape: `onlyMainContent: true` returns only the sidebar nav;
 *     `onlyMainContent: false` returns the full page including the body.
 *
 *     The trade-off: we now own the chrome-stripping. `excludeTags` below
 *     does that work explicitly.
 *
 *  2. `excludeTags` excludes by CSS class — NOT by bare semantic tag.
 *
 *     The natural list would be `nav`, `header`, `footer`, `aside`. Don't.
 *     Help-center / docs templates render the article's own header and
 *     sidebar INSIDE the article wrapper:
 *         <article>
 *           <header class="article-header"><h1>…</h1></header>
 *           <div class="article-body">…</div>
 *         </article>
 *     Excluding `header` strips the title; excluding `aside` can strip
 *     pull-quotes / callouts that the LLM should see. Verified directly:
 *     adding bare `header,footer,aside` to the exclude list nuked the
 *     article body in the Zendesk help-center test (response collapsed to just
 *     the sidebar widget).
 *
 *     Stick to class names / ARIA roles that are specific to page chrome:
 *     navigation widgets, breadcrumbs, related-articles widgets, brand
 *     banners. `nav` (the element) is OK because article bodies almost
 *     never use a nested `<nav>` — only TOCs do, and the LLM doesn't need
 *     "On this page" navs.
 *
 *  - `actions: [{ type: "wait", selector }]` — DOM-aware wait (see
 *    FIRECRAWL_CONTENT_WAIT_SELECTOR).
 *  - `waitFor: 2000` — fixed settle delay before the wait action.
 *  - `timeout: 300_000` (5 min) — per-request upper bound.
 */
const FIRECRAWL_EXCLUDE_TAGS: readonly string[] = [
	// Safe-to-strip semantic tags. `nav` is OK because article-level TOCs are
	// rare and even when present they're chrome from the LLM's POV. DO NOT add
	// `header` / `footer` / `aside` here — they appear inside article wrappers
	// on Zendesk / docs templates and stripping them takes the body with them.
	"nav",
	"script",
	"style",
	"iframe",
	// ARIA landmark roles for the page-level chrome. These are deliberately
	// applied by template authors to the top-level shell; they don't appear
	// inside article bodies.
	"[role='navigation']",
	"[role='banner']",
	"[role='contentinfo']",
	// Specific Zendesk Guide chrome blocks. Class names are intentionally
	// narrow so we don't accidentally match an article-internal element.
	".article-sidebar",
	".articles-in-section",
	".article-relatives",
	".article-votes",
	".article-more-questions",
	".article-return-to-top",
	".brand-banner",
	".breadcrumbs",
	// Common chrome classes across other docs templates.
	".header",
	".footer",
	".site-header",
	".site-footer",
	".page-header",
	".page-footer",
	".navbar",
	".main-nav",
	".top-nav",
	".breadcrumb",
] as const;

/**
 * Platform-agnostic content-wait selector. Passed to Firecrawl's `actions:
 * [{ type: "wait", selector }]` — Firecrawl resolves it via
 * `document.querySelector(...)`, which natively understands a comma-separated
 * list as "any of these" (logical OR). The wait returns the moment the first
 * match appears in the DOM, then `onlyMainContent` + `excludeTags` do the
 * actual extraction.
 *
 * Design rules for this list (do NOT relax these — past regression on
 * live Zendesk help-center proved them out):
 *
 *  1. NEVER include the bare semantic shells `article`, `main`, or
 *     `[role='main']`. Every major SPA-driven docs/help platform (Zendesk
 *     Guide, Discourse, Mintlify, Docusaurus, Nextra) renders those as
 *     EMPTY initial-HTML containers and streams body content into them via
 *     JS. A wait that matches the empty shell returns instantly and we
 *     extract pre-hydration markup — the original "scrape only catches the
 *     nav widget, not the article body" regression.
 *
 *  2. Match class / data-attribute patterns that platforms attach
 *     ONLY AFTER the body content is rendered. These are mostly hand-picked
 *     from a survey of the top docs/CMS/forum platforms in 2025.
 *
 *  3. Order is irrelevant (querySelector matches by document order, not
 *     selector order). Group by family for readability only.
 *
 *  4. When in doubt: prefer no entry over a too-broad entry. Pages without
 *     any match fall through to the top-level `waitFor` time-based fallback,
 *     which is good enough for static / plain-HTML sites.
 *
 * Platform coverage (~30 selectors covering ~25 platform families):
 *
 *   Help-center / KB platforms
 *     .article-body                         Zendesk Guide (Slack KB, many help centers)
 *     .article-content-body                 Zendesk Guide (legacy theme)
 *     .article__body                        Intercom Articles, BEM-style CMSes
 *     [data-hook='article-body']            Wix Help Center
 *     [data-hook*='post-description']       Wix blog (post body)
 *     .hc-article-body                      Help Scout
 *     .freshdesk-content                    Freshdesk
 *     .kb-article-body                      Salesforce KB / various
 *
 *   Schema.org / generic semantic
 *     [itemprop='articleBody']              schema.org/Article body content
 *     [itemprop='mainContentOfPage']        schema.org/WebPage main content
 *
 *   Blog / CMS body content
 *     .entry-content                        WordPress (most themes)
 *     .post-content                         Ghost, Hugo, Jekyll, many SSGs
 *     .post-body                            Blogger, Medium-style themes
 *     .gh-content                           Ghost CMS (newer themes)
 *     .post__content                        Substack, BEM-style blogs
 *
 *   Forum / discussion
 *     .user-content                         Discourse, GitHub Discussions
 *     .cooked                               Discourse (per-post body)
 *     .s-prose                              Stack Overflow / Stack Exchange
 *
 *   Docs frameworks
 *     .markdown-body                        GitHub README, docs.docker.com, MkDocs
 *     .theme-doc-markdown                   Docusaurus v2/v3
 *     .vp-doc                               VitePress
 *     .md-content                           MkDocs Material
 *     .rst-content                          Read the Docs (Sphinx)
 *     .nextra-content                       Nextra (Next.js docs framework)
 *     .mintlify-content                     Mintlify
 *     [data-content-section]                Mintlify (newer)
 *
 *   Wiki / Confluence-style
 *     .wiki-content                         Atlassian Confluence (server)
 *     [data-test-id='conf-content']         Atlassian Confluence (cloud)
 *     .page-content                         Bookstack, Wiki.js, MediaWiki forks
 *
 *   Notion / GitBook
 *     .notion-page-content                  Notion public pages
 *     .gitbook-content                      GitBook (legacy)
 *     [data-page-content]                   GitBook (newer)
 */
const FIRECRAWL_CONTENT_WAIT_SELECTOR = [
	// Help-center / KB platforms
	".article-body",
	".article-content-body",
	".article__body",
	"[data-hook='article-body']",
	"[data-hook*='post-description']",
	".hc-article-body",
	".freshdesk-content",
	".kb-article-body",
	// Schema.org / generic semantic
	"[itemprop='articleBody']",
	"[itemprop='mainContentOfPage']",
	// Blog / CMS body content
	".entry-content",
	".post-content",
	".post-body",
	".gh-content",
	".post__content",
	// Forum / discussion
	".user-content",
	".cooked",
	".s-prose",
	// Docs frameworks
	".markdown-body",
	".theme-doc-markdown",
	".vp-doc",
	".md-content",
	".rst-content",
	".nextra-content",
	".mintlify-content",
	"[data-content-section]",
	// Wiki / Confluence-style
	".wiki-content",
	"[data-test-id='conf-content']",
	".page-content",
	// Notion / GitBook
	".notion-page-content",
	".gitbook-content",
	"[data-page-content]",
].join(", ");

/**
 * Fixed settle delay (ms) applied at the top of every scrape, BEFORE the
 * selector wait fires. Two reasons we need this in addition to the selector
 * wait:
 *
 *  1. Some non-article pages — site landing pages, generic CMS pages — won't
 *     match any of the strict body selectors. Without a time-based fallback
 *     the scrape proceeds the moment the response lands, before JS finishes
 *     hydrating, and we miss content. 2 s is enough for the common case while
 *     adding ~2 s × pages-to-scrape on the total crawl wall clock.
 *  2. Even when the selector matches, SPA frameworks (Mintlify, Docusaurus)
 *     may insert the element first and stream the inner text shortly after.
 *     The settle gives downstream micro-task scheduling room to finish before
 *     we read the DOM.
 */
const FIRECRAWL_SETTLE_DELAY_MS = 2000;

/**
 * Single normalised scraped page. Both `scrapeUrl` (one) and `crawlSite`
 * (many) return rows in this shape so downstream activities don't branch.
 */
export interface FirecrawlScrapedPage {
	pageUrl: string;
	pageTitle: string | null;
	markdown: string;
	etag?: string;
	lastModifiedHeader?: string;
}

/**
 * Discriminated error union. The codes below cover every branch the
 * UI / Temporal activities need to switch on:
 *  - `ROBOTS_BLOCKED`: Firecrawl refused because robots.txt / ai.txt /
 *    llms.txt disallow crawlers. Distinct copy in the UI.
 *  - `QUOTA_EXCEEDED`: 402 (out of credits) or 429 (rate limit) — both map
 *    to the same UX message ("check your Firecrawl plan").
 *  - `TIMEOUT`: request did not complete within the timeout budget.
 *  - `UNSUPPORTED_CONTENT_TYPE`: Firecrawl returned a non-HTML/PDF binary
 *    content type (image, video, archive, executable, …) it cannot convert
 *    to markdown. Permanent for a given URL — retrying never succeeds.
 *  - `UNKNOWN`: anything else (network, 5xx, malformed JSON, etc.).
 *
 * `statusCode` is present when we have one; `cause` carries the underlying
 * error for debugging without leaking it to the UI.
 */
export type FirecrawlErrorCode =
	| "ROBOTS_BLOCKED"
	| "QUOTA_EXCEEDED"
	| "TIMEOUT"
	| "UNSUPPORTED_CONTENT_TYPE"
	| "UNKNOWN";

export interface FirecrawlError {
	code: FirecrawlErrorCode;
	message: string;
	statusCode?: number;
	cause?: unknown;
}

/**
 * Result envelope. Workflows pattern-match on `success` so the happy and
 * failure branches stay explicit — no thrown errors in activity glue.
 */
export type FirecrawlResult<T> =
	| { success: true; data: T }
	| { success: false; error: FirecrawlError };

export interface FirecrawlScrapeOptions {
	apiKey: string;
	formats?: string[];
	timeoutMs?: number;
}

export interface FirecrawlCrawlOptions {
	apiKey: string;
	includePaths?: string[];
	excludePaths?: string[];
	limit?: number;
	/**
	 * @deprecated Retained for API back-compat. v1 had `ignoreSitemap`;
	 * the map+scrape pipeline always uses the sitemap for discovery, so this
	 * flag is a no-op now. Callers may still pass it; it is ignored.
	 */
	sitemap?: "include" | "skip";
	formats?: string[];
	/** Total budget for the whole crawl (map + parallel scrapes). */
	timeoutMs?: number;
	/**
	 * @deprecated Retained for API back-compat with the old polling impl.
	 * The map+scrape pipeline doesn't poll, so this is unused.
	 */
	pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Internal: response schemas
// ---------------------------------------------------------------------------

/**
 * Firecrawl `/v1/scrape` and per-page payloads share this shape. We only
 * pull out the fields we use — everything else is passthrough on `metadata`
 * and discarded.
 */
const firecrawlPageMetadataSchema = z
	.object({
		title: z.string().nullable().optional(),
		sourceURL: z.string().optional(),
		url: z.string().optional(),
		etag: z.string().optional(),
		"last-modified": z.string().optional(),
		lastModified: z.string().optional(),
	})
	.passthrough();

const firecrawlPageDataSchema = z
	.object({
		markdown: z.string().optional(),
		html: z.string().optional(),
		metadata: firecrawlPageMetadataSchema.optional(),
	})
	.passthrough();

const firecrawlScrapeResponseSchema = z.object({
	success: z.boolean(),
	data: firecrawlPageDataSchema.optional(),
	error: z.string().optional(),
});

/**
 * `/v1/map` returns the URLs Firecrawl discovered for a site via the sitemap
 * plus a shallow crawl. We accept either a flat string array (older format)
 * or an array of objects with a `url` field (newer format) so the client
 * keeps working across Firecrawl version bumps.
 */
const firecrawlMapResponseSchema = z.object({
	success: z.boolean().optional(),
	links: z
		.array(
			z.union([
				z.string(),
				z
					.object({
						url: z.string().optional(),
					})
					.passthrough(),
			]),
		)
		.optional(),
	error: z.string().optional(),
});

type FirecrawlPageData = z.infer<typeof firecrawlPageDataSchema>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrape a single URL via Firecrawl `/v1/scrape`.
 *
 * The returned `pageUrl` prefers the canonical `metadata.sourceURL` from
 * Firecrawl when available, falling back to the input URL. `pageTitle` is
 * `null` when Firecrawl can't extract one.
 */
export async function scrapeUrl(
	url: string,
	opts: FirecrawlScrapeOptions,
): Promise<FirecrawlResult<FirecrawlScrapedPage>> {
	const { apiKey, formats = ["markdown"], timeoutMs } = opts;

	const response = await firecrawlFetch(`${FIRECRAWL_API_BASE}/scrape`, {
		apiKey,
		body: {
			url,
			formats,
			// Belt-and-braces wait strategy. `waitFor` is a fixed settle delay
			// that fires before any other extraction logic; the action then
			// blocks until the strict body selector hydrates (or Firecrawl's
			// own action timeout takes over). Together they handle:
			//   - SPA help centers where `<article>` is in the initial SSR
			//     HTML but the body content streams in 1-2 s later (Zendesk
			//     Guide, Discourse, Mintlify, etc.).
			//   - Plain CMS pages that don't expose a strict body class — the
			//     fixed settle is enough on its own, and the selector wait
			//     no-ops harmlessly when nothing matches.
			waitFor: FIRECRAWL_SETTLE_DELAY_MS,
			actions: [
				{
					type: "wait",
					selector: FIRECRAWL_CONTENT_WAIT_SELECTOR,
				},
			],
			// Firecrawl's Readability picks the wrong subtree (sidebar over body)
			// on help-center templates. See FIRECRAWL_EXCLUDE_TAGS comment.
			onlyMainContent: false,
			excludeTags: [...FIRECRAWL_EXCLUDE_TAGS],
			// 5min per-page upper bound on Firecrawl's side.
			timeout: FIRECRAWL_DEFAULT_SCRAPE_TIMEOUT_MS,
		},
		timeoutMs: timeoutMs ?? DEFAULT_SCRAPE_TIMEOUT_MS,
	});

	if (!response.ok) {
		return { success: false, error: response.error };
	}

	const parsed = firecrawlScrapeResponseSchema.safeParse(response.body);
	if (!parsed.success) {
		return {
			success: false,
			error: {
				code: "UNKNOWN",
				message: "Firecrawl returned a malformed scrape response",
				cause: parsed.error,
			},
		};
	}

	if (!parsed.data.success || !parsed.data.data) {
		return {
			success: false,
			error: mapBodyError(parsed.data.error),
		};
	}

	return {
		success: true,
		data: normalisePage(parsed.data.data, url),
	};
}

/**
 * crawlSite — same-origin path-prefix discovery + per-URL scrape.
 *
 * 1. /v1/map discovers every URL Firecrawl can find under the path
 *    (sitemap-aware where available; falls back to a quick crawl).
 * 2. Filter to same-origin + pathname-matches-includePaths.
 * 3. Batched parallel /v1/scrape per URL (batch size = 5) with smart
 *    content-selector wait + 5min per-page timeout. Elapsed time is
 *    checked between batches so an over-budget run returns partial data
 *    rather than running to the activity's startToCloseTimeout.
 *
 * Cross-domain links inside any scraped page stay as plain
 * markdown [text](url) — Firecrawl never follows them. SPAs
 * without sitemaps fall back to a single-page scrape of the
 * requested URL.
 *
 * Overall-budget tracking: `opts.timeoutMs ?? DEFAULT_CRAWL_OVERALL_TIMEOUT_MS`
 * caps the WHOLE function (map + every batch of parallel scrapes). The
 * scrape loop processes targets in batches of `DEFAULT_CRAWL_SCRAPE_CONCURRENCY`
 * (5) and checks `Date.now() - startedAt < timeoutMs` between batches.
 * If the budget is exhausted mid-run, the remaining queue is abandoned and
 * we return a partial-success result with whatever scraped so far —
 * `success: true` if anything landed, `success: false` (UNKNOWN) only when
 * the budget ran out before any page completed. This avoids the worst-case
 * "huge site + slow Firecrawl = hours of activity time + Temporal kill"
 * pattern in favour of partial coverage that the user can re-sync later.
 *
 * Why not `/v1/crawl`:
 *   - `/v1/crawl` single-shot under-covered deep hierarchies even with
 *     `maxDiscoveryDepth: 10` — its discoverer occasionally short-circuited
 *     once it hit the page limit on a category page before traversing the
 *     section pages.
 *   - `/v1/crawl` applied `scrapeOptions` inconsistently across child pages
 *     (some returned the pre-hydration shell, some didn't).
 *   - A single bad child page failed the whole crawl. Per-URL `Promise.allSettled`
 *     here isolates failures.
 *
 * Per-page failures are skipped (returned partial success). All-failures
 * collapses to a single `UNKNOWN` envelope so the workflow surfaces a clean
 * "we tried, nothing worked" rather than silently empty data.
 *
 * Note: `excludePaths` and `sitemap`/`pollIntervalMs` are retained on
 * `FirecrawlCrawlOptions` for API back-compat. `excludePaths` is applied
 * client-side after map (see `filterByIncludePaths`). `sitemap` and
 * `pollIntervalMs` are accepted but ignored — sitemap-based discovery
 * doesn't have a depth knob, and the map+scrape pipeline doesn't poll.
 */
/**
 * Standalone Firecrawl /v1/map call. Extracted from `crawlSite` so the
 * Temporal workflow can run the map step as its own short-lived activity
 * (~30s) and then dispatch a per-URL scrape activity for each result. That
 * way a worker restart (Azure revision rollout, scale-in, OOM) only kills
 * the currently-in-flight scrape — every URL already scraped is checkpointed
 * via `upsertUrlPageActivity` and survives.
 *
 * Returns the **filtered + capped** URL list (relative to `includePaths` /
 * `excludePaths`). Callers don't have to know about Zendesk-style sidebar
 * filtering — the helper applies the same `filterByIncludePaths` rules the
 * legacy `crawlSite` did.
 *
 * Returns an empty array when map found nothing under the requested path
 * (rare — JS-only SPA with no sitemap). The caller is expected to fall back
 * to scraping the root URL directly, mirroring `crawlSite`'s zero-URL
 * fallback path.
 */
export async function mapSiteUrls(
	url: string,
	opts: {
		apiKey: string;
		includePaths?: string[];
		excludePaths?: string[];
		limit?: number;
		timeoutMs?: number;
	},
): Promise<FirecrawlResult<string[]>> {
	const {
		apiKey,
		includePaths,
		excludePaths,
		limit,
		timeoutMs = DEFAULT_MAP_TIMEOUT_MS,
	} = opts;

	const mapBody: Record<string, unknown> = {
		url,
		includeSubdomains: false,
		// Firecrawl's `/v1/map` `limit` caps discovered URLs server-side.
		// We pass the same cap the caller wanted for scraping so we don't
		// pull back 10k URLs only to throw 9.5k away.
		limit: limit ?? 500,
		// Some Firecrawl versions require `search` to be set (even empty)
		// to enable the sitemap path. Sending `""` is the documented way to
		// say "no filter, give me everything you find".
		search: "",
	};

	const mapResult = await firecrawlFetch(`${FIRECRAWL_API_BASE}/map`, {
		apiKey,
		body: mapBody,
		timeoutMs: Math.min(timeoutMs, DEFAULT_MAP_TIMEOUT_MS),
	});

	if (!mapResult.ok) {
		return { success: false, error: mapResult.error };
	}

	const mapParsed = firecrawlMapResponseSchema.safeParse(mapResult.body);
	if (!mapParsed.success) {
		return {
			success: false,
			error: {
				code: "UNKNOWN",
				message: "Firecrawl returned a malformed map response",
				cause: mapParsed.error,
			},
		};
	}

	if (mapParsed.data.success === false) {
		return {
			success: false,
			error: mapBodyError(mapParsed.data.error),
		};
	}

	const allUrls: string[] = (mapParsed.data.links ?? [])
		.map((entry) => (typeof entry === "string" ? entry : (entry.url ?? "")))
		.filter((u): u is string => u.length > 0);

	const filtered = filterByIncludePaths(
		allUrls,
		url,
		includePaths,
		excludePaths,
	);

	return { success: true, data: filtered.slice(0, limit ?? 500) };
}

export async function crawlSite(
	url: string,
	opts: FirecrawlCrawlOptions,
): Promise<FirecrawlResult<FirecrawlScrapedPage[]>> {
	const {
		apiKey,
		includePaths,
		excludePaths,
		limit,
		formats = ["markdown"],
		timeoutMs = DEFAULT_CRAWL_OVERALL_TIMEOUT_MS,
	} = opts;

	// Overall-budget anchor. Every batch of parallel scrapes checks
	// `Date.now() - startedAt < timeoutMs` before starting. If the budget
	// runs out mid-loop we return a partial-success envelope with whatever
	// finished so far rather than running the activity until Temporal kills
	// it for exceeding `startToCloseTimeout`.
	const startedAt = Date.now();

	// ── Step 1: discover URLs via /v1/map ────────────────────────────────
	const mapResult = await mapSiteUrls(url, {
		apiKey,
		includePaths,
		excludePaths,
		limit,
		timeoutMs,
	});

	if (!mapResult.success) {
		return { success: false, error: mapResult.error };
	}

	const filtered = mapResult.data;

	// ── Step 1b: zero-URL fallback ───────────────────────────────────────
	// If map found nothing under the requested path (rare — typically a
	// JS-only SPA with no sitemap), fall back to scraping the requested
	// URL itself so the user still gets the landing page indexed instead
	// of an empty crawl.
	if (filtered.length === 0) {
		const fallback = await scrapeUrl(url, { apiKey, formats, timeoutMs });
		if (!fallback.success) {
			return { success: false, error: fallback.error };
		}
		return { success: true, data: [fallback.data] };
	}

	const targets = filtered.slice(0, limit ?? 500);

	// ── Step 2: batched parallel /v1/scrape per URL ──────────────────────
	// We process targets in batches of `DEFAULT_CRAWL_SCRAPE_CONCURRENCY`
	// (5) so the overall budget check happens between batches — i.e. at
	// most one in-flight batch outlives the budget. Explicit batches (vs.
	// a global concurrency pool) make the deadline behaviour easy to
	// reason about: between batches we have a synchronous time check,
	// and any in-flight batch is bounded by the per-page timeout.
	const successes: FirecrawlScrapedPage[] = [];
	let abortedEarly = false;

	for (
		let batchStart = 0;
		batchStart < targets.length;
		batchStart += DEFAULT_CRAWL_SCRAPE_CONCURRENCY
	) {
		const elapsed = Date.now() - startedAt;
		if (elapsed >= timeoutMs) {
			abortedEarly = true;
			break;
		}

		const batch = targets.slice(
			batchStart,
			batchStart + DEFAULT_CRAWL_SCRAPE_CONCURRENCY,
		);

		const batchResults = await Promise.allSettled(
			batch.map((target) =>
				scrapeUrl(target, {
					apiKey,
					formats,
					timeoutMs: DEFAULT_SCRAPE_TIMEOUT_MS,
				}),
			),
		);

		for (const r of batchResults) {
			if (r.status !== "fulfilled") {
				continue;
			}
			if (r.value.success) {
				successes.push(r.value.data);
			}
		}
	}

	if (successes.length === 0) {
		return {
			success: false,
			error: {
				code: "UNKNOWN",
				message: abortedEarly
					? `Crawl budget of ${timeoutMs}ms exceeded before any of ${targets.length} pages completed`
					: `All ${targets.length} pages failed to scrape`,
			},
		};
	}

	return { success: true, data: successes };
}

/**
 * Same-origin equivalence helper. Two URLs are "same site" iff they share
 * protocol + port AND their host matches, treating `www.<host>` as
 * equivalent to `<host>`. The www.-strip is intentionally minimal — other
 * subdomain pairs (e.g. `help.acme.com` vs `acme.com`) remain strictly
 * different. Cross-protocol (http vs https) and cross-port pairs are also
 * strictly different.
 *
 * Background: the previous `URL(href).origin` comparison treated
 * `https://www.acme.com` and `https://acme.com` as different origins and
 * dropped most sitemap entries on sites that mix the two. The www. variant
 * is the only equivalence we need to tolerate in v1.1 — subdomain isolation
 * stays strict everywhere else.
 *
 * Exported for unit testability.
 */
export function sameSiteOrigin(a: string, b: string): boolean {
	let pa: URL;
	let pb: URL;
	try {
		pa = new URL(a);
		pb = new URL(b);
	} catch {
		return false;
	}
	if (pa.protocol !== pb.protocol) {
		return false;
	}
	if (pa.port !== pb.port) {
		return false;
	}
	const stripWww = (host: string): string =>
		host.startsWith("www.") ? host.slice(4) : host;
	return stripWww(pa.host) === stripWww(pb.host);
}

/**
 * Filter a discovered URL list to only those whose pathname matches one of
 * the include paths (or the requested URL's own pathname if no
 * `includePaths` were supplied). Also applies `excludePaths`, applies a
 * same-origin guard against the requested URL, and dedupes.
 *
 * `includePaths` may contain glob-style trailing `/*` — we treat any pattern
 * `/foo/*` as the prefix `/foo/`. Bare prefixes (`/foo`) match `/foo` AND
 * `/foo/...` so the caller doesn't have to think about trailing slashes.
 *
 * Same-origin guard: `/v1/map` should already respect origin, but sitemaps
 * occasionally leak entries on subdomains/co-located domains. We drop any
 * URL whose host differs from the requested URL's host — but treat
 * `www.<host>` and `<host>` as equivalent (see `sameSiteOrigin`).
 * Cross-domain links inside scraped content stay as plain markdown —
 * Firecrawl doesn't follow them.
 */
export function filterByIncludePaths(
	urls: string[],
	requestedUrl: string,
	includePaths?: string[],
	excludePaths?: string[],
): string[] {
	let requestedPathname: string;
	let requestedUrlForOrigin: string | null;
	try {
		const parsed = new URL(requestedUrl);
		requestedPathname = parsed.pathname;
		requestedUrlForOrigin = requestedUrl;
	} catch {
		requestedPathname = "/";
		requestedUrlForOrigin = null;
	}

	// Default: if no includePaths, keep anything under the requested URL's
	// own pathname. So `https://help.acme.com/hc/en-us` only keeps URLs
	// under `/hc/en-us`.
	const prefixes =
		includePaths && includePaths.length > 0
			? includePaths.map(normalisePrefix)
			: [normalisePrefix(requestedPathname)];

	const excludePrefixes = (excludePaths ?? []).map(normalisePrefix);

	const seen = new Set<string>();
	const out: string[] = [];

	for (const u of urls) {
		let pathname: string;
		try {
			pathname = new URL(u).pathname;
		} catch {
			continue;
		}
		// Same-site guard — drop anything off the requested URL's host,
		// treating `www.<host>` as equivalent to `<host>`.
		if (
			requestedUrlForOrigin !== null &&
			!sameSiteOrigin(u, requestedUrlForOrigin)
		) {
			continue;
		}
		const matchesInclude = prefixes.some((p) => matchesPrefix(pathname, p));
		if (!matchesInclude) {
			continue;
		}
		const matchesExclude = excludePrefixes.some((p) =>
			matchesPrefix(pathname, p),
		);
		if (matchesExclude) {
			continue;
		}
		if (seen.has(u)) {
			continue;
		}
		seen.add(u);
		out.push(u);
	}

	return out;
}

function normalisePrefix(pattern: string): string {
	// Strip glob-style trailing `/*` so `/docs/*` matches like `/docs/`.
	let p = pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern;
	// Ensure leading slash so absolute-pathname comparisons line up.
	if (!p.startsWith("/")) {
		p = `/${p}`;
	}
	return p;
}

function matchesPrefix(pathname: string, prefix: string): boolean {
	if (pathname === prefix) {
		return true;
	}
	const withSlash = prefix.endsWith("/") ? prefix : `${prefix}/`;
	return pathname.startsWith(withSlash);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface FirecrawlFetchArgs {
	apiKey: string;
	method?: "GET" | "POST";
	body?: unknown;
	timeoutMs: number;
}

type FirecrawlFetchResult =
	| { ok: true; body: unknown }
	| { ok: false; error: FirecrawlError };

async function firecrawlFetch(
	endpoint: string,
	args: FirecrawlFetchArgs,
): Promise<FirecrawlFetchResult> {
	const { apiKey, method = "POST", body, timeoutMs } = args;

	const controller = new AbortController();
	const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

	let response: Response;
	try {
		response = await fetch(endpoint, {
			method,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: controller.signal,
		});
	} catch (error) {
		clearTimeout(timeoutHandle);
		const aborted =
			error instanceof Error &&
			(error.name === "AbortError" || /abort/i.test(error.message));
		return {
			ok: false,
			error: aborted
				? {
						code: "TIMEOUT",
						message: `Firecrawl request to ${endpoint} timed out after ${timeoutMs}ms`,
						cause: error,
					}
				: {
						code: "UNKNOWN",
						message:
							error instanceof Error
								? error.message
								: "Firecrawl network request failed",
						cause: error,
					},
		};
	} finally {
		clearTimeout(timeoutHandle);
	}

	const statusCode = response.status;

	if (statusCode === 401 || statusCode === 403) {
		return {
			ok: false,
			error: {
				code: "UNKNOWN",
				message:
					"Firecrawl rejected the API key (401/403). Re-check the configured key in Settings > Search Providers.",
				statusCode,
			},
		};
	}

	if (statusCode === 402 || statusCode === 429) {
		return {
			ok: false,
			error: {
				code: "QUOTA_EXCEEDED",
				message:
					statusCode === 402
						? "Firecrawl returned 402 (out of credits) — check your Firecrawl plan."
						: "Firecrawl returned 429 (rate limited) — check your Firecrawl plan.",
				statusCode,
			},
		};
	}

	let parsedBody: unknown;
	let rawText: string | undefined;
	try {
		// Read once as text so we can recover the body for error mapping
		// even when JSON parsing fails.
		rawText = await response.text();
		parsedBody = rawText.length === 0 ? {} : JSON.parse(rawText);
	} catch (error) {
		return {
			ok: false,
			error: {
				code: "UNKNOWN",
				message: `Firecrawl returned a non-JSON response (status ${statusCode})`,
				statusCode,
				cause: error,
			},
		};
	}

	if (!response.ok) {
		const bodyError =
			isObject(parsedBody) && typeof parsedBody.error === "string"
				? parsedBody.error
				: undefined;
		return {
			ok: false,
			error: {
				...mapBodyError(bodyError ?? `Firecrawl HTTP ${statusCode}`),
				statusCode,
			},
		};
	}

	return { ok: true, body: parsedBody };
}

/**
 * Map a body-level `error` string from Firecrawl into our typed union.
 * Every code is detected by substring because Firecrawl's text varies
 * across versions ("robots.txt disallows", "blocked by robots", etc.).
 * Match order is significant: the first branch that matches wins, and the
 * unsupported-content-type check runs last so a message that also mentions
 * robots / credits / rate limits keeps its more specific code.
 */
function mapBodyError(message: string | undefined): FirecrawlError {
	if (!message) {
		return {
			code: "UNKNOWN",
			message: "Firecrawl returned an unknown error",
		};
	}
	const lower = message.toLowerCase();
	if (lower.includes("robots") || lower.includes("disallow")) {
		return { code: "ROBOTS_BLOCKED", message };
	}
	if (
		lower.includes("credit") ||
		lower.includes("quota") ||
		lower.includes("payment")
	) {
		return { code: "QUOTA_EXCEEDED", message };
	}
	if (lower.includes("rate limit")) {
		return { code: "QUOTA_EXCEEDED", message };
	}
	if (lower.includes("timeout") || lower.includes("timed out")) {
		return { code: "TIMEOUT", message };
	}
	if (
		lower.includes("file type") &&
		(lower.includes("cannot process") || lower.includes("not supported"))
	) {
		return { code: "UNSUPPORTED_CONTENT_TYPE", message };
	}
	return { code: "UNKNOWN", message };
}

function normalisePage(
	data: FirecrawlPageData,
	requestedUrl: string,
): FirecrawlScrapedPage {
	const meta = data.metadata ?? {};
	const pageUrl = meta.sourceURL ?? meta.url ?? requestedUrl;
	const pageTitle =
		typeof meta.title === "string" && meta.title.length > 0
			? meta.title
			: null;
	const lastModifiedHeader = meta.lastModified ?? meta["last-modified"];

	const page: FirecrawlScrapedPage = {
		pageUrl,
		pageTitle,
		markdown: data.markdown ?? "",
	};
	if (meta.etag) {
		page.etag = meta.etag;
	}
	if (lastModifiedHeader) {
		page.lastModifiedHeader = lastModifiedHeader;
	}
	return page;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
