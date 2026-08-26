/**
 * WebScraper abstraction (URL Context Sources — multi-provider, commit 3 of 3).
 *
 * The legacy Firecrawl-only path (lib/firecrawl-client.ts) is now wrapped in a
 * uniform `WebScraper` surface so the workflow activities can dispatch to any
 * configured scrape-capable provider:
 *
 *   - `firecrawl` (scrape + crawl)
 *   - `jina`      (scrape only — r.jina.ai/<url>)
 *   - `tavily`    (scrape only — /extract)
 *   - `exa`       (scrape only — /contents)
 *
 * `parallel` is recognised by name so callers can surface a clear "not
 * supported yet" message; no adapter ships in this commit.
 *
 * SINGLE_PAGE works with any scrape-capable provider. PATH_PREFIX (multi-page
 * crawl with includePaths/limit) currently requires Firecrawl because no other
 * provider exposes the equivalent endpoint — surfaced via `supportsCrawl(scraper)`
 * and enforced at the procedure pre-flight (`process-context-link.ts`).
 *
 * The result envelope below is the same discriminated-union shape Firecrawl
 * already used (lib/firecrawl-client.ts `FirecrawlResult`) so the activities
 * downstream of this seam do not have to learn a new shape.
 */

/**
 * Discriminated error union — every adapter MUST normalise provider-specific
 * errors into one of these codes so the workflow's retryable / non-retryable
 * mapping (activities/url-source/firecrawl-scrape-activity.ts) stays unchanged.
 *
 *   - `ROBOTS_BLOCKED`   robots.txt / ai.txt / llms.txt disallow scraping
 *   - `QUOTA_EXCEEDED`   402 / 429 — out of credits or rate-limited
 *   - `TIMEOUT`          request budget exceeded
 *   - `UNAUTHORIZED`     401 / 403 — key invalid or revoked
 *   - `UNSUPPORTED_CONTENT_TYPE` URL resolved to a binary / unsupported
 *                        content type (image, video, archive) the provider
 *                        cannot convert to markdown; permanent for a URL
 *   - `UNKNOWN`          anything else (network, 5xx, malformed body, …)
 */
export type WebScrapeErrorCode =
	| "ROBOTS_BLOCKED"
	| "QUOTA_EXCEEDED"
	| "TIMEOUT"
	| "UNAUTHORIZED"
	| "UNSUPPORTED_CONTENT_TYPE"
	| "UNKNOWN";

export interface WebScrapeError {
	code: WebScrapeErrorCode;
	message: string;
	statusCode?: number;
	cause?: unknown;
}

/**
 * Single normalised page (mirror of `FirecrawlScrapedPage` from the legacy
 * client — kept compatible so the activities' downstream consumers do not
 * change).
 */
export interface WebScrapePage {
	pageUrl: string;
	pageTitle: string | null;
	markdown: string;
	etag?: string;
	lastModifiedHeader?: string;
}

export type WebScrapeResult =
	| { success: true; data: WebScrapePage }
	| { success: false; error: WebScrapeError };

export type WebCrawlResult =
	| { success: true; data: WebScrapePage[] }
	| { success: false; error: WebScrapeError };

export interface WebScrapeOptions {
	formats?: string[];
	timeoutMs?: number;
}

export interface WebCrawlOptions {
	includePaths?: string[];
	excludePaths?: string[];
	limit?: number;
	sitemap?: "include" | "skip";
	formats?: string[];
	timeoutMs?: number;
	pollIntervalMs?: number;
}

export type WebScraperProviderName =
	| "firecrawl"
	| "jina"
	| "tavily"
	| "exa"
	| "parallel";

/**
 * Capability-typed adapter. `crawlSite` is optional — only Firecrawl
 * implements it in v1.1. Callers use the `supportsCrawl` type guard before
 * invoking it.
 */
export interface WebScraper {
	providerName: WebScraperProviderName;
	scrapeUrl(url: string, opts?: WebScrapeOptions): Promise<WebScrapeResult>;
	crawlSite?(url: string, opts: WebCrawlOptions): Promise<WebCrawlResult>;
}

export function supportsCrawl(scraper: WebScraper): scraper is WebScraper & {
	crawlSite: NonNullable<WebScraper["crawlSite"]>;
} {
	return typeof scraper.crawlSite === "function";
}

/**
 * Provider-name → human-readable label. The UI uses this in the "Indexing
 * with X" indicator. Kept in this file so server and client can share the
 * mapping via a single import (the client bundle won't pull the rest of the
 * temporal package — tree-shake will keep only this object).
 */
export const WEB_SCRAPER_DISPLAY_NAMES: Record<WebScraperProviderName, string> =
	{
		firecrawl: "Firecrawl",
		jina: "Jina AI",
		tavily: "Tavily",
		exa: "Exa",
		parallel: "Parallel",
	};

/**
 * Provider names that can scrape a single URL. Used by the picker
 * (`get-web-scraper.ts`) and the UI pre-flight (`ContextUploaderDialog.tsx`)
 * to filter `searchProviders.get*Providers()` rows. `parallel` is excluded —
 * see the file header.
 */
export const SCRAPE_CAPABLE_PROVIDERS: readonly WebScraperProviderName[] = [
	"firecrawl",
	"jina",
	"tavily",
	"exa",
] as const;

/**
 * Provider names that can crawl a path-prefix. Currently Firecrawl only.
 * Used by the picker's `requireCrawl` filter and by the UI's PATH_PREFIX
 * radio gate.
 */
export const CRAWL_CAPABLE_PROVIDERS: readonly WebScraperProviderName[] = [
	"firecrawl",
] as const;

export function isScrapeCapableProvider(
	providerName: string,
): providerName is WebScraperProviderName {
	return SCRAPE_CAPABLE_PROVIDERS.includes(
		providerName as WebScraperProviderName,
	);
}

export function isCrawlCapableProvider(
	providerName: string,
): providerName is WebScraperProviderName {
	return CRAWL_CAPABLE_PROVIDERS.includes(
		providerName as WebScraperProviderName,
	);
}
