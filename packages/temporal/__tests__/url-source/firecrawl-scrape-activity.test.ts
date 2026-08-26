/**
 * Tests for `firecrawlScrapeActivity`.
 *
 * The activity is a thin wrapper around `scrapeUrl` whose job is to map the
 * typed-error union into Temporal `ApplicationFailure` variants
 * (retryable for transient, non-retryable for permanent). Spec §10.
 */
import { ApplicationFailure } from "@temporalio/activity";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/activities/lib/firecrawl-client", () => ({
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

import { scrapeUrl } from "../../src/activities/lib/firecrawl-client";
import { firecrawlScrapeActivity } from "../../src/activities/url-source/firecrawl-scrape-activity";

const mockScrapeUrl = scrapeUrl as ReturnType<typeof vi.fn>;

describe("firecrawlScrapeActivity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns the normalised page on success", async () => {
		mockScrapeUrl.mockResolvedValue({
			success: true,
			data: {
				pageUrl: "https://example.com/page",
				pageTitle: "Example",
				markdown: "# hi",
			},
		});

		const result = await firecrawlScrapeActivity({
			url: "https://example.com/page",
			apiKey: "fake-key",
		});

		expect(result.pageUrl).toBe("https://example.com/page");
		expect(result.markdown).toBe("# hi");
	});

	it("maps ROBOTS_BLOCKED to a non-retryable failure", async () => {
		mockScrapeUrl.mockResolvedValue({
			success: false,
			error: {
				code: "ROBOTS_BLOCKED",
				message: "robots.txt disallows crawling",
			},
		});

		await expect(
			firecrawlScrapeActivity({
				url: "https://example.com",
				apiKey: "k",
			}),
		).rejects.toMatchObject({
			type: "FIRECRAWL_ROBOTS_BLOCKED",
			nonRetryable: true,
		});
	});

	it("maps QUOTA_EXCEEDED to a non-retryable failure", async () => {
		mockScrapeUrl.mockResolvedValue({
			success: false,
			error: {
				code: "QUOTA_EXCEEDED",
				message: "402",
				statusCode: 402,
			},
		});

		const promise = firecrawlScrapeActivity({
			url: "https://example.com",
			apiKey: "k",
		});

		await expect(promise).rejects.toBeInstanceOf(ApplicationFailure);
		await expect(promise).rejects.toMatchObject({
			type: "FIRECRAWL_QUOTA_EXCEEDED",
			nonRetryable: true,
		});
	});

	it("maps UNSUPPORTED_CONTENT_TYPE to a non-retryable failure", async () => {
		mockScrapeUrl.mockResolvedValue({
			success: false,
			error: {
				code: "UNSUPPORTED_CONTENT_TYPE",
				message:
					"The URL returned a file type that Firecrawl cannot process: image/svg+xml.",
				statusCode: 400,
			},
		});

		await expect(
			firecrawlScrapeActivity({
				url: "https://example.com/logo.svg",
				apiKey: "k",
			}),
		).rejects.toMatchObject({
			type: "FIRECRAWL_UNSUPPORTED_CONTENT_TYPE",
			nonRetryable: true,
		});
	});

	it("maps TIMEOUT to a retryable failure", async () => {
		mockScrapeUrl.mockResolvedValue({
			success: false,
			error: { code: "TIMEOUT", message: "timed out" },
		});

		await expect(
			firecrawlScrapeActivity({
				url: "https://example.com",
				apiKey: "k",
			}),
		).rejects.toMatchObject({
			type: "FIRECRAWL_TIMEOUT",
			nonRetryable: false,
		});
	});

	it("maps UNKNOWN to a retryable failure", async () => {
		mockScrapeUrl.mockResolvedValue({
			success: false,
			error: { code: "UNKNOWN", message: "boom" },
		});

		await expect(
			firecrawlScrapeActivity({
				url: "https://example.com",
				apiKey: "k",
			}),
		).rejects.toMatchObject({
			type: "FIRECRAWL_UNKNOWN",
			nonRetryable: false,
		});
	});
});
