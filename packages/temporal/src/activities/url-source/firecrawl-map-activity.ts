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
 * The activity name is historical: it was registered when /v1/map was the
 * only discovery path, and renaming it would break replay of old workflow
 * histories. Only Firecrawl is listed through a provider endpoint here. This
 * integration does not use Cloudflare Browser Rendering's own listing
 * endpoints (`/links`, `/crawl`): for `cloudflare` this returns
 * `{ urls: [] }` without any network call and the workflow discovers pages
 * by following in-prefix links from each scraped page. Any other provider is
 * rejected with a non-retryable failure.
 */
import { ApplicationFailure } from "@temporalio/activity";
import { activityLogger } from "../lib/activity-logger";
import { mapSiteUrls } from "../lib/firecrawl-client";
import type { WebScraperProviderName } from "../lib/web-scraper";

export interface FirecrawlMapActivityInput {
	url: string;
	apiKey: string;
	/** Optional — defaults to `firecrawl`. `firecrawl` maps via /v1/map; `cloudflare` returns no URLs. */
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

	// This integration lists no pages for Cloudflare Browser Rendering (it
	// does not use Cloudflare's /links or /crawl). Return an empty list: the
	// workflow then scrapes the root URL and its link-following loop queues
	// same-origin, in-prefix links from each scraped page, capped at
	// maxPages. The scrape activity reports those links (`discoveredLinks`),
	// read from the page's markdown with a parser and resolved against the
	// page URL; the markdown itself is stored as the provider returned it.
	if (providerName === "cloudflare") {
		activityLogger.info(
			"URL map skipped for cloudflare: pages are discovered by following links",
			{ url, providerName },
		);
		return { urls: [] };
	}

	// /v1/map is Firecrawl-specific. Any other provider selected for
	// path-prefix is rejected here, defensively.
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
