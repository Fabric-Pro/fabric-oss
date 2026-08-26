/**
 * Firecrawl client wrapper — unit tests.
 *
 * `fetch` is stubbed per-test so we never hit the network. Each test
 * asserts at least one of: URL, headers, body, and the typed-error
 * mapping the UI / activities switch on.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import {
	crawlSite,
	filterByIncludePaths,
	sameSiteOrigin,
	scrapeUrl,
} from "../firecrawl-client";

const SCRAPE_URL = "https://api.firecrawl.dev/v1/scrape";
const MAP_URL = "https://api.firecrawl.dev/v1/map";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { "Content-Type": "application/json" },
	});
}

function emptyResponse(status: number): Response {
	return new Response("", { status });
}

interface FetchCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

function captureFetch(
	responses: Response[] | ((call: FetchCall) => Response | Promise<Response>),
): { mock: MockInstance; calls: FetchCall[] } {
	const calls: FetchCall[] = [];

	const queue = Array.isArray(responses) ? [...responses] : null;

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
		const call: FetchCall = {
			url: input,
			method: init?.method ?? "GET",
			headers: headers ?? {},
			body: parsedBody,
		};
		calls.push(call);
		if (queue) {
			const next = queue.shift();
			if (!next) {
				throw new Error(
					`fetch called more times than expected (call #${calls.length})`,
				);
			}
			return next;
		}
		return await (
			responses as (call: FetchCall) => Response | Promise<Response>
		)(call);
	}) as unknown as typeof fetch);

	return { mock, calls };
}

describe("scrapeUrl", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("posts to /v1/scrape with bearer token + JSON body and returns a normalised page", async () => {
		const { calls } = captureFetch([
			jsonResponse({
				success: true,
				data: {
					markdown: "# Hello",
					metadata: {
						title: "Hello",
						sourceURL: "https://example.com/welcome",
						etag: 'W/"abc"',
						lastModified: "Wed, 21 Oct 2025 07:28:00 GMT",
					},
				},
			}),
		]);

		const result = await scrapeUrl("https://example.com", {
			apiKey: "fc-secret",
			formats: ["markdown", "html"],
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(SCRAPE_URL);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].headers.Authorization).toBe("Bearer fc-secret");
		expect(calls[0].headers["Content-Type"]).toBe("application/json");
		// Per commit "DOM-aware wait + 5min scrape timeout": every scrape call
		// must use the content-selector wait (Firecrawl waits for the actual
		// content element to hydrate rather than a fixed time) and strip
		// sidebar chrome so help centers (Zendesk, Intercom, etc.) don't
		// return just the "Articles in this section" widget.
		expect(calls[0].body).toMatchObject({
			url: "https://example.com",
			formats: ["markdown", "html"],
			// `onlyMainContent: false` is intentional — Firecrawl's Readability
			// algorithm picks the sidebar over the article body on Zendesk-style
			// help centers (verified directly against a live Zendesk help-
			// center URL). We own the chrome stripping via excludeTags.
			// See FIRECRAWL_EXCLUDE_TAGS comment.
			onlyMainContent: false,
			// Explicit per-page Firecrawl timeout — 5 min.
			timeout: 300_000,
		});
		const body0 = calls[0].body as Record<string, unknown>;

		// The wait selector list is platform-agnostic — we don't pin the
		// exact string (otherwise adding a new platform breaks the test for
		// no real reason). We assert the SHAPE plus the must-have entries
		// per design rules in FIRECRAWL_CONTENT_WAIT_SELECTOR:
		//   - No bare semantic shells (`article`, `main`, `[role='main']`)
		//     that match SSR-empty containers — that was the Zendesk-
		//     help-center regression.
		//   - A coverage floor: at least one selector per major family
		//     (help-center, schema.org, blog/CMS, forum, docs framework).
		const actions = body0.actions as Array<{
			type: string;
			selector: string;
		}>;
		expect(actions).toHaveLength(1);
		expect(actions[0].type).toBe("wait");
		const selector = actions[0].selector;
		// Coverage floor — one selector per family must be present.
		expect(selector).toContain(".article-body"); // Zendesk help center
		expect(selector).toContain("[itemprop='articleBody']"); // schema.org
		expect(selector).toContain(".entry-content"); // WordPress / CMS
		expect(selector).toContain(".user-content"); // Discourse / forums
		expect(selector).toContain(".markdown-body"); // GitHub / MkDocs
		expect(selector).toContain(".theme-doc-markdown"); // Docusaurus
		expect(selector).toContain(".wiki-content"); // Confluence
		// Forbidden-shells guard — these match SSR-empty containers and would
		// reintroduce the "nav-widget-only" regression on Zendesk-style sites.
		expect(selector.split(/,\s*/)).not.toContain("article");
		expect(selector.split(/,\s*/)).not.toContain("main");
		expect(selector.split(/,\s*/)).not.toContain("[role='main']");

		// excludeTags must include page-chrome classes/roles but MUST NOT
		// include bare `header`, `footer`, or `aside` — those appear inside
		// article wrappers on Zendesk / docs templates and stripping them
		// removes the body. Verified directly: adding bare `header,footer,
		// aside` collapsed the Zendesk-help-center scrape to the sidebar widget.
		const excludeTags = body0.excludeTags as string[];
		expect(excludeTags).toEqual(
			expect.arrayContaining([
				"nav",
				"script",
				"style",
				"[role='navigation']",
				"[role='banner']",
				"[role='contentinfo']",
				".articles-in-section",
				".article-sidebar",
			]),
		);
		// Forbidden-bare-tags guard — these match elements INSIDE article
		// wrappers on common help-center / docs templates. Stripping them
		// took the body with them in our direct Firecrawl tests.
		expect(excludeTags).not.toContain("header");
		expect(excludeTags).not.toContain("footer");
		expect(excludeTags).not.toContain("aside");
		// `waitFor` is now a deliberate 2 s settle delay applied BEFORE the
		// selector action, covering pages that don't expose any of the strict
		// body classes (generic CMS landings, etc.).
		expect(body0.waitFor).toBe(2000);

		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("unreachable");
		}
		expect(result.data).toEqual({
			pageUrl: "https://example.com/welcome",
			pageTitle: "Hello",
			markdown: "# Hello",
			etag: 'W/"abc"',
			lastModifiedHeader: "Wed, 21 Oct 2025 07:28:00 GMT",
		});
	});

	it("falls back to the requested URL when Firecrawl omits sourceURL", async () => {
		captureFetch([
			jsonResponse({
				success: true,
				data: { markdown: "body", metadata: {} },
			}),
		]);

		const result = await scrapeUrl("https://example.com/x", {
			apiKey: "fc-secret",
		});

		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("unreachable");
		}
		expect(result.data.pageUrl).toBe("https://example.com/x");
		expect(result.data.pageTitle).toBeNull();
		expect(result.data.etag).toBeUndefined();
	});

	it("maps 401 (bad key) to UNKNOWN with a 'rejected the API key' message", async () => {
		captureFetch([emptyResponse(401)]);

		const result = await scrapeUrl("https://example.com", {
			apiKey: "bad",
		});

		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("unreachable");
		}
		expect(result.error.code).toBe("UNKNOWN");
		expect(result.error.statusCode).toBe(401);
		expect(result.error.message).toMatch(/API key/i);
	});

	it("maps 402 (out of credits) to QUOTA_EXCEEDED with plan-mention copy", async () => {
		captureFetch([emptyResponse(402)]);

		const result = await scrapeUrl("https://example.com", {
			apiKey: "fc-secret",
		});

		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("unreachable");
		}
		expect(result.error.code).toBe("QUOTA_EXCEEDED");
		expect(result.error.statusCode).toBe(402);
		expect(result.error.message).toMatch(/firecrawl plan/i);
	});

	it("maps 429 (rate limited) to QUOTA_EXCEEDED", async () => {
		captureFetch([emptyResponse(429)]);

		const result = await scrapeUrl("https://example.com", {
			apiKey: "fc-secret",
		});

		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("unreachable");
		}
		expect(result.error.code).toBe("QUOTA_EXCEEDED");
		expect(result.error.statusCode).toBe(429);
	});

	it("maps body-level robots-blocked errors to ROBOTS_BLOCKED", async () => {
		captureFetch([
			jsonResponse({
				success: false,
				error: "URL is blocked by robots.txt",
			}),
		]);

		const result = await scrapeUrl("https://example.com", {
			apiKey: "fc-secret",
		});

		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("unreachable");
		}
		expect(result.error.code).toBe("ROBOTS_BLOCKED");
		expect(result.error.message).toMatch(/robots/i);
	});

	it("maps 500 to UNKNOWN with the status code attached", async () => {
		captureFetch([
			jsonResponse(
				{ success: false, error: "internal" },
				{ status: 500 },
			),
		]);

		const result = await scrapeUrl("https://example.com", {
			apiKey: "fc-secret",
		});

		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("unreachable");
		}
		expect(result.error.code).toBe("UNKNOWN");
		expect(result.error.statusCode).toBe(500);
	});

	it("maps an unsupported binary content type to UNSUPPORTED_CONTENT_TYPE", async () => {
		captureFetch([
			jsonResponse(
				{
					success: false,
					error: "The URL returned a file type that Firecrawl cannot process: image/svg+xml. Firecrawl supports HTML web pages, PDFs, and common document formats. Binary files like images, videos, executables, and archives are not supported.",
				},
				{ status: 400 },
			),
		]);

		const result = await scrapeUrl("https://example.com/logo.svg", {
			apiKey: "fc-secret",
		});

		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("unreachable");
		}
		expect(result.error.code).toBe("UNSUPPORTED_CONTENT_TYPE");
		expect(result.error.statusCode).toBe(400);
		expect(result.error.message).toMatch(/image\/svg\+xml/);
	});

	it("returns TIMEOUT when the request is aborted", async () => {
		captureFetch(async () => {
			const aborted = new Error("aborted");
			aborted.name = "AbortError";
			throw aborted;
		});

		const result = await scrapeUrl("https://example.com", {
			apiKey: "fc-secret",
			timeoutMs: 10,
		});

		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("unreachable");
		}
		expect(result.error.code).toBe("TIMEOUT");
	});
});

/**
 * `crawlSite` was originally a `/v1/crawl` polling loop. It's now a two-step
 * map + per-URL scrape pipeline (see the firecrawl-client.ts header on
 * `crawlSite`). The tests below cover the new shape:
 *
 *   - /v1/map is called first, then /v1/scrape per URL (no polling).
 *   - Concurrency capped at DEFAULT_CRAWL_SCRAPE_CONCURRENCY (= 5).
 *   - Promise.allSettled isolation: per-URL failures don't fail the crawl.
 *   - Map-level failures (4xx, robots, malformed) short-circuit to error.
 *   - Zero-URL fallback: empty map -> single scrapeUrl of the requested URL.
 *   - filterByIncludePaths handles Zendesk-style hierarchies + globs.
 */
describe("crawlSite (map + per-URL scrape)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("calls /v1/map first, then /v1/scrape per discovered URL", async () => {
		// 1 map + 2 scrape responses (one per discovered URL).
		const { calls } = captureFetch(async (call) => {
			if (call.url === MAP_URL) {
				return jsonResponse({
					success: true,
					links: [
						"https://example.com/docs/intro",
						"https://example.com/docs/api",
					],
				});
			}
			if (call.url === SCRAPE_URL) {
				const body = call.body as { url: string };
				return jsonResponse({
					success: true,
					data: {
						markdown: `# ${body.url}`,
						metadata: { sourceURL: body.url, title: body.url },
					},
				});
			}
			throw new Error(`unexpected url: ${call.url}`);
		});

		const result = await crawlSite("https://example.com/docs", {
			apiKey: "fc-secret",
			limit: 100,
		});

		// 1 map + 2 scrapes
		const mapCalls = calls.filter((c) => c.url === MAP_URL);
		const scrapeCalls = calls.filter((c) => c.url === SCRAPE_URL);
		expect(mapCalls).toHaveLength(1);
		expect(scrapeCalls).toHaveLength(2);

		// /v1/map body — sitemap-aware discovery
		expect(mapCalls[0].method).toBe("POST");
		expect(mapCalls[0].headers.Authorization).toBe("Bearer fc-secret");
		expect(mapCalls[0].body).toMatchObject({
			url: "https://example.com/docs",
			includeSubdomains: false,
			limit: 100,
			search: "",
		});

		// Each scrape gets the full deep-content scrapeOptions (smart-wait
		// actions + excludeTags + explicit timeout) per-URL — guaranteed by
		// going through scrapeUrl().
		for (const sc of scrapeCalls) {
			expect(sc.body).toMatchObject({
				// Same `onlyMainContent: false` story as scrapeUrl — Readability
				// picks the sidebar on Zendesk-style help centers.
				onlyMainContent: false,
				timeout: 300_000,
			});
			const scBody = sc.body as Record<string, unknown>;
			// Selector list is platform-agnostic; assert shape + coverage
			// floor + forbidden-shells guard (mirrors the scrapeUrl test).
			const scActions = scBody.actions as Array<{
				type: string;
				selector: string;
			}>;
			expect(scActions).toHaveLength(1);
			expect(scActions[0].type).toBe("wait");
			const scSelector = scActions[0].selector;
			expect(scSelector).toContain(".article-body");
			expect(scSelector).toContain("[itemprop='articleBody']");
			expect(scSelector).toContain(".markdown-body");
			expect(scSelector.split(/,\s*/)).not.toContain("article");
			expect(scSelector.split(/,\s*/)).not.toContain("main");
			// Same forbidden-bare-tags / required-classes rules as scrapeUrl.
			const scExcludes = scBody.excludeTags as string[];
			expect(scExcludes).toEqual(
				expect.arrayContaining([
					"nav",
					"script",
					"[role='navigation']",
					".articles-in-section",
				]),
			);
			expect(scExcludes).not.toContain("header");
			expect(scExcludes).not.toContain("footer");
			expect(scExcludes).not.toContain("aside");
			// 2 s settle delay deliberately applied before the selector wait
			// (mirrors scrapeUrl). Covers landing pages without strict body
			// classes — see FIRECRAWL_SETTLE_DELAY_MS in firecrawl-client.ts.
			expect(scBody.waitFor).toBe(2000);
		}

		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("unreachable");
		}
		expect(result.data).toHaveLength(2);
		// Order may vary because of concurrency — assert by set.
		const urls = result.data.map((p) => p.pageUrl).sort();
		expect(urls).toEqual([
			"https://example.com/docs/api",
			"https://example.com/docs/intro",
		]);
	});

	it("caps concurrent scrapes at the documented limit (5)", async () => {
		// 12 discovered URLs — large enough to exercise the cap.
		const urls = Array.from(
			{ length: 12 },
			(_, i) => `https://example.com/docs/p${i}`,
		);

		let inFlight = 0;
		let maxInFlight = 0;

		captureFetch(async (call) => {
			if (call.url === MAP_URL) {
				return jsonResponse({ success: true, links: urls });
			}
			// /v1/scrape — measure concurrency by counting overlap.
			inFlight += 1;
			if (inFlight > maxInFlight) {
				maxInFlight = inFlight;
			}
			// Yield to the microtask queue so the cap is observable.
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight -= 1;
			const body = call.body as { url: string };
			return jsonResponse({
				success: true,
				data: {
					markdown: "ok",
					metadata: { sourceURL: body.url },
				},
			});
		});

		const result = await crawlSite("https://example.com/docs", {
			apiKey: "fc-secret",
		});

		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("unreachable");
		}
		expect(result.data).toHaveLength(12);
		expect(maxInFlight).toBeGreaterThan(0);
		expect(maxInFlight).toBeLessThanOrEqual(5);
	});

	it("isolates per-URL failures with Promise.allSettled (partial success)", async () => {
		captureFetch(async (call) => {
			if (call.url === MAP_URL) {
				return jsonResponse({
					success: true,
					links: [
						"https://example.com/docs/ok",
						"https://example.com/docs/blocked",
						"https://example.com/docs/ok2",
					],
				});
			}
			const body = call.body as { url: string };
			if (body.url === "https://example.com/docs/blocked") {
				// One bad page — must not fail the whole crawl.
				return jsonResponse({
					success: false,
					error: "URL is blocked by robots.txt",
				});
			}
			return jsonResponse({
				success: true,
				data: {
					markdown: "# ok",
					metadata: { sourceURL: body.url },
				},
			});
		});

		const result = await crawlSite("https://example.com/docs", {
			apiKey: "fc-secret",
		});

		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("unreachable");
		}
		// 2 succeeded, 1 failed — partial success.
		expect(result.data).toHaveLength(2);
		const urls = result.data.map((p) => p.pageUrl).sort();
		expect(urls).toEqual([
			"https://example.com/docs/ok",
			"https://example.com/docs/ok2",
		]);
	});

	it("returns UNKNOWN when all per-URL scrapes fail", async () => {
		captureFetch(async (call) => {
			if (call.url === MAP_URL) {
				return jsonResponse({
					success: true,
					links: [
						"https://example.com/docs/a",
						"https://example.com/docs/b",
					],
				});
			}
			return jsonResponse({
				success: false,
				error: "boom",
			});
		});

		const result = await crawlSite("https://example.com/docs", {
			apiKey: "fc-secret",
		});

		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("unreachable");
		}
		expect(result.error.code).toBe("UNKNOWN");
		expect(result.error.message).toMatch(/all 2 pages failed/i);
	});

	it("short-circuits when /v1/map itself fails (robots, quota, etc.)", async () => {
		// A robots-blocked map response — must NOT try to scrape anything.
		const { calls } = captureFetch([
			jsonResponse({
				success: false,
				error: "robots.txt disallows crawling this URL",
			}),
		]);

		const result = await crawlSite("https://example.com/docs", {
			apiKey: "fc-secret",
		});

		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("unreachable");
		}
		expect(result.error.code).toBe("ROBOTS_BLOCKED");

		// Only the map call. No scrapes.
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(MAP_URL);
	});

	it("maps 402 on /v1/map to QUOTA_EXCEEDED", async () => {
		captureFetch([emptyResponse(402)]);

		const result = await crawlSite("https://example.com/docs", {
			apiKey: "fc-secret",
		});

		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("unreachable");
		}
		expect(result.error.code).toBe("QUOTA_EXCEEDED");
		expect(result.error.statusCode).toBe(402);
	});

	it("falls back to a single scrapeUrl when /v1/map returns no links", async () => {
		// SPA without a sitemap — map returns empty. We should still index
		// the requested landing page rather than fail with empty data.
		const { calls } = captureFetch(async (call) => {
			if (call.url === MAP_URL) {
				return jsonResponse({ success: true, links: [] });
			}
			if (call.url === SCRAPE_URL) {
				return jsonResponse({
					success: true,
					data: {
						markdown: "# landing",
						metadata: {
							sourceURL: "https://example.com/app",
							title: "Acme app",
						},
					},
				});
			}
			throw new Error(`unexpected url: ${call.url}`);
		});

		const result = await crawlSite("https://example.com/app", {
			apiKey: "fc-secret",
		});

		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("unreachable");
		}
		expect(result.data).toHaveLength(1);
		expect(result.data[0].pageUrl).toBe("https://example.com/app");

		// 1 map + 1 scrape (the fallback).
		expect(calls.filter((c) => c.url === MAP_URL)).toHaveLength(1);
		expect(calls.filter((c) => c.url === SCRAPE_URL)).toHaveLength(1);
	});

	it("filters discovered URLs by includePaths and respects the limit", async () => {
		const { calls } = captureFetch(async (call) => {
			if (call.url === MAP_URL) {
				return jsonResponse({
					success: true,
					links: [
						// Match
						"https://example.com/docs/intro",
						"https://example.com/docs/api",
						// Different prefix — drop
						"https://example.com/blog/post-1",
						// Match
						"https://example.com/docs/guides/setup",
					],
				});
			}
			const body = call.body as { url: string };
			return jsonResponse({
				success: true,
				data: {
					markdown: "ok",
					metadata: { sourceURL: body.url },
				},
			});
		});

		const result = await crawlSite("https://example.com", {
			apiKey: "fc-secret",
			includePaths: ["/docs/*"],
			limit: 2,
		});

		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("unreachable");
		}
		// 3 matched the include path, but limit was 2 -> only 2 scraped.
		expect(result.data).toHaveLength(2);
		const scrapes = calls.filter((c) => c.url === SCRAPE_URL);
		expect(scrapes).toHaveLength(2);
		// /blog/* must NOT have been scraped.
		for (const sc of scrapes) {
			const u = (sc.body as { url: string }).url;
			expect(u.startsWith("https://example.com/docs/")).toBe(true);
		}
	});

	it("defaults the include filter to the requested URL's own pathname (Zendesk-style)", async () => {
		// `https://help.acme.com/hc/en-us` -> keep only URLs under /hc/en-us.
		const { calls } = captureFetch(async (call) => {
			if (call.url === MAP_URL) {
				return jsonResponse({
					success: true,
					links: [
						"https://help.acme.com/hc/en-us/categories/1",
						"https://help.acme.com/hc/en-us/articles/100",
						// Different locale — drop because the prefix doesn't match.
						"https://help.acme.com/hc/de/articles/100",
						// Marketing path — drop.
						"https://help.acme.com/pricing",
					],
				});
			}
			const body = call.body as { url: string };
			return jsonResponse({
				success: true,
				data: {
					markdown: "ok",
					metadata: { sourceURL: body.url },
				},
			});
		});

		const result = await crawlSite("https://help.acme.com/hc/en-us", {
			apiKey: "fc-secret",
		});

		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("unreachable");
		}
		const scrapes = calls.filter((c) => c.url === SCRAPE_URL);
		expect(scrapes).toHaveLength(2);
		const urls = result.data.map((p) => p.pageUrl).sort();
		expect(urls).toEqual([
			"https://help.acme.com/hc/en-us/articles/100",
			"https://help.acme.com/hc/en-us/categories/1",
		]);
	});

	it("accepts /v1/map's object-shape links variant", async () => {
		// Newer Firecrawl versions return [{ url: "..." }, ...] instead of
		// the plain string array. We must parse both shapes.
		captureFetch(async (call) => {
			if (call.url === MAP_URL) {
				return jsonResponse({
					success: true,
					links: [
						{ url: "https://example.com/docs/a", title: "A" },
						{ url: "https://example.com/docs/b" },
					],
				});
			}
			const body = call.body as { url: string };
			return jsonResponse({
				success: true,
				data: {
					markdown: "ok",
					metadata: { sourceURL: body.url },
				},
			});
		});

		const result = await crawlSite("https://example.com/docs", {
			apiKey: "fc-secret",
		});

		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("unreachable");
		}
		expect(result.data).toHaveLength(2);
	});

	it("drops off-origin URLs returned by /v1/map (same-origin guard)", async () => {
		// Belt-and-braces against /v1/map ever leaking a subdomain or co-
		// located domain. The crawl host is example.com — only that origin
		// should be scraped, even though map returned a URL on other.example.com.
		const { calls } = captureFetch(async (call) => {
			if (call.url === MAP_URL) {
				return jsonResponse({
					success: true,
					links: [
						// Off-origin — must be dropped.
						"https://other.example.com/path",
						// Same-origin — keep.
						"https://example.com/in",
					],
				});
			}
			const body = call.body as { url: string };
			return jsonResponse({
				success: true,
				data: {
					markdown: "ok",
					metadata: { sourceURL: body.url },
				},
			});
		});

		const result = await crawlSite("https://example.com", {
			apiKey: "fc-secret",
		});

		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("unreachable");
		}
		const scrapes = calls.filter((c) => c.url === SCRAPE_URL);
		expect(scrapes).toHaveLength(1);
		const scrapedUrl = (scrapes[0].body as { url: string }).url;
		expect(scrapedUrl).toBe("https://example.com/in");
		expect(result.data.map((p) => p.pageUrl)).toEqual([
			"https://example.com/in",
		]);
	});

	it("does not send a `sitemap` or `ignoreSitemap` wire key (map handles discovery)", async () => {
		// The old /v1/crawl polling impl had a `sitemap`/`ignoreSitemap`
		// translation that crashed on v1's `.strict()` schema. The new
		// map+scrape pipeline never sends those keys — the public option is
		// retained for API back-compat but ignored.
		const { calls } = captureFetch(async (call) => {
			if (call.url === MAP_URL) {
				return jsonResponse({
					success: true,
					links: ["https://example.com/p"],
				});
			}
			const body = call.body as { url: string };
			return jsonResponse({
				success: true,
				data: { markdown: "ok", metadata: { sourceURL: body.url } },
			});
		});

		await crawlSite("https://example.com", {
			apiKey: "fc-secret",
			sitemap: "skip",
		});

		const mapBody = calls.find((c) => c.url === MAP_URL)?.body as
			| Record<string, unknown>
			| undefined;
		expect(mapBody).toBeDefined();
		expect(mapBody?.sitemap).toBeUndefined();
		expect(mapBody?.ignoreSitemap).toBeUndefined();
	});
});

describe("filterByIncludePaths", () => {
	const requested = "https://help.acme.com/hc/en-us";

	it("keeps only URLs whose pathname is under the requested URL's pathname", () => {
		const filtered = filterByIncludePaths(
			[
				"https://help.acme.com/hc/en-us/categories/1",
				"https://help.acme.com/hc/en-us/articles/100",
				"https://help.acme.com/hc/de/articles/100",
				"https://help.acme.com/pricing",
			],
			requested,
		);
		expect(filtered).toEqual([
			"https://help.acme.com/hc/en-us/categories/1",
			"https://help.acme.com/hc/en-us/articles/100",
		]);
	});

	it("respects explicit includePaths over the requested URL", () => {
		const filtered = filterByIncludePaths(
			[
				"https://example.com/docs/intro",
				"https://example.com/api/v1/users",
				"https://example.com/blog/post-1",
			],
			"https://example.com",
			["/docs/*", "/api/*"],
		);
		expect(filtered).toEqual([
			"https://example.com/docs/intro",
			"https://example.com/api/v1/users",
		]);
	});

	it("applies excludePaths after the includePaths filter", () => {
		const filtered = filterByIncludePaths(
			[
				"https://example.com/docs/public/a",
				"https://example.com/docs/internal/secret",
				"https://example.com/docs/public/b",
			],
			"https://example.com",
			["/docs/*"],
			["/docs/internal/*"],
		);
		expect(filtered).toEqual([
			"https://example.com/docs/public/a",
			"https://example.com/docs/public/b",
		]);
	});

	it("drops URLs on a different origin (same-origin guard)", () => {
		// Defensive against /v1/map ever leaking subdomain entries (or sitemaps
		// listing co-located domains). Anything outside the requested URL's
		// origin must be dropped, even when the path matches.
		const filtered = filterByIncludePaths(
			[
				"https://help.acme.com/hc/en-us/articles/100",
				// Same path, different host — drop.
				"https://other.acme.com/hc/en-us/articles/200",
				// Same registrable domain but different subdomain — drop.
				"https://app.acme.com/hc/en-us/articles/300",
			],
			"https://help.acme.com/hc/en-us",
		);
		expect(filtered).toEqual([
			"https://help.acme.com/hc/en-us/articles/100",
		]);
	});

	it("de-dupes URLs and tolerates malformed entries", () => {
		const filtered = filterByIncludePaths(
			[
				"https://example.com/docs/a",
				"https://example.com/docs/a",
				"not-a-url",
				"https://example.com/docs/b",
			],
			"https://example.com",
		);
		expect(filtered).toEqual([
			"https://example.com/docs/a",
			"https://example.com/docs/b",
		]);
	});

	// Code-review bug 3 — `URL.origin` strict-equals was dropping every
	// sitemap entry on sites that mix `www.` and apex (e.g. apex sitemap
	// listing `https://acme.com/...` from a request that landed on
	// `https://www.acme.com/...`). The www.-strip equivalence keeps both
	// halves of the discovered list.
	it("treats www.<host> and <host> as the same site (bug-3 regression)", () => {
		const filtered = filterByIncludePaths(
			[
				"https://www.acme.com/docs/a",
				"https://acme.com/docs/b",
				// Different subdomain — must still be dropped.
				"https://help.acme.com/docs/c",
			],
			"https://acme.com/docs",
		);
		expect(filtered.sort()).toEqual([
			"https://acme.com/docs/b",
			"https://www.acme.com/docs/a",
		]);
	});
});

describe("sameSiteOrigin", () => {
	it("treats www.<host> as equivalent to <host>", () => {
		expect(sameSiteOrigin("https://www.acme.com", "https://acme.com")).toBe(
			true,
		);
		expect(sameSiteOrigin("https://acme.com", "https://www.acme.com")).toBe(
			true,
		);
	});

	it("keeps non-www subdomains strict (help.acme.com ≠ acme.com)", () => {
		expect(
			sameSiteOrigin("https://help.acme.com", "https://acme.com"),
		).toBe(false);
		expect(
			sameSiteOrigin("https://app.acme.com", "https://www.acme.com"),
		).toBe(false);
	});

	it("differs on protocol mismatch (https ≠ http)", () => {
		expect(sameSiteOrigin("https://acme.com", "http://acme.com")).toBe(
			false,
		);
	});

	it("differs on port mismatch", () => {
		expect(
			sameSiteOrigin("https://acme.com:8080", "https://acme.com"),
		).toBe(false);
	});

	it("returns false for unparseable inputs", () => {
		expect(sameSiteOrigin("not-a-url", "https://acme.com")).toBe(false);
		expect(sameSiteOrigin("https://acme.com", "//missing-protocol")).toBe(
			false,
		);
	});
});

/**
 * Bug 1 — the activity's start-to-close was bumped to 60 minutes but
 * `crawlSite` itself had no elapsed-time tracking inside the per-URL scrape
 * loop. We now track `Date.now() - startedAt` between batches and abort
 * remaining work when the budget runs out, returning whatever scraped so
 * far. The tests below pin that semantics down so regressions surface as
 * test failures rather than "the worker spent 4 hours on one site again".
 */
describe("crawlSite — elapsed-time budget", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("aborts the scrape queue once the overall budget is exceeded (partial success)", async () => {
		// 12 discovered URLs, batch size 5 → 3 batches. We arrange each
		// /v1/scrape to "take" some time by advancing the fake clock by
		// 40_000ms; with a 60_000ms budget the first batch fits, the
		// second blows it, and the third never starts.
		vi.useFakeTimers();
		try {
			const startMs = new Date("2026-05-13T00:00:00.000Z").getTime();
			vi.setSystemTime(new Date(startMs));

			const urls = Array.from(
				{ length: 12 },
				(_, i) => `https://example.com/docs/p${i}`,
			);

			vi.spyOn(globalThis, "fetch").mockImplementation((async (
				input: string,
				init?: RequestInit,
			) => {
				if (input === MAP_URL) {
					return jsonResponse({ success: true, links: urls });
				}
				if (input === SCRAPE_URL) {
					// Each scrape "takes" 40s of wall-clock.
					vi.setSystemTime(new Date(Date.now() + 40_000));
					const body = init?.body
						? (JSON.parse(init.body as string) as {
								url: string;
							})
						: { url: "" };
					return jsonResponse({
						success: true,
						data: {
							markdown: "ok",
							metadata: { sourceURL: body.url },
						},
					});
				}
				throw new Error(`unexpected: ${input}`);
			}) as unknown as typeof fetch);

			const result = await crawlSite("https://example.com/docs", {
				apiKey: "fc-secret",
				timeoutMs: 60_000,
			});

			expect(result.success).toBe(true);
			if (!result.success) {
				throw new Error("unreachable");
			}
			// At least one batch completes and at least one is skipped — the
			// exact count depends on `DEFAULT_CRAWL_SCRAPE_CONCURRENCY` (was
			// 5 historically; now 1 to dodge Firecrawl per-egress parallel-
			// scrape rate-limit). Asserts the budget-tracking behaviour
			// without coupling to that constant.
			expect(result.data.length).toBeGreaterThanOrEqual(1);
			expect(result.data.length).toBeLessThan(12);
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns UNKNOWN when the budget is exhausted before any page completes", async () => {
		// Budget of 0ms — every batch is skipped before it starts, no
		// pages land. Result must be `success: false` (UNKNOWN) so the
		// workflow surfaces a clean failure rather than empty data.
		captureFetch(async (call) => {
			if (call.url === MAP_URL) {
				return jsonResponse({
					success: true,
					links: ["https://example.com/p1", "https://example.com/p2"],
				});
			}
			throw new Error("scrape should not be called");
		});

		const result = await crawlSite("https://example.com", {
			apiKey: "fc-secret",
			timeoutMs: 0,
		});

		expect(result.success).toBe(false);
		if (result.success) {
			throw new Error("unreachable");
		}
		expect(result.error.code).toBe("UNKNOWN");
		expect(result.error.message).toMatch(/budget/i);
	});
});
