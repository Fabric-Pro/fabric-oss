/**
 * URL Map Activity (URL Context Sources).
 *
 * The map step from Firecrawl's `/v1/map` endpoint, run as its own short-
 * lived Temporal activity (~30s typical). Splits the legacy
 * `firecrawlCrawlActivity` into a fast map step + N per-URL scrape
 * activities so a worker restart (Azure revision rollout, scale-in, OOM)
 * during a long crawl only loses the in-flight scrape — not the whole
 * map+scrape pipeline.
 *
 * Why this exists (root cause from staging):
 *   - Old design: one `firecrawlCrawlActivity` ran map + ~85 min of
 *     sequential scrapes inside a single activity heartbeat window.
 *   - Staging Azure Container Apps deploys revisions every 30-60 min.
 *     Each deploy restarts the worker pod. The in-flight activity dies,
 *     Temporal waits 30s for the next heartbeat, then times the activity
 *     out and retries from scratch on the new pod. 3 retries × restarts =
 *     stuck FAILED crawls (heartbeat-timeout error). See PR description.
 *   - New design: map activity returns the URL list; the workflow then
 *     dispatches a per-URL scrape activity. A restart kills only one
 *     scrape; already-scraped URLs are already committed to
 *     `ProjectContextUrlPage` via `upsertUrlPageActivity` and survive.
 *
 * Returns the **filtered + capped** URL list. `[]` means map found nothing
 * under the requested path; the workflow handles that by scraping the root
 * URL directly (mirrors `crawlSite`'s zero-URL fallback).
 *
 * Activity name kept Firecrawl-specific because /v1/map is
 * a Firecrawl-only endpoint today; other providers in the `WebScraper`
 * abstraction don't have an equivalent.
 */
import { ApplicationFailure } from "@temporalio/activity";
import { activityLogger } from "../lib/activity-logger";
import { mapSiteUrls } from "../lib/firecrawl-client";
import type { WebScraperProviderName } from "../lib/web-scraper";

export interface FirecrawlMapActivityInput {
	url: string;
	apiKey: string;
	/** Optional — defaults to `firecrawl`. Only firecrawl is supported today. */
	providerName?: WebScraperProviderName;
	includePaths?: string[];
	excludePaths?: string[];
	limit?: number;
}

export interface FirecrawlMapActivityOutput {
	urls: string[];
}

function asActivityFailure(error: {
	code: string;
	message: string;
	statusCode?: number | null;
}): never {
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

export async function firecrawlMapActivity(
	input: FirecrawlMapActivityInput,
): Promise<FirecrawlMapActivityOutput> {
	const {
		url,
		apiKey,
		providerName = "firecrawl",
		includePaths,
		excludePaths,
		limit,
	} = input;

	activityLogger.info("URL map activity start", { url, providerName, limit });

	// /v1/map is Firecrawl-specific. If a non-Firecrawl provider is ever
	// selected for path-prefix, the workflow should pre-validate and refuse
	// before scheduling this activity — but be defensive here too.
	if (providerName !== "firecrawl") {
		throw ApplicationFailure.nonRetryable(
			`Provider "${providerName}" does not support URL discovery via /v1/map`,
			"FIRECRAWL_UNKNOWN",
		);
	}

	const result = await mapSiteUrls(url, {
		apiKey,
		...(includePaths !== undefined ? { includePaths } : {}),
		...(excludePaths !== undefined ? { excludePaths } : {}),
		...(limit !== undefined ? { limit } : {}),
	});

	if (!result.success) {
		activityLogger.warn("URL map failed", {
			url,
			code: result.error.code,
			message: result.error.message,
			statusCode: result.error.statusCode,
		});
		asActivityFailure(result.error);
	}

	activityLogger.info("URL map activity success", {
		url,
		urlCount: result.data.length,
	});

	return { urls: result.data };
}
