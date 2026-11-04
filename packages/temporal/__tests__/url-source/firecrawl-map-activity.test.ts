/**
 * Tests for `firecrawlMapActivity`.
 *
 * Covers the new map-only step that replaces the legacy `firecrawlCrawlActivity`'s
 * map phase in the workflow's PATH_PREFIX branch. The activity must:
 *   - Return the filtered URL list on success.
 *   - Translate provider errors into the right `ApplicationFailure` kind
 *     (retryable vs non-retryable) using the same FIRECRAWL_* type prefix
 *     the workflow's classifier keys off.
 *   - Return no URLs for cloudflare without any network call (no listing
 *     endpoint; the workflow discovers pages by following links).
 *   - Refuse other non-firecrawl providers up-front.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockMapSiteUrls } = vi.hoisted(() => ({
	mockMapSiteUrls: vi.fn(),
}));

vi.mock("../../src/activities/lib/firecrawl-client", () => ({
	mapSiteUrls: mockMapSiteUrls,
}));

vi.mock("../../src/activities/lib/activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { activityLogger } from "../../src/activities/lib/activity-logger";
import { firecrawlMapActivity } from "../../src/activities/url-source/firecrawl-map-activity";

describe("firecrawlMapActivity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns the filtered URL list on success", async () => {
		mockMapSiteUrls.mockResolvedValueOnce({
			success: true,
			data: [
				"https://help.acme.com/hc/en-us/articles/1",
				"https://help.acme.com/hc/en-us/articles/2",
			],
		});

		const result = await firecrawlMapActivity({
			url: "https://help.acme.com/hc/en-us",
			apiKey: "fc-test",
			includePaths: ["/hc/en-us"],
			limit: 100,
		});

		expect(mockMapSiteUrls).toHaveBeenCalledWith(
			"https://help.acme.com/hc/en-us",
			expect.objectContaining({
				apiKey: "fc-test",
				includePaths: ["/hc/en-us"],
				limit: 100,
			}),
		);
		expect(result).toEqual({
			urls: [
				"https://help.acme.com/hc/en-us/articles/1",
				"https://help.acme.com/hc/en-us/articles/2",
			],
		});
	});

	it("returns an empty url list when map found nothing (workflow falls back)", async () => {
		// Mirrors `crawlSite`'s zero-URL fallback: the activity returns
		// `{ urls: [] }` rather than throwing, and the workflow handles the
		// fallback by scraping the root URL directly.
		mockMapSiteUrls.mockResolvedValueOnce({ success: true, data: [] });

		const result = await firecrawlMapActivity({
			url: "https://example.com/spa-no-sitemap",
			apiKey: "fc-test",
		});

		expect(result).toEqual({ urls: [] });
	});

	it.each([
		["ROBOTS_BLOCKED" as const],
		["QUOTA_EXCEEDED" as const],
		["UNAUTHORIZED" as const],
	])(
		"throws non-retryable ApplicationFailure on permanent error %s",
		async (code) => {
			mockMapSiteUrls.mockResolvedValueOnce({
				success: false,
				error: {
					code,
					message: `${code} from firecrawl`,
					statusCode: 403,
				},
			});

			await expect(
				firecrawlMapActivity({ url: "https://x.com", apiKey: "fc" }),
			).rejects.toMatchObject({
				type: `FIRECRAWL_${code}`,
				nonRetryable: true,
			});
		},
	);

	it.each([["TIMEOUT" as const], ["UNKNOWN" as const]])(
		"throws retryable ApplicationFailure on transient error %s",
		async (code) => {
			mockMapSiteUrls.mockResolvedValueOnce({
				success: false,
				error: {
					code,
					message: `${code} from firecrawl`,
					statusCode: 500,
				},
			});

			await expect(
				firecrawlMapActivity({ url: "https://x.com", apiKey: "fc" }),
			).rejects.toMatchObject({
				type: `FIRECRAWL_${code}`,
				nonRetryable: false,
			});
		},
	);

	it.each([
		{
			message:
				"The URL returned a file type that Firecrawl cannot process: image/svg+xml.",
			contentType: "image/svg+xml",
		},
		{
			message:
				"The URL returned a file type that Firecrawl cannot process: application/zip",
			contentType: "application/zip",
		},
	])(
		"returns $contentType as an expected outcome with one warning",
		async ({ message, contentType }) => {
			mockMapSiteUrls.mockResolvedValueOnce({
				success: false,
				error: {
					code: "UNSUPPORTED_CONTENT_TYPE",
					message,
					statusCode: 400,
				},
			});

			const result = await firecrawlMapActivity({
				url: "https://example.com/file",
				apiKey: "fc",
				reportUnsupportedContent: true,
			});

			expect(result).toEqual({
				urls: [],
				unsupported: { contentType, message },
			});
			expect(activityLogger.warn).toHaveBeenCalledTimes(1);
			expect(activityLogger.warn).toHaveBeenCalledWith(
				"URL is a file type that cannot be indexed; skipped (expected)",
				{ url: "https://example.com/file", contentType },
			);
		},
	);

	it("throws UNSUPPORTED_CONTENT_TYPE non-retryably when the caller does not ask for the outcome", async () => {
		mockMapSiteUrls.mockResolvedValueOnce({
			success: false,
			error: {
				code: "UNSUPPORTED_CONTENT_TYPE",
				message:
					"The URL returned a file type that Firecrawl cannot process: application/zip",
			},
		});

		await expect(
			firecrawlMapActivity({ url: "https://x.com", apiKey: "fc" }),
		).rejects.toMatchObject({
			type: "FIRECRAWL_UNSUPPORTED_CONTENT_TYPE",
			nonRetryable: true,
		});
	});

	it.each([
		["QUOTA_EXCEEDED", true],
		["TIMEOUT", false],
	] as const)(
		"still throws %s with the same retryability when asked for the outcome",
		async (code, nonRetryable) => {
			mockMapSiteUrls.mockResolvedValueOnce({
				success: false,
				error: { code, message: `${code} from firecrawl` },
			});

			await expect(
				firecrawlMapActivity({
					url: "https://x.com",
					apiKey: "fc",
					reportUnsupportedContent: true,
				}),
			).rejects.toMatchObject({
				type: `FIRECRAWL_${code}`,
				nonRetryable,
			});
		},
	);

	it("returns no URLs for cloudflare and makes no network call", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		try {
			const result = await firecrawlMapActivity({
				url: "https://help.acme.com/hc/en-us",
				apiKey: "cf-test",
				providerName: "cloudflare",
				includePaths: ["/hc/en-us"],
				limit: 50,
			});

			expect(result).toEqual({ urls: [] });
			expect(mockMapSiteUrls).not.toHaveBeenCalled();
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("refuses non-firecrawl providers (only /v1/map exists)", async () => {
		// /v1/map is Firecrawl-specific. Defensive guard so a misrouted
		// PATH_PREFIX (which should never select another provider) fails
		// fast with a clear ApplicationFailure instead of fetching nothing.
		await expect(
			firecrawlMapActivity({
				url: "https://x.com",
				apiKey: "fc",
				providerName: "jina",
			}),
		).rejects.toMatchObject({
			type: "FIRECRAWL_UNKNOWN",
			nonRetryable: true,
		});

		// Important: the underlying mapSiteUrls helper is NOT called for
		// unsupported providers — the activity fails fast before hitting it.
		expect(mockMapSiteUrls).not.toHaveBeenCalled();
	});
});
