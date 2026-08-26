/**
 * Pure-helper tests for `url-source-crawl.ts`.
 *
 * `deriveIncludePaths` and `computeNextRefreshAt` are exported separately so
 * the workflow body stays deterministic AND we can unit-test the URL-path
 * derivation + cadence math without spinning a Temporal test environment.
 */
import { ActivityFailure, ApplicationFailure } from "@temporalio/common";
import { describe, expect, it } from "vitest";
import { filterByIncludePaths } from "../../src/activities/lib/firecrawl-client";
import {
	classifyFailureErrorType,
	classifyFailureStage,
	computeNextRefreshAt,
	deriveIncludePaths,
	extractInPrefixLinks,
} from "../../src/workflows/url-source-crawl";

describe("deriveIncludePaths", () => {
	it("derives bare prefix from a Zendesk help-center URL", () => {
		// Returns the path as a BARE prefix (no glob suffix). `matchesPrefix`
		// downstream in firecrawl-client already does "pathname === prefix OR
		// startsWith(prefix + '/')" — passing `/foo/.*` here used to make the
		// filter compare against a literal `.*` substring, dropping every
		// real URL and falling through to the root-only scrape fallback.
		expect(deriveIncludePaths("https://help.acme.com/hc/en-us")).toEqual([
			"/hc/en-us",
		]);
	});

	it("strips a trailing slash before returning the prefix", () => {
		expect(deriveIncludePaths("https://example.com/docs/api/")).toEqual([
			"/docs/api",
		]);
	});

	it("returns an empty array for a root URL", () => {
		expect(deriveIncludePaths("https://example.com/")).toEqual([]);
		expect(deriveIncludePaths("https://example.com")).toEqual([]);
	});

	it("returns an empty array for a malformed URL", () => {
		expect(deriveIncludePaths("not-a-url")).toEqual([]);
	});

	// Regression guard: this is the bug that hid behind hours of unrelated
	// "Firecrawl returns sidebar markdown" investigation. The workflow's
	// `deriveIncludePaths` USED to return `["/hc/en-us/.*"]`, which
	// `filterByIncludePaths` then compared literally — no real URL contains
	// the substring `.*`, every discovered article was dropped, and crawlSite
	// fell through to its zero-URL fallback (scrape only the root URL).
	// Locking in the end-to-end behaviour: derived prefix + filter must keep
	// article URLs that are genuinely under the requested path.
	it("derived prefix preserves article URLs through filterByIncludePaths", () => {
		const requestedUrl = "https://help.acme.com/hc/en-us";
		const includePaths = deriveIncludePaths(requestedUrl);
		const discoveredUrls = [
			"https://help.acme.com/hc/en-us",
			"https://help.acme.com/hc/en-us/articles/115000252266-How-to-Use-Reports",
			"https://help.acme.com/hc/en-us/articles/206193250-Creating-a-Live-Event-in-1-0",
			"https://help.acme.com/hc/en-us/sections/115001162206-Registration-Reports",
			// Off-prefix: must be dropped.
			"https://help.acme.com/somewhere-else",
		];
		const filtered = filterByIncludePaths(
			discoveredUrls,
			requestedUrl,
			includePaths,
		);
		// All four /hc/en-us URLs survive; the off-prefix one is dropped.
		expect(filtered).toHaveLength(4);
		expect(filtered).toContain(
			"https://help.acme.com/hc/en-us/articles/115000252266-How-to-Use-Reports",
		);
		expect(filtered).not.toContain("https://help.acme.com/somewhere-else");
	});
});

describe("computeNextRefreshAt", () => {
	const nowMs = 1_700_000_000_000;

	it("returns null for ONCE", () => {
		expect(computeNextRefreshAt("ONCE", nowMs)).toBeNull();
	});

	it("returns null for LIVE", () => {
		expect(computeNextRefreshAt("LIVE", nowMs)).toBeNull();
	});

	it("returns null for undefined mode", () => {
		expect(computeNextRefreshAt(undefined, nowMs)).toBeNull();
	});

	it("adds 24h for DAILY", () => {
		const result = computeNextRefreshAt("DAILY", nowMs);
		expect(result).toBeInstanceOf(Date);
		expect(result?.getTime()).toBe(nowMs + 24 * 60 * 60 * 1000);
	});

	it("adds 7 days for WEEKLY", () => {
		const result = computeNextRefreshAt("WEEKLY", nowMs);
		expect(result?.getTime()).toBe(nowMs + 7 * 24 * 60 * 60 * 1000);
	});

	it("adds 30 days for MONTHLY", () => {
		const result = computeNextRefreshAt("MONTHLY", nowMs);
		expect(result?.getTime()).toBe(nowMs + 30 * 24 * 60 * 60 * 1000);
	});
});

describe("classifyFailureStage / classifyFailureErrorType (Group 10.1 telemetry)", () => {
	const mkActivityFailure = (activityType: string, cause?: Error) =>
		new ActivityFailure(
			"activity failed",
			activityType,
			"act_1",
			0 as never, // RetryState enum — value not used by classifier
			undefined,
			cause,
		);

	it("classifies firecrawlScrapeActivity as firecrawl-scrape", () => {
		expect(
			classifyFailureStage(mkActivityFailure("firecrawlScrapeActivity")),
		).toBe("firecrawl-scrape");
	});

	it("classifies firecrawlCrawlActivity as firecrawl-crawl", () => {
		expect(
			classifyFailureStage(mkActivityFailure("firecrawlCrawlActivity")),
		).toBe("firecrawl-crawl");
	});

	it("classifies embedUrlPageActivity as embed", () => {
		expect(
			classifyFailureStage(mkActivityFailure("embedUrlPageActivity")),
		).toBe("embed");
	});

	it("classifies upsertUrlPageActivity as upsert", () => {
		expect(
			classifyFailureStage(mkActivityFailure("upsertUrlPageActivity")),
		).toBe("upsert");
	});

	it("classifies unknown errors as unknown stage", () => {
		expect(classifyFailureStage(new Error("boom"))).toBe("unknown");
		expect(classifyFailureStage("string error")).toBe("unknown");
	});

	it("classifies FIRECRAWL_ROBOTS_BLOCKED as ROBOTS_BLOCKED", () => {
		const failure = mkActivityFailure(
			"firecrawlCrawlActivity",
			ApplicationFailure.nonRetryable(
				"robots disallows",
				"FIRECRAWL_ROBOTS_BLOCKED",
			),
		);
		expect(classifyFailureErrorType(failure)).toBe("ROBOTS_BLOCKED");
	});

	it("classifies FIRECRAWL_QUOTA_EXCEEDED as QUOTA_EXCEEDED", () => {
		const failure = mkActivityFailure(
			"firecrawlCrawlActivity",
			ApplicationFailure.nonRetryable(
				"quota",
				"FIRECRAWL_QUOTA_EXCEEDED",
			),
		);
		expect(classifyFailureErrorType(failure)).toBe("QUOTA_EXCEEDED");
	});

	it("classifies FIRECRAWL_TIMEOUT as TIMEOUT", () => {
		const failure = mkActivityFailure(
			"firecrawlScrapeActivity",
			ApplicationFailure.retryable("timeout", "FIRECRAWL_TIMEOUT"),
		);
		expect(classifyFailureErrorType(failure)).toBe("TIMEOUT");
	});

	it("classifies anything else as UNKNOWN", () => {
		const failure = mkActivityFailure(
			"firecrawlScrapeActivity",
			ApplicationFailure.retryable("oops", "SOMETHING_ELSE"),
		);
		expect(classifyFailureErrorType(failure)).toBe("UNKNOWN");
		expect(classifyFailureErrorType(new Error("plain"))).toBe("UNKNOWN");
	});
});

describe("extractInPrefixLinks", () => {
	const parentUrl = "https://help.acme.com/hc/en-us";
	const prefix = ["/hc/en-us"];

	it("extracts markdown-style links under the same prefix", () => {
		const markdown = `# Title

See also [How to set up](https://help.acme.com/hc/en-us/articles/1) and
[Reports](https://help.acme.com/hc/en-us/sections/reports).`;
		const result = extractInPrefixLinks(markdown, parentUrl, prefix);
		expect(result).toContain("https://help.acme.com/hc/en-us/articles/1");
		expect(result).toContain(
			"https://help.acme.com/hc/en-us/sections/reports",
		);
	});

	it("extracts bare URLs from the body", () => {
		const markdown =
			"Reference: https://help.acme.com/hc/en-us/articles/42";
		expect(extractInPrefixLinks(markdown, parentUrl, prefix)).toContain(
			"https://help.acme.com/hc/en-us/articles/42",
		);
	});

	it("filters out cross-origin URLs", () => {
		// Same-origin only — the link to an unrelated host MUST NOT be queued.
		// Without this, a help-center that footers `https://twitter.com/acme`
		// would explode the crawl scope into the open internet.
		const markdown = `
[Acme article](https://help.acme.com/hc/en-us/articles/1)
[External](https://twitter.com/acme)`;
		const result = extractInPrefixLinks(markdown, parentUrl, prefix);
		expect(result).toEqual(["https://help.acme.com/hc/en-us/articles/1"]);
	});

	it("filters out same-origin URLs that fall OUTSIDE the requested prefix", () => {
		// The user asked for /hc/en-us. /careers is same-origin but
		// totally unrelated content; must not pollute the crawl.
		const markdown = `[Article](https://help.acme.com/hc/en-us/articles/1)
[Careers](https://help.acme.com/careers/openings)`;
		const result = extractInPrefixLinks(markdown, parentUrl, prefix);
		expect(result).toEqual(["https://help.acme.com/hc/en-us/articles/1"]);
	});

	it("strips URL fragments before returning", () => {
		// Same article with three different anchors must collapse to one
		// scrape target, not three.
		const markdown = `
[Top](https://help.acme.com/hc/en-us/articles/1#intro)
[Mid](https://help.acme.com/hc/en-us/articles/1#middle)
[End](https://help.acme.com/hc/en-us/articles/1#end)`;
		const result = extractInPrefixLinks(markdown, parentUrl, prefix);
		expect(result).toEqual(["https://help.acme.com/hc/en-us/articles/1"]);
	});

	it("dedupes when the same URL appears as both markdown link AND bare URL", () => {
		const markdown = `
See [the doc](https://help.acme.com/hc/en-us/articles/1) — full URL:
https://help.acme.com/hc/en-us/articles/1`;
		expect(extractInPrefixLinks(markdown, parentUrl, prefix)).toHaveLength(
			1,
		);
	});

	it("ignores malformed URLs without throwing", () => {
		const markdown = "[bad](not-a-url) and [worse](javascript:alert(1))";
		expect(() =>
			extractInPrefixLinks(markdown, parentUrl, prefix),
		).not.toThrow();
		// Both candidates fail the http(s) regex prefilter, so no results.
		expect(extractInPrefixLinks(markdown, parentUrl, prefix)).toEqual([]);
	});

	it("returns an empty array when the parent URL is itself malformed", () => {
		// Defensive: a workflow caller that somehow ended up with a bad
		// parent URL shouldn't get a thrown exception out of a pure helper.
		expect(
			extractInPrefixLinks(
				"https://help.acme.com/hc/en-us/articles/1",
				"not-a-url",
				prefix,
			),
		).toEqual([]);
	});

	it("with no includePaths, accepts any same-origin URL", () => {
		// Mirrors `crawlSite`'s "no path filter → match everything under host"
		// behaviour for parent URLs at the host root.
		const markdown = `
[Hc article](https://help.acme.com/hc/en-us/articles/1)
[Careers](https://help.acme.com/careers/openings)`;
		const result = extractInPrefixLinks(
			markdown,
			"https://help.acme.com",
			undefined,
		);
		expect(result).toContain("https://help.acme.com/hc/en-us/articles/1");
		expect(result).toContain("https://help.acme.com/careers/openings");
	});
});
