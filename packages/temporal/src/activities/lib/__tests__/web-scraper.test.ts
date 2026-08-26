/**
 * WebScraper adapters — unit tests (URL Context Sources, commit 3 of 3).
 *
 * Covers all four scrape-capable adapters (`firecrawl`, `jina`, `tavily`,
 * `exa`) plus the picker / capability helpers. `fetch` is stubbed per-test
 * so we never hit the network.
 *
 * Assertions per adapter:
 *   1. Outbound request shape — URL, method, auth header, body.
 *   2. Happy path returns `{ success: true, data: { pageUrl, pageTitle,
 *      markdown } }` in the unified shape.
 *   3. Error mapping — at least UNAUTHORIZED (401) + QUOTA_EXCEEDED (429)
 *      to prove the typed-error contract holds.
 *
 * Firecrawl is exercised via the adapter wrapping the legacy client, not by
 * re-testing the client (that already has its own test file).
 */
import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { createExaScraper } from "../scrapers/exa-scraper";
import { createFirecrawlScraper } from "../scrapers/firecrawl-scraper";
import { createJinaScraper } from "../scrapers/jina-scraper";
import { createTavilyScraper } from "../scrapers/tavily-scraper";
import {
	isCrawlCapableProvider,
	isScrapeCapableProvider,
	SCRAPE_CAPABLE_PROVIDERS,
	supportsCrawl,
	WEB_SCRAPER_DISPLAY_NAMES,
} from "../web-scraper";

interface FetchCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function captureFetch(queue: Response[]): {
	mock: MockInstance;
	calls: FetchCall[];
} {
	const calls: FetchCall[] = [];
	const local = [...queue];
	const mock = vi.spyOn(globalThis, "fetch").mockImplementation((async (
		input: string,
		init?: RequestInit,
	) => {
		const headers = init?.headers as Record<string, string> | undefined;
		const rawBody = init?.body;
		let parsedBody: unknown;
		if (typeof rawBody === "string") {
			try {
				parsedBody = JSON.parse(rawBody);
			} catch {
				parsedBody = rawBody;
			}
		}
		calls.push({
			url: input,
			method: init?.method ?? "GET",
			headers: headers ?? {},
			body: parsedBody,
		});
		const next = local.shift();
		if (!next) {
			throw new Error("fetch called more times than expected");
		}
		return next;
	}) as unknown as typeof fetch);
	return { mock, calls };
}

afterEach(() => {
	vi.restoreAllMocks();
});

// ── Capability helpers ──────────────────────────────────────────────────────

describe("WebScraper capability helpers", () => {
	it("flags exactly the four scrape-capable providers", () => {
		expect(isScrapeCapableProvider("firecrawl")).toBe(true);
		expect(isScrapeCapableProvider("jina")).toBe(true);
		expect(isScrapeCapableProvider("tavily")).toBe(true);
		expect(isScrapeCapableProvider("exa")).toBe(true);
		expect(isScrapeCapableProvider("parallel")).toBe(false);
		expect(isScrapeCapableProvider("youtube")).toBe(false);
	});

	it("flags only Firecrawl as crawl-capable", () => {
		expect(isCrawlCapableProvider("firecrawl")).toBe(true);
		expect(isCrawlCapableProvider("jina")).toBe(false);
		expect(isCrawlCapableProvider("tavily")).toBe(false);
		expect(isCrawlCapableProvider("exa")).toBe(false);
	});

	it("supportsCrawl narrows by presence of crawlSite", () => {
		const fc = createFirecrawlScraper("k");
		const jina = createJinaScraper("k");
		expect(supportsCrawl(fc)).toBe(true);
		expect(supportsCrawl(jina)).toBe(false);
	});

	it("exposes display names for every provider name", () => {
		for (const name of SCRAPE_CAPABLE_PROVIDERS) {
			expect(WEB_SCRAPER_DISPLAY_NAMES[name]).toMatch(/.+/);
		}
		expect(WEB_SCRAPER_DISPLAY_NAMES.parallel).toBe("Parallel");
	});
});

// ── Firecrawl adapter ───────────────────────────────────────────────────────

describe("Firecrawl WebScraper adapter", () => {
	it("delegates scrape to the legacy client and yields the unified page shape", async () => {
		const { calls } = captureFetch([
			jsonResponse({
				success: true,
				data: {
					markdown: "# Hello",
					metadata: {
						title: "Hello",
						sourceURL: "https://example.com/canonical",
					},
				},
			}),
		]);

		const result = await createFirecrawlScraper("fc-key").scrapeUrl(
			"https://example.com/article",
		);
		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("expected success");
		}
		expect(result.data).toEqual({
			pageUrl: "https://example.com/canonical",
			pageTitle: "Hello",
			markdown: "# Hello",
		});
		expect(calls[0]?.url).toBe("https://api.firecrawl.dev/v1/scrape");
		expect(calls[0]?.headers.Authorization).toBe("Bearer fc-key");
	});

	it("maps Firecrawl 401 to UNAUTHORIZED (via statusCode promotion)", async () => {
		captureFetch([new Response("", { status: 401 })]);

		const result = await createFirecrawlScraper("bad-key").scrapeUrl(
			"https://example.com",
		);
		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("expected failure");
		}
		expect(result.error.code).toBe("UNAUTHORIZED");
		expect(result.error.statusCode).toBe(401);
	});

	it("maps Firecrawl 429 to QUOTA_EXCEEDED", async () => {
		captureFetch([new Response("", { status: 429 })]);

		const result = await createFirecrawlScraper("k").scrapeUrl(
			"https://example.com",
		);
		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("expected failure");
		}
		expect(result.error.code).toBe("QUOTA_EXCEEDED");
	});
});

// ── Jina adapter ────────────────────────────────────────────────────────────

describe("Jina WebScraper adapter", () => {
	it("GETs r.jina.ai/<url> with Bearer auth and returns the JSON envelope content", async () => {
		const { calls } = captureFetch([
			jsonResponse({
				code: 200,
				data: {
					title: "Doc page",
					content: "# Doc page\n\nHello",
					url: "https://example.com/docs",
				},
			}),
		]);

		const result = await createJinaScraper("jina-key").scrapeUrl(
			"https://example.com/docs",
		);
		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("expected success");
		}
		expect(result.data).toEqual({
			pageUrl: "https://example.com/docs",
			pageTitle: "Doc page",
			markdown: "# Doc page\n\nHello",
		});
		expect(calls[0]?.url).toBe(
			"https://r.jina.ai/https://example.com/docs",
		);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.headers.Authorization).toBe("Bearer jina-key");
		expect(calls[0]?.headers.Accept).toBe("application/json");
	});

	it("maps Jina 403 to UNAUTHORIZED", async () => {
		captureFetch([new Response("forbidden", { status: 403 })]);
		const result = await createJinaScraper("bad").scrapeUrl(
			"https://example.com",
		);
		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("expected failure");
		}
		expect(result.error.code).toBe("UNAUTHORIZED");
		expect(result.error.statusCode).toBe(403);
	});

	it("maps Jina 429 to QUOTA_EXCEEDED", async () => {
		captureFetch([new Response("", { status: 429 })]);
		const result = await createJinaScraper("k").scrapeUrl(
			"https://example.com",
		);
		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("expected failure");
		}
		expect(result.error.code).toBe("QUOTA_EXCEEDED");
	});

	it("does not expose crawlSite (single-page only)", () => {
		expect(createJinaScraper("k").crawlSite).toBeUndefined();
	});
});

// ── Tavily adapter ──────────────────────────────────────────────────────────

describe("Tavily WebScraper adapter", () => {
	it("POSTs to /extract with the URL wrapped in an array + extract_depth=advanced", async () => {
		const { calls } = captureFetch([
			jsonResponse({
				results: [
					{
						url: "https://example.com/article",
						title: "Article",
						raw_content: "Body text.",
					},
				],
			}),
		]);

		const result = await createTavilyScraper("tv-key").scrapeUrl(
			"https://example.com/article",
		);
		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("expected success");
		}
		expect(result.data).toEqual({
			pageUrl: "https://example.com/article",
			pageTitle: "Article",
			markdown: "Body text.",
		});
		expect(calls[0]?.url).toBe("https://api.tavily.com/extract");
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.headers.Authorization).toBe("Bearer tv-key");
		expect(calls[0]?.body).toEqual({
			urls: ["https://example.com/article"],
			extract_depth: "advanced",
		});
	});

	it("maps Tavily 401 to UNAUTHORIZED and 402 to QUOTA_EXCEEDED", async () => {
		captureFetch([new Response("", { status: 401 })]);
		const r1 = await createTavilyScraper("bad").scrapeUrl(
			"https://example.com",
		);
		expect(r1.success).toBe(false);
		if (r1.success) {
			throw new Error("expected failure");
		}
		expect(r1.error.code).toBe("UNAUTHORIZED");

		captureFetch([new Response("", { status: 402 })]);
		const r2 = await createTavilyScraper("k").scrapeUrl(
			"https://example.com",
		);
		expect(r2.success).toBe(false);
		if (r2.success) {
			throw new Error("expected failure");
		}
		expect(r2.error.code).toBe("QUOTA_EXCEEDED");
	});

	it("surfaces failed_results as ROBOTS_BLOCKED when message mentions robots", async () => {
		captureFetch([
			jsonResponse({
				results: [],
				failed_results: [
					{
						url: "https://example.com",
						error: "Blocked by robots.txt",
					},
				],
			}),
		]);
		const result = await createTavilyScraper("k").scrapeUrl(
			"https://example.com",
		);
		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("expected failure");
		}
		expect(result.error.code).toBe("ROBOTS_BLOCKED");
	});

	it("does not expose crawlSite (single-page only)", () => {
		expect(createTavilyScraper("k").crawlSite).toBeUndefined();
	});
});

// ── Exa adapter ─────────────────────────────────────────────────────────────

describe("Exa WebScraper adapter", () => {
	it("POSTs to /contents with x-api-key + urls array + text:true", async () => {
		const { calls } = captureFetch([
			jsonResponse({
				results: [
					{
						id: "abc",
						url: "https://example.com/article",
						title: "Article",
						text: "Body text.",
					},
				],
			}),
		]);

		const result = await createExaScraper("exa-key").scrapeUrl(
			"https://example.com/article",
		);
		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("expected success");
		}
		expect(result.data).toEqual({
			pageUrl: "https://example.com/article",
			pageTitle: "Article",
			markdown: "Body text.",
		});
		expect(calls[0]?.url).toBe("https://api.exa.ai/contents");
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.headers["x-api-key"]).toBe("exa-key");
		expect(calls[0]?.body).toEqual({
			urls: ["https://example.com/article"],
			text: true,
		});
	});

	it("maps Exa 403 to UNAUTHORIZED", async () => {
		captureFetch([new Response("", { status: 403 })]);
		const result = await createExaScraper("bad").scrapeUrl(
			"https://example.com",
		);
		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("expected failure");
		}
		expect(result.error.code).toBe("UNAUTHORIZED");
	});

	it("returns UNKNOWN when results array is empty and no robots hint", async () => {
		captureFetch([jsonResponse({ results: [] })]);
		const result = await createExaScraper("k").scrapeUrl(
			"https://example.com",
		);
		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("expected failure");
		}
		expect(result.error.code).toBe("UNKNOWN");
	});

	it("does not expose crawlSite (single-page only)", () => {
		expect(createExaScraper("k").crawlSite).toBeUndefined();
	});
});
