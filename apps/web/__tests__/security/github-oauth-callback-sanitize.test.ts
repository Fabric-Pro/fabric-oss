/**
 * Output-encoding tests for the GitHub OAuth callback page (SOC 2 CC6.1 — M10).
 * The callback reflects the provider-supplied `error_description` / `returnUrl`
 * into HTML + inline JS, so these helpers must neutralize XSS and open-redirect.
 */

import { describe, expect, it } from "vitest";
import {
	appendQuery,
	htmlEscape,
	jsString,
	sanitizeReturnUrl,
} from "../../app/api/integrations/github/oauth/callback/sanitize";

describe("htmlEscape", () => {
	it("neutralizes an HTML-injection payload", () => {
		expect(htmlEscape('<img src=x onerror="alert(1)">')).toBe(
			"&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
		);
	});

	it("escapes all five special characters (ampersand first)", () => {
		expect(htmlEscape(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
	});
});

describe("jsString", () => {
	it("prevents breaking out of a <script> block", () => {
		const encoded = jsString("</script><script>alert(1)</script>");
		expect(encoded).not.toContain("</script>");
		expect(encoded).toContain("\\u003c/script>");
	});

	it("produces a quoted literal that round-trips via JSON.parse", () => {
		const value = 'he said "hi"\nline2\\end';
		expect(JSON.parse(jsString(value))).toBe(value);
	});
});

describe("sanitizeReturnUrl", () => {
	it("allows a same-origin relative path", () => {
		expect(sanitizeReturnUrl("/app/settings/integrations")).toBe(
			"/app/settings/integrations",
		);
	});

	it("rejects an absolute URL (open redirect)", () => {
		expect(sanitizeReturnUrl("https://evil.com")).toBe(
			"/app/settings/integrations",
		);
		expect(sanitizeReturnUrl("http://evil.com")).toBe(
			"/app/settings/integrations",
		);
	});

	it("rejects a protocol-relative //host", () => {
		expect(sanitizeReturnUrl("//evil.com")).toBe(
			"/app/settings/integrations",
		);
	});

	it("rejects backslash variants that browsers normalize to //host", () => {
		// Browsers treat "\" as "/", so these resolve to https://evil.com.
		for (const evil of ["/\\evil.com", "/\\/evil.com", "/\\\\evil.com"]) {
			expect(sanitizeReturnUrl(evil)).toBe("/app/settings/integrations");
		}
	});

	it("still allows a legitimate nested relative path", () => {
		expect(sanitizeReturnUrl("/app/projects/123?tab=integrations")).toBe(
			"/app/projects/123?tab=integrations",
		);
	});

	it("rejects a same-origin absolute URL too (callers must send a path)", () => {
		// Fizzy #2370: the callback cannot know the browser's origin reliably
		// behind previews/proxies, so absolute URLs are rejected outright and
		// every `start` caller sends pathname + search + hash instead.
		expect(
			sanitizeReturnUrl("https://app.example.com/app/projects/1"),
		).toBe("/app/settings/integrations");
	});

	it("rejects a tab-smuggled protocol-relative URL", () => {
		// The URL parser strips tab/LF/CR before interpreting the rest, so
		// "/\t/evil.example" navigates to https://evil.example while the
		// second character passes every prefix check. Closed by delegating to
		// safeRelativePath, which resolves against a base.
		for (const evil of [
			"/\t/evil.example",
			"/\n/evil.example",
			"/\r/evil.example",
		]) {
			expect(sanitizeReturnUrl(evil)).toBe("/app/settings/integrations");
		}
	});

	it("rejects non-string input", () => {
		expect(sanitizeReturnUrl(undefined)).toBe("/app/settings/integrations");
		expect(sanitizeReturnUrl(null)).toBe("/app/settings/integrations");
		expect(sanitizeReturnUrl({ toString: () => "/x" })).toBe(
			"/app/settings/integrations",
		);
	});
});

describe("appendQuery", () => {
	it("starts a query string on a bare path", () => {
		expect(appendQuery("/app/settings/integrations", "oauth=success")).toBe(
			"/app/settings/integrations?oauth=success",
		);
	});

	it("extends an existing query string", () => {
		expect(appendQuery("/app/projects/1?tab=x", "oauth=success")).toBe(
			"/app/projects/1?tab=x&oauth=success",
		);
	});

	it("inserts the parameters before a fragment", () => {
		// Appending after "#" would bury the parameters in the fragment where
		// the landing page's return banner never sees them.
		expect(
			appendQuery("/app/projects/1?tab=x#repos", "oauth=success"),
		).toBe("/app/projects/1?tab=x&oauth=success#repos");
		expect(appendQuery("/app/projects/1#repos", "oauth=error&m=x")).toBe(
			"/app/projects/1?oauth=error&m=x#repos",
		);
	});
});
