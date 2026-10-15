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
import {
	firecrawlScrapeActivity,
	MAX_DISCOVERED_LINK_LENGTH,
	MAX_DISCOVERED_LINKS,
	MAX_DISCOVERED_LINKS_BYTES,
	MAX_RESULT_BYTES_WITH_LINKS,
} from "../../src/activities/url-source/firecrawl-scrape-activity";

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

	describe("discoveredLinks", () => {
		const RAW = [
			"# Docs",
			"",
			'[A](/docs/a) [B](./b "Title [X](/docs/title)") [Up](../top)',
			"[Ext](https://other.example.com/docs/x) [Mail](mailto:dev@example.com)",
			"[Blog](/blog/post) [Old](/docs-old/x) [A again](/docs/a#part)",
			"",
			"Inline `[no](/docs/inline)` and https://example.com/docs/lit.",
			"",
			"```md",
			"[no](/docs/fenced)",
			"```",
			"",
			"[ref]: </docs/ref page>",
		].join("\n");

		function page(
			markdown: string,
			pageUrl = "https://example.com/docs/guide/",
		) {
			mockScrapeUrl.mockResolvedValue({
				success: true,
				data: { pageUrl, pageTitle: "Docs", markdown },
			});
		}

		it("has no discoveredLinks field when the input does not ask for links", async () => {
			page(RAW);

			const result = await firecrawlScrapeActivity({
				url: "https://example.com/docs/guide/",
				apiKey: "k",
			});

			expect(result).toEqual({
				pageUrl: "https://example.com/docs/guide/",
				pageTitle: "Docs",
				markdown: RAW,
			});
			expect(result).not.toHaveProperty("discoveredLinks");
		});

		it("returns only the in-prefix, same-origin links and the markdown unchanged", async () => {
			page(RAW);

			const result = await firecrawlScrapeActivity({
				url: "https://example.com/docs/guide/",
				apiKey: "k",
				discoverLinks: {
					parentUrl: "https://example.com/docs",
					includePaths: ["/docs"],
					limit: 50,
				},
			});

			expect(result.markdown).toBe(RAW);
			expect(result.discoveredLinks).toEqual([
				"https://example.com/docs/a",
				"https://example.com/docs/guide/b",
				"https://example.com/docs/top",
				"https://example.com/docs/lit",
				"https://example.com/docs/ref%20page",
			]);
		});

		it("keeps every same-origin link when no includePaths are given", async () => {
			page(RAW);

			const result = await firecrawlScrapeActivity({
				url: "https://example.com/docs/guide/",
				apiKey: "k",
				discoverLinks: { parentUrl: "https://example.com", limit: 50 },
			});

			expect(result.discoveredLinks).toEqual([
				"https://example.com/docs/a",
				"https://example.com/docs/guide/b",
				"https://example.com/docs/top",
				"https://example.com/blog/post",
				"https://example.com/docs-old/x",
				"https://example.com/docs/lit",
				"https://example.com/docs/ref%20page",
			]);
		});

		it("resolves relative links against the page URL the provider reports", async () => {
			page("[S](sibling)", "https://example.com/docs/moved/page");

			const result = await firecrawlScrapeActivity({
				url: "https://example.com/docs/old",
				apiKey: "k",
				discoverLinks: {
					parentUrl: "https://example.com/docs",
					includePaths: ["/docs"],
					limit: 10,
				},
			});

			expect(result.discoveredLinks).toEqual([
				"https://example.com/docs/moved/sibling",
			]);
		});

		function linkList(count: number): string {
			return Array.from(
				{ length: count },
				(_, i) => `[p${i}](/docs/p${i})`,
			).join("\n\n");
		}

		it("returns at most `limit` links, the first ones in document order", async () => {
			page(linkList(30), "https://example.com/docs");

			const result = await firecrawlScrapeActivity({
				url: "https://example.com/docs",
				apiKey: "k",
				discoverLinks: {
					parentUrl: "https://example.com/docs",
					includePaths: ["/docs"],
					limit: 10,
				},
			});

			expect(result.discoveredLinks).toEqual(
				Array.from(
					{ length: 10 },
					(_, i) => `https://example.com/docs/p${i}`,
				),
			);
		});

		it(`clamps limit to ${MAX_DISCOVERED_LINKS}`, async () => {
			page(
				linkList(MAX_DISCOVERED_LINKS + 50),
				"https://example.com/docs",
			);

			const result = await firecrawlScrapeActivity({
				url: "https://example.com/docs",
				apiKey: "k",
				discoverLinks: {
					parentUrl: "https://example.com/docs",
					limit: MAX_DISCOVERED_LINKS * 5,
				},
			});

			expect(result.discoveredLinks).toHaveLength(MAX_DISCOVERED_LINKS);
		});

		it("bounds the links' total size, skipping any single over-long link", async () => {
			const longQuery = "q".repeat(MAX_DISCOVERED_LINK_LENGTH);
			const markdown = [
				`[huge](/docs/huge?${longQuery})`,
				...Array.from(
					{ length: 500 },
					(_, i) => `[p${i}](/docs/p${i}?${"x".repeat(1000)})`,
				),
			].join("\n\n");
			page(markdown, "https://example.com/docs");

			const result = await firecrawlScrapeActivity({
				url: "https://example.com/docs",
				apiKey: "k",
				discoverLinks: {
					parentUrl: "https://example.com/docs",
					limit: 500,
				},
			});

			const links = result.discoveredLinks ?? [];
			expect(
				Buffer.byteLength(JSON.stringify(links)),
			).toBeLessThanOrEqual(MAX_DISCOVERED_LINKS_BYTES);
			expect(links.length).toBeGreaterThan(0);
			expect(links.length).toBeLessThan(500);
			expect(links.some((link) => link.includes("/docs/huge"))).toBe(
				false,
			);
			expect(links[0]).toMatch(/^https:\/\/example\.com\/docs\/p0\?/);
		});

		// A page whose own result is just under the size cap: links fill
		// only the room left, so the whole result stays under the cap.
		it("keeps a near-limit result under the size cap with its links", async () => {
			const links = Array.from(
				{ length: 400 },
				(_, i) => `[p${i}](/docs/p${i}?${"x".repeat(300)})`,
			).join("\n\n");
			const filler = "y".repeat(
				MAX_RESULT_BYTES_WITH_LINKS - 50_000 - links.length,
			);
			page(`${links}\n\n${filler}`, "https://example.com/docs");

			const result = await firecrawlScrapeActivity({
				url: "https://example.com/docs",
				apiKey: "k",
				discoverLinks: {
					parentUrl: "https://example.com/docs",
					limit: 500,
				},
			});

			expect(result.discoveredLinks?.length).toBeGreaterThan(0);
			expect(result.discoveredLinks?.length).toBeLessThan(400);
			expect(
				Buffer.byteLength(JSON.stringify(result)),
			).toBeLessThanOrEqual(MAX_RESULT_BYTES_WITH_LINKS);
		});

		it("omits discoveredLinks when the page alone leaves no room for them", async () => {
			const markdown = `[a](/docs/a)\n\n${"y".repeat(MAX_RESULT_BYTES_WITH_LINKS)}`;
			page(markdown, "https://example.com/docs");

			const result = await firecrawlScrapeActivity({
				url: "https://example.com/docs",
				apiKey: "k",
				discoverLinks: {
					parentUrl: "https://example.com/docs",
					limit: 500,
				},
			});

			expect(result).not.toHaveProperty("discoveredLinks");
			expect(result.markdown).toBe(markdown);
		});

		it("returns an empty list for a non-positive limit", async () => {
			page(linkList(3), "https://example.com/docs");

			const result = await firecrawlScrapeActivity({
				url: "https://example.com/docs",
				apiKey: "k",
				discoverLinks: {
					parentUrl: "https://example.com/docs",
					limit: 0,
				},
			});

			expect(result.discoveredLinks).toEqual([]);
		});
	});

	describe("Cloudflare Browser Rendering", () => {
		const ENDPOINT =
			"https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef";

		it("returns Cloudflare's markdown unchanged with its relative in-prefix links discovered", async () => {
			const raw =
				"# Docs\n\n[A](/docs/a) [B](b) [Out](/blog/x) `[no](/docs/code)`\n\n[ref]: ../faq";
			const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(JSON.stringify({ success: true, result: raw }), {
					status: 200,
				}),
			);
			try {
				const page = await firecrawlScrapeActivity({
					url: "https://example.com/docs/guide/intro",
					apiKey: "cf-token",
					providerName: "cloudflare",
					providerEndpoint: ENDPOINT,
					discoverLinks: {
						parentUrl: "https://example.com/docs",
						includePaths: ["/docs"],
						limit: 500,
					},
				});
				expect(page.markdown).toBe(raw);
				expect(page.discoveredLinks).toEqual([
					"https://example.com/docs/a",
					"https://example.com/docs/guide/b",
					"https://example.com/docs/faq",
				]);
			} finally {
				fetchMock.mockRestore();
			}
		});

		it("scrapes through the account endpoint carried as providerEndpoint", async () => {
			const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				new Response(
					JSON.stringify({
						success: true,
						result: "# Hi\n\nBody",
					}),
					{ status: 200 },
				),
			);
			try {
				const page = await firecrawlScrapeActivity({
					url: "https://example.com/page",
					apiKey: "cf-token",
					providerName: "cloudflare",
					providerEndpoint: ENDPOINT,
				});
				expect(page).toMatchObject({
					pageTitle: "Hi",
					markdown: "# Hi\n\nBody",
				});
				expect(page).not.toHaveProperty("discoveredLinks");
				expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
					`${ENDPOINT}/browser-rendering/markdown`,
				);
			} finally {
				fetchMock.mockRestore();
			}
		});

		it("fails non-retryably when the account endpoint is missing", async () => {
			await expect(
				firecrawlScrapeActivity({
					url: "https://example.com",
					apiKey: "cf-token",
					providerName: "cloudflare",
				}),
			).rejects.toMatchObject({
				type: "FIRECRAWL_UNAUTHORIZED",
				nonRetryable: true,
			});
		});
	});
});
