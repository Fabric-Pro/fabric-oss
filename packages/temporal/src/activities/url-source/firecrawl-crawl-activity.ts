/**
 * URL Crawl Activity (URL Context Sources).
 *
 * Multi-page crawler. Currently dispatches to the Firecrawl adapter — no
 * other provider in the matrix exposes a multi-page `includePaths`/`limit`
 * endpoint, so PATH_PREFIX is hard-gated to Firecrawl at the procedure
 * pre-flight (`process-context-link.ts`).
 *
 * The activity name stays `firecrawlCrawlActivity` for the same reason the
 * scrape activity keeps its name — minimal-diff: smaller risk of breaking
 * activity registration or replay of in-flight workflows.
 *
 * Long-running — the crawl polls until completion. The workflow declares 10m
 * start-to-close and 30s heartbeat; this activity emits heartbeats on a
 * fixed interval so Temporal knows we're alive during the polling loop
 * (which happens inside the adapter).
 *
 * If a caller selects a non-crawl-capable provider (the picker should
 * prevent this at the procedure pre-flight) the activity throws
 * non-retryable rather than silently scrape-only-ing.
 */
import { ApplicationFailure, heartbeat } from "@temporalio/activity";
import { activityLogger } from "../lib/activity-logger";
import { createScraperByName } from "../lib/get-web-scraper";
import {
	supportsCrawl,
	type WebScrapeError,
	type WebScrapePage,
	type WebScraperProviderName,
} from "../lib/web-scraper";

export interface FirecrawlCrawlActivityInput {
	url: string;
	apiKey: string;
	/** Optional — defaults to `firecrawl` for back-compat. */
	providerName?: WebScraperProviderName;
	includePaths?: string[];
	excludePaths?: string[];
	limit?: number;
	sitemap?: "include" | "skip";
}

export type FirecrawlCrawlActivityOutput = WebScrapePage[];

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

export async function firecrawlCrawlActivity(
	input: FirecrawlCrawlActivityInput,
): Promise<FirecrawlCrawlActivityOutput> {
	const {
		url,
		apiKey,
		providerName = "firecrawl",
		includePaths,
		excludePaths,
		limit,
		sitemap,
	} = input;

	activityLogger.info("URL crawl activity start", {
		url,
		providerName,
		includePaths,
		limit,
		sitemap,
	});

	const scraper = createScraperByName(providerName, apiKey);
	if (!scraper) {
		throw ApplicationFailure.nonRetryable(
			`Provider "${providerName}" does not support URL scraping`,
			"FIRECRAWL_UNKNOWN",
		);
	}
	if (!supportsCrawl(scraper)) {
		// PATH_PREFIX crawls require crawl-capable providers (Firecrawl in
		// v1.1). The pre-flight should have caught this; this is the
		// belt-and-braces guard.
		throw ApplicationFailure.nonRetryable(
			`Provider "${providerName}" does not support multi-page crawls`,
			"FIRECRAWL_UNKNOWN",
		);
	}

	// Heartbeat every 15s so the 30s heartbeatTimeout declared by the
	// workflow's proxyActivities config has headroom during the polling
	// loop in `crawlSite`.
	const heartbeatInterval = setInterval(() => {
		try {
			heartbeat();
		} catch {
			// Outside an activity context (tests). Swallow silently.
		}
	}, 15_000);

	try {
		const result = await scraper.crawlSite(url, {
			...(includePaths !== undefined ? { includePaths } : {}),
			...(excludePaths !== undefined ? { excludePaths } : {}),
			...(limit !== undefined ? { limit } : {}),
			...(sitemap !== undefined ? { sitemap } : {}),
		});

		if (!result.success) {
			activityLogger.warn("URL crawl failed", {
				url,
				providerName,
				code: result.error.code,
				message: result.error.message,
				statusCode: result.error.statusCode,
			});
			asActivityFailure(result.error);
		}

		activityLogger.info("URL crawl activity success", {
			url,
			providerName,
			pageCount: result.data.length,
		});

		return result.data;
	} finally {
		clearInterval(heartbeatInterval);
	}
}
