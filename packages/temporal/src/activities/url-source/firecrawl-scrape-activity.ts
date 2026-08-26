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
 */
import { ApplicationFailure } from "@temporalio/activity";
import { activityLogger } from "../lib/activity-logger";
import { createScraperByName } from "../lib/get-web-scraper";
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
}

export type FirecrawlScrapeActivityOutput = WebScrapePage;

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
	const { url, apiKey, providerName = "firecrawl" } = input;

	activityLogger.info("URL scrape activity start", { url, providerName });

	const scraper = createScraperByName(providerName, apiKey);
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

	activityLogger.info("URL scrape activity success", {
		url,
		providerName,
		pageUrl: result.data.pageUrl,
		markdownLength: result.data.markdown.length,
	});

	return result.data;
}
