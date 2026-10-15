/**
 * URL Scrape Activity (URL Context Sources).
 *
 * Originally Firecrawl-only — now dispatches to any scrape-capable provider
 * via the `WebScraper` adapter layer (`lib/web-scraper.ts`,
 * `lib/scrapers/*-scraper.ts`). The activity name stays
 * `firecrawlScrapeActivity` so the workflow's `proxyActivities` binding and
 * the worker registration don't need to change — a minimal diff per spec.
 *
 * Input shape change:
 *   - Old: `{ url, apiKey }` (Firecrawl baked in).
 *   - New: `{ url, providerName, apiKey }`. `providerName` defaults to
 *     `firecrawl` so legacy callers that haven't been migrated still work.
 *
 * Owns the typed-error → ApplicationFailure mapping the workflow body
 * pattern-matches on. The retry envelope is:
 *   - 60s start-to-close
 *   - 3 retries with exponential backoff
 *
 * The non-retryable / retryable split mirrors the legacy behavior:
 *   - `ROBOTS_BLOCKED`, `QUOTA_EXCEEDED`, `UNAUTHORIZED`,
 *     `UNSUPPORTED_CONTENT_TYPE` → non-retryable
 *   - `TIMEOUT`, `UNKNOWN` → retryable (Temporal handles backoff)
 *
 * `ApplicationFailure.type` prefix stays `FIRECRAWL_*` so the workflow's
 * existing classifier (`classifyFailureErrorType`) keeps working without a
 * schema change to the `urlCrawlFailed` telemetry event.
 *
 * The result carries the provider's markdown unchanged. Only when the
 * input asks for them (`discoverLinks`, sent by the path-prefix crawl's
 * link-following loop) does it also carry `discoveredLinks`: the page's
 * link destinations, read with a Markdown parser, resolved against the page
 * URL and cut to the ones that loop could queue.
 */
import { ApplicationFailure } from "@temporalio/activity";
import { filterInPrefixLinks } from "../../lib/in-prefix-links";
import { activityLogger } from "../lib/activity-logger";
import { createScraperByName } from "../lib/get-web-scraper";
import { extractMarkdownLinkDestinations } from "../lib/markdown-links";
import type {
	WebScrapeError,
	WebScrapePage,
	WebScraperProviderName,
} from "../lib/web-scraper";

export interface FirecrawlScrapeActivityInput {
	url: string;
	apiKey: string;
	/** Optional — defaults to `firecrawl` for back-compat with un-migrated callers. */
	providerName?: WebScraperProviderName;
	/**
	 * The provider row's stored endpoint. Optional; only Cloudflare reads it
	 * (its account ID lives there). Absent for every other provider and for
	 * inputs recorded before the field existed.
	 */
	providerEndpoint?: string;
	/**
	 * Return the page's followable links as `discoveredLinks`. Sent only by
	 * the path-prefix crawl's link-following loop; without it the result has
	 * no `discoveredLinks` field at all.
	 */
	discoverLinks?: DiscoverLinksOptions;
}

export interface DiscoverLinksOptions {
	/** The crawl root: links must share its origin. */
	parentUrl: string;
	/** Path prefixes a link's pathname must sit under; none keeps all. */
	includePaths?: string[];
	/** Most links to return, clamped to `MAX_DISCOVERED_LINKS`. */
	limit: number;
}

/**
 * Upper clamp on `discoverLinks.limit`. Every result is recorded in the
 * workflow's history, so this bounds what one page can add there whatever
 * the input says. The crawl sends `maxPages`, which the API caps at 500
 * (`MAX_MAX_PAGES` in the API's `process-context-link.ts`), so the clamp
 * never cuts a crawl's request.
 */
export const MAX_DISCOVERED_LINKS = 1000;

/**
 * Longest link kept. A longer one (typically a huge query string) is
 * skipped rather than recorded.
 */
export const MAX_DISCOVERED_LINK_LENGTH = 2048;

/** Most serialized bytes the `discoveredLinks` field may add to a result. */
export const MAX_DISCOVERED_LINKS_BYTES = 128 * 1024;

/**
 * Largest serialized result that may carry `discoveredLinks`, kept below
 * Temporal's 2 MB per-payload limit with room for the payload envelope.
 * Links are only added within the headroom the page's own result leaves
 * under this size; a page with no room gets no `discoveredLinks` field and
 * the workflow falls back to matching links in its Markdown.
 */
export const MAX_RESULT_BYTES_WITH_LINKS = 1_750_000;

/** Bytes of `,"discoveredLinks":[]` — the field with no links in it. */
const EMPTY_LINKS_FIELD_BYTES = Buffer.byteLength(',"discoveredLinks":[]');

export type FirecrawlScrapeActivityOutput = WebScrapePage & {
	/**
	 * Present only when the input had `discoverLinks`. The page's http(s)
	 * link destinations that pass `filterInPrefixLinks` for the requested
	 * crawl root and prefixes: absolute, without fragments, deduplicated in
	 * document order, at most `limit` of them; links over
	 * `MAX_DISCOVERED_LINK_LENGTH` are skipped, and the list stops before
	 * it would exceed `MAX_DISCOVERED_LINKS_BYTES` or push the serialized
	 * result past `MAX_RESULT_BYTES_WITH_LINKS`. Absent when even an empty
	 * list would not fit.
	 */
	discoveredLinks?: string[];
};

/**
 * Followable links of a scraped page. Relative destinations resolve
 * against the URL the provider reports for the page (where a redirect
 * landed), falling back to the requested URL.
 */
function discoverFollowableLinks(
	markdown: string,
	requestedUrl: string,
	pageUrl: string,
	options: DiscoverLinksOptions,
	byteBudget: number,
): string[] {
	const limit = Math.min(Math.floor(options.limit), MAX_DISCOVERED_LINKS);
	if (!(limit > 0)) {
		return [];
	}
	let base = requestedUrl;
	try {
		const reported = new URL(pageUrl);
		if (reported.protocol === "http:" || reported.protocol === "https:") {
			base = reported.toString();
		}
	} catch {
		// Keep the requested URL as the base.
	}
	const out: string[] = [];
	let bytes = 0;
	for (const link of filterInPrefixLinks(
		extractMarkdownLinkDestinations(markdown, base),
		options.parentUrl,
		options.includePaths,
	)) {
		if (out.length >= limit) {
			break;
		}
		if (link.length > MAX_DISCOVERED_LINK_LENGTH) {
			continue;
		}
		// The link as a JSON string, plus the comma before it.
		const linkBytes = Buffer.byteLength(JSON.stringify(link)) + 1;
		if (bytes + linkBytes > byteBudget) {
			break;
		}
		bytes += linkBytes;
		out.push(link);
	}
	return out;
}

function asActivityFailure(error: WebScrapeError): never {
	const isPermanent =
		error.code === "ROBOTS_BLOCKED" ||
		error.code === "QUOTA_EXCEEDED" ||
		error.code === "UNAUTHORIZED" ||
		error.code === "UNSUPPORTED_CONTENT_TYPE";

	if (isPermanent) {
		throw ApplicationFailure.nonRetryable(
			error.message,
			`FIRECRAWL_${error.code}`,
			{ statusCode: error.statusCode ?? null },
		);
	}

	throw ApplicationFailure.retryable(
		error.message,
		`FIRECRAWL_${error.code}`,
		{ statusCode: error.statusCode ?? null },
	);
}

export async function firecrawlScrapeActivity(
	input: FirecrawlScrapeActivityInput,
): Promise<FirecrawlScrapeActivityOutput> {
	const {
		url,
		apiKey,
		providerName = "firecrawl",
		providerEndpoint,
		discoverLinks,
	} = input;

	activityLogger.info("URL scrape activity start", { url, providerName });

	const scraper = createScraperByName(providerName, apiKey, providerEndpoint);
	if (!scraper && providerName === "cloudflare") {
		// The account endpoint is missing or malformed: retrying cannot fix it,
		// re-saving the provider can.
		throw ApplicationFailure.nonRetryable(
			"Cloudflare Browser Rendering has no valid account ID. Re-save the provider with its account ID in Settings → Search Providers.",
			"FIRECRAWL_UNAUTHORIZED",
			{ statusCode: null },
		);
	}
	if (!scraper) {
		throw ApplicationFailure.nonRetryable(
			`Provider "${providerName}" does not support URL scraping`,
			"FIRECRAWL_UNKNOWN",
		);
	}

	const result = await scraper.scrapeUrl(url);

	if (!result.success) {
		activityLogger.warn("URL scrape failed", {
			url,
			providerName,
			code: result.error.code,
			message: result.error.message,
			statusCode: result.error.statusCode,
		});
		asActivityFailure(result.error);
	}

	// Room for links left under the result size cap once the page itself
	// and an empty field are counted. None left means no field at all.
	const headroom =
		discoverLinks === undefined
			? -1
			: MAX_RESULT_BYTES_WITH_LINKS -
				Buffer.byteLength(JSON.stringify(result.data)) -
				EMPTY_LINKS_FIELD_BYTES;
	const discoveredLinks =
		discoverLinks === undefined || headroom < 0
			? undefined
			: discoverFollowableLinks(
					result.data.markdown,
					url,
					result.data.pageUrl,
					discoverLinks,
					Math.min(MAX_DISCOVERED_LINKS_BYTES, headroom),
				);

	activityLogger.info("URL scrape activity success", {
		url,
		providerName,
		pageUrl: result.data.pageUrl,
		markdownLength: result.data.markdown.length,
		discoveredLinkCount: discoveredLinks?.length,
	});

	return discoveredLinks === undefined
		? result.data
		: { ...result.data, discoveredLinks };
}
