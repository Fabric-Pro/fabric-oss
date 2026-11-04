/**
 * Tests for `firecrawlCrawlActivity`'s error mapping: an unsupported content
 * type is an expected outcome when the caller asks for it, and every other
 * error throws with the retryability it always had.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCrawlSite } = vi.hoisted(() => ({ mockCrawlSite: vi.fn() }));

vi.mock("../../src/activities/lib/firecrawl-client", () => ({
	crawlSite: mockCrawlSite,
	scrapeUrl: vi.fn(),
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
import { firecrawlCrawlActivity } from "../../src/activities/url-source/firecrawl-crawl-activity";

describe("firecrawlCrawlActivity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns the crawled pages on success", async () => {
		const pages = [
			{
				pageUrl: "https://example.com/docs",
				pageTitle: "Docs",
				markdown: "#",
			},
		];
		mockCrawlSite.mockResolvedValueOnce({ success: true, data: pages });

		await expect(
			firecrawlCrawlActivity({
				url: "https://example.com/docs",
				apiKey: "fc",
				reportUnsupportedContent: true,
			}),
		).resolves.toEqual(pages);
	});

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
			mockCrawlSite.mockResolvedValueOnce({
				success: false,
				error: { code: "UNSUPPORTED_CONTENT_TYPE", message },
			});

			const result = await firecrawlCrawlActivity({
				url: "https://example.com/file",
				apiKey: "fc",
				reportUnsupportedContent: true,
			});

			expect(result).toEqual({
				pages: [],
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
		mockCrawlSite.mockResolvedValueOnce({
			success: false,
			error: {
				code: "UNSUPPORTED_CONTENT_TYPE",
				message:
					"The URL returned a file type that Firecrawl cannot process: application/zip",
			},
		});

		await expect(
			firecrawlCrawlActivity({
				url: "https://example.com",
				apiKey: "fc",
			}),
		).rejects.toMatchObject({
			type: "FIRECRAWL_UNSUPPORTED_CONTENT_TYPE",
			nonRetryable: true,
		});
	});

	it.each([
		["ROBOTS_BLOCKED", true],
		["UNAUTHORIZED", true],
		["TIMEOUT", false],
		["UNKNOWN", false],
	] as const)(
		"still throws %s with the same retryability",
		async (code, nonRetryable) => {
			mockCrawlSite.mockResolvedValueOnce({
				success: false,
				error: { code, message: `${code} from firecrawl` },
			});

			await expect(
				firecrawlCrawlActivity({
					url: "https://example.com",
					apiKey: "fc",
					reportUnsupportedContent: true,
				}),
			).rejects.toMatchObject({
				type: `FIRECRAWL_${code}`,
				nonRetryable,
			});
		},
	);
});
