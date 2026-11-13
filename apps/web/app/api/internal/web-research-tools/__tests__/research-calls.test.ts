import type {
	WebResearchSearcher,
	WebScrapeErrorCode,
	WebScraper,
} from "@repo/temporal/activities";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConfidentialMatcher } from "../confidential-terms";
import {
	MAX_PAGE_CONTENT_LENGTH,
	PROVIDER_CALL_TIMEOUT_MS,
	runReadUrl,
	runWebSearch,
} from "../research-calls";

type SearchResults = Awaited<ReturnType<WebResearchSearcher["search"]>>;
type ScrapeResult = Awaited<ReturnType<WebScraper["scrapeUrl"]>>;

function searcher(
	search: (query: string, maxResults: number) => Promise<SearchResults>,
): WebResearchSearcher {
	return { providerName: "exa", search: vi.fn(search) };
}

function scraper(
	scrapeUrl: (url: string, opts?: unknown) => Promise<ScrapeResult>,
): WebScraper {
	return { providerName: "firecrawl", scrapeUrl: vi.fn(scrapeUrl) };
}

function page(markdown: string, extra: Record<string, unknown> = {}) {
	return {
		success: true as const,
		data: {
			pageUrl: "https://www.example.net/report",
			pageTitle: "Annual report",
			markdown,
			...extra,
		},
	};
}

const REQUEST = new URL("https://www.example.net/report");
const NO_TERMS = buildConfidentialMatcher({});

afterEach(() => {
	vi.useRealTimers();
});

describe("runWebSearch", () => {
	it("returns hits without page content, capped to maxResults", async () => {
		const results = Array.from({ length: 6 }, (_, i) => ({
			title: `Result ${i}`,
			url: `https://example.net/${i}`,
			snippet: "short snippet",
			content: "FULL PAGE BODY",
			source: "exa",
			...(i === 0 && {
				publishedDate: "2025-01-01",
				author: "A. Writer",
			}),
		}));
		const provider = searcher(async () => results);

		const outcome = await runWebSearch(provider, "cloud ROI", 3);

		expect(provider.search).toHaveBeenCalledWith("cloud ROI", 3);
		expect(outcome).toEqual({
			ok: true,
			provider: "exa",
			results: [
				{
					url: "https://example.net/0",
					title: "Result 0",
					snippet: "short snippet",
					publishedDate: "2025-01-01",
					author: "A. Writer",
				},
				{
					url: "https://example.net/1",
					title: "Result 1",
					snippet: "short snippet",
				},
				{
					url: "https://example.net/2",
					title: "Result 2",
					snippet: "short snippet",
				},
			],
		});
		expect(JSON.stringify(outcome)).not.toContain("FULL PAGE BODY");
	});

	it("cuts a long snippet to 500 characters", async () => {
		const provider = searcher(async () => [
			{
				title: "Long",
				url: "https://example.net/long",
				snippet: "x".repeat(2000),
				source: "exa",
			},
		]);

		const outcome = await runWebSearch(provider, "q", 5);

		expect(outcome.ok && outcome.results[0].snippet).toHaveLength(500);
	});

	it("answers SEARCH_FAILED without echoing the provider's error", async () => {
		const provider = searcher(async () => {
			throw new Error("upstream rejected query 'secret plans'");
		});

		const outcome = await runWebSearch(provider, "secret plans", 5);

		expect(outcome).toMatchObject({
			ok: false,
			status: 502,
			code: "SEARCH_FAILED",
		});
		expect(JSON.stringify(outcome)).not.toContain("secret plans");
	});

	it("stops a search that runs past the time limit", async () => {
		vi.useFakeTimers();
		const provider = searcher(() => new Promise(() => {}));

		const pending = runWebSearch(provider, "q", 5);
		await vi.advanceTimersByTimeAsync(PROVIDER_CALL_TIMEOUT_MS);

		await expect(pending).resolves.toMatchObject({
			ok: false,
			code: "SEARCH_FAILED",
			logKind: "timeout",
		});
	});
});

describe("runReadUrl", () => {
	it("returns the page with its final URL, title and publisher host", async () => {
		const reader = scraper(async () => page("Body text"));

		const outcome = await runReadUrl(reader, REQUEST, NO_TERMS);

		expect(reader.scrapeUrl).toHaveBeenCalledWith(REQUEST.href, {
			timeoutMs: PROVIDER_CALL_TIMEOUT_MS,
		});
		expect(outcome).toEqual({
			ok: true,
			url: REQUEST.href,
			finalUrl: "https://www.example.net/report",
			title: "Annual report",
			publisher: "example.net",
			content: "Body text",
			truncated: false,
		});
	});

	it("keeps text of exactly the limit whole", async () => {
		const text = "a".repeat(MAX_PAGE_CONTENT_LENGTH);
		const outcome = await runReadUrl(
			scraper(async () => page(text)),
			REQUEST,
			NO_TERMS,
		);

		expect(outcome).toMatchObject({ content: text, truncated: false });
	});

	it("cuts longer text to the limit and says so", async () => {
		const outcome = await runReadUrl(
			scraper(async () => page("a".repeat(MAX_PAGE_CONTENT_LENGTH + 1))),
			REQUEST,
			NO_TERMS,
		);

		expect(outcome.ok && outcome.content).toHaveLength(
			MAX_PAGE_CONTENT_LENGTH,
		);
		expect(outcome).toMatchObject({ truncated: true });
	});

	it("does not split a surrogate pair at the cut", async () => {
		const text = `${"a".repeat(MAX_PAGE_CONTENT_LENGTH - 1)}😀tail`;
		const outcome = await runReadUrl(
			scraper(async () => page(text)),
			REQUEST,
			NO_TERMS,
		);

		expect(outcome.ok && outcome.content).toBe(
			"a".repeat(MAX_PAGE_CONTENT_LENGTH - 1),
		);
	});

	it("leaves the title out when the provider has none", async () => {
		const outcome = await runReadUrl(
			scraper(async () => page("Body", { pageTitle: null })),
			REQUEST,
			NO_TERMS,
		);

		expect(outcome).not.toHaveProperty("title");
	});

	it("reports the provider's final address after a redirect", async () => {
		const outcome = await runReadUrl(
			scraper(async () =>
				page("Body", { pageUrl: "https://www.cdn.example.org/moved" }),
			),
			REQUEST,
			NO_TERMS,
		);

		expect(outcome).toMatchObject({
			url: REQUEST.href,
			finalUrl: "https://www.cdn.example.org/moved",
			publisher: "cdn.example.org",
		});
	});

	it("falls back to the requested URL when the provider reports none", async () => {
		const outcome = await runReadUrl(
			scraper(async () => page("Body", { pageUrl: "" })),
			REQUEST,
			NO_TERMS,
		);

		expect(outcome).toMatchObject({ ok: true, finalUrl: REQUEST.href });
	});

	it.each([
		["not a URL", "not a url", "invalid"],
		["not http(s)", "ftp://files.example.net/report", "scheme"],
	])(
		"refuses content when the reported address is %s",
		async (_label, pageUrl, reason) => {
			const outcome = await runReadUrl(
				scraper(async () => page("Body text", { pageUrl })),
				REQUEST,
				NO_TERMS,
			);

			expect(outcome).toMatchObject({
				ok: false,
				status: 422,
				code: "URL_NOT_ALLOWED",
				reason,
			});
			expect(JSON.stringify(outcome)).not.toContain("Body text");
		},
	);

	it("refuses content after a redirect to a disallowed address", async () => {
		const outcome = await runReadUrl(
			scraper(async () =>
				page("internal secrets", { pageUrl: "http://127.0.0.1/admin" }),
			),
			REQUEST,
			NO_TERMS,
		);

		expect(outcome).toMatchObject({
			ok: false,
			status: 422,
			code: "URL_NOT_ALLOWED",
			reason: "ip_literal",
		});
		expect(JSON.stringify(outcome)).not.toContain("internal secrets");
	});

	it("refuses content after a redirect to an address that names the client", async () => {
		const outcome = await runReadUrl(
			scraper(async () =>
				page("Body", {
					pageUrl: "https://news.example.net/companies/contoso",
				}),
			),
			REQUEST,
			buildConfidentialMatcher({ clientName: "Contoso" }),
		);

		expect(outcome).toMatchObject({
			ok: false,
			status: 422,
			code: "URL_NOT_ALLOWED",
			reason: "confidential_term",
		});
	});

	it.each<WebScrapeErrorCode>([
		"ROBOTS_BLOCKED",
		"QUOTA_EXCEEDED",
		"TIMEOUT",
		"UNAUTHORIZED",
		"UNSUPPORTED_CONTENT_TYPE",
		"UNKNOWN",
	])("answers FETCH_FAILED with a fixed message for %s", async (code) => {
		const outcome = await runReadUrl(
			scraper(async () => ({
				success: false,
				error: { code, message: `provider said ${REQUEST.href}` },
			})),
			REQUEST,
			NO_TERMS,
		);

		expect(outcome).toMatchObject({
			ok: false,
			status: 502,
			code: "FETCH_FAILED",
			logKind: code,
		});
		expect(JSON.stringify(outcome)).not.toContain("provider said");
	});

	it.each(["", "   \n\t "])(
		"answers FETCH_FAILED for a page with no readable text (%j)",
		async (markdown) => {
			const outcome = await runReadUrl(
				scraper(async () => page(markdown)),
				REQUEST,
				NO_TERMS,
			);

			expect(outcome).toMatchObject({
				ok: false,
				code: "FETCH_FAILED",
				logKind: "empty",
			});
		},
	);

	it("answers FETCH_FAILED when the provider throws", async () => {
		const outcome = await runReadUrl(
			scraper(async () => {
				throw new TypeError("fetch failed");
			}),
			REQUEST,
			NO_TERMS,
		);

		expect(outcome).toMatchObject({
			ok: false,
			code: "FETCH_FAILED",
			logKind: "TypeError",
		});
	});

	it("stops a read that runs past the time limit", async () => {
		vi.useFakeTimers();
		const pending = runReadUrl(
			scraper(() => new Promise(() => {})),
			REQUEST,
			NO_TERMS,
		);
		await vi.advanceTimersByTimeAsync(PROVIDER_CALL_TIMEOUT_MS);

		await expect(pending).resolves.toMatchObject({
			ok: false,
			code: "FETCH_FAILED",
			logKind: "timeout",
		});
	});
});
