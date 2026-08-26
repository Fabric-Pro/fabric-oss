/**
 * Firecrawl WebScraper adapter (URL Context Sources — commit 3 of 3).
 *
 * Wraps the existing `firecrawl-client.ts` typed transport in the uniform
 * `WebScraper` surface. The legacy client stays — it owns the HTTP boundary,
 * error mapping, and polling — and this adapter is a thin shape-translator on
 * top so the workflow activities don't need to know which provider they're
 * talking to.
 *
 * Both `scrapeUrl` and `crawlSite` map Firecrawl's typed error union onto
 * `WebScrapeErrorCode`:
 *   - `ROBOTS_BLOCKED` → `ROBOTS_BLOCKED`
 *   - `QUOTA_EXCEEDED` → `QUOTA_EXCEEDED`
 *   - `TIMEOUT`        → `TIMEOUT`
 *   - `UNSUPPORTED_CONTENT_TYPE` → `UNSUPPORTED_CONTENT_TYPE`
 *   - `UNKNOWN`        → `UNAUTHORIZED` if statusCode is 401/403, otherwise `UNKNOWN`
 */
import {
	type FirecrawlError,
	type FirecrawlScrapedPage,
	crawlSite as firecrawlCrawlSite,
	scrapeUrl as firecrawlScrapeUrl,
} from "../firecrawl-client";
import type {
	WebCrawlOptions,
	WebCrawlResult,
	WebScrapeError,
	WebScrapeOptions,
	WebScrapePage,
	WebScrapeResult,
	WebScraper,
} from "../web-scraper";

function mapError(err: FirecrawlError): WebScrapeError {
	// Firecrawl's `UNKNOWN` covers the 401/403 path; we promote those to
	// `UNAUTHORIZED` here so the workflow can distinguish "key is bad" from
	// "we don't know what happened".
	if (
		err.code === "UNKNOWN" &&
		(err.statusCode === 401 || err.statusCode === 403)
	) {
		return {
			code: "UNAUTHORIZED",
			message: err.message,
			statusCode: err.statusCode,
			cause: err.cause,
		};
	}
	return {
		code: err.code,
		message: err.message,
		...(err.statusCode !== undefined ? { statusCode: err.statusCode } : {}),
		...(err.cause !== undefined ? { cause: err.cause } : {}),
	};
}

function toPage(page: FirecrawlScrapedPage): WebScrapePage {
	return {
		pageUrl: page.pageUrl,
		pageTitle: page.pageTitle,
		markdown: page.markdown,
		...(page.etag !== undefined ? { etag: page.etag } : {}),
		...(page.lastModifiedHeader !== undefined
			? { lastModifiedHeader: page.lastModifiedHeader }
			: {}),
	};
}

export function createFirecrawlScraper(apiKey: string): WebScraper {
	return {
		providerName: "firecrawl",
		async scrapeUrl(
			url: string,
			opts: WebScrapeOptions = {},
		): Promise<WebScrapeResult> {
			const result = await firecrawlScrapeUrl(url, {
				apiKey,
				...(opts.formats !== undefined
					? { formats: opts.formats }
					: {}),
				...(opts.timeoutMs !== undefined
					? { timeoutMs: opts.timeoutMs }
					: {}),
			});
			if (!result.success) {
				return { success: false, error: mapError(result.error) };
			}
			return { success: true, data: toPage(result.data) };
		},
		async crawlSite(
			url: string,
			opts: WebCrawlOptions,
		): Promise<WebCrawlResult> {
			const result = await firecrawlCrawlSite(url, {
				apiKey,
				...(opts.includePaths !== undefined
					? { includePaths: opts.includePaths }
					: {}),
				...(opts.excludePaths !== undefined
					? { excludePaths: opts.excludePaths }
					: {}),
				...(opts.limit !== undefined ? { limit: opts.limit } : {}),
				...(opts.sitemap !== undefined
					? { sitemap: opts.sitemap }
					: {}),
				...(opts.formats !== undefined
					? { formats: opts.formats }
					: {}),
				...(opts.timeoutMs !== undefined
					? { timeoutMs: opts.timeoutMs }
					: {}),
				...(opts.pollIntervalMs !== undefined
					? { pollIntervalMs: opts.pollIntervalMs }
					: {}),
			});
			if (!result.success) {
				return { success: false, error: mapError(result.error) };
			}
			return { success: true, data: result.data.map(toPage) };
		},
	};
}
