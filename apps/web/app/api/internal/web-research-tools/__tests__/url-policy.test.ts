import { describe, expect, it } from "vitest";
import { buildConfidentialMatcher } from "../confidential-terms";
import { checkResearchUrl, MAX_RESEARCH_URL_LENGTH } from "../url-policy";

const matcher = buildConfidentialMatcher({
	organizationName: "Example Org Holdings",
	organizationSlug: "example-org",
	clientName: "Contoso",
	clientWebsite: "https://contoso.example",
});

function reasonFor(url: string) {
	const result = checkResearchUrl(url, matcher);
	return result.allowed ? null : result.reason;
}

function urlOfLength(length: number): string {
	const prefix = "https://www.example.net/";
	return prefix + "a".repeat(length - prefix.length);
}

describe("checkResearchUrl", () => {
	it("allows a public https page with a query string", () => {
		const result = checkResearchUrl(
			"https://www.example.net/research/report?year=2025",
			matcher,
		);

		expect(result.allowed).toBe(true);
		expect(result.allowed && result.url.hostname).toBe("www.example.net");
	});

	it("allows exactly the maximum length and rejects one character more", () => {
		expect(reasonFor(urlOfLength(MAX_RESEARCH_URL_LENGTH))).toBeNull();
		expect(reasonFor(urlOfLength(MAX_RESEARCH_URL_LENGTH + 1))).toBe(
			"too_long",
		);
	});

	it("rejects a string that is not a URL", () => {
		expect(reasonFor("not a url")).toBe("invalid");
	});

	it.each([
		"file:///etc/passwd",
		"ftp://example.net/file.txt",
		"javascript:alert(1)",
		"data:text/html,<p>hi</p>",
	])("rejects the non-http scheme in %s", (url) => {
		expect(reasonFor(url)).toBe("scheme");
	});

	it.each(["https://user:pass@example.net/", "https://user@example.net/"])(
		"rejects credentials in %s",
		(url) => {
			expect(reasonFor(url)).toBe("credentials");
		},
	);

	it.each([
		"http://127.0.0.1/",
		"http://8.8.8.8/",
		"http://2130706433/",
		"http://0x7f.1/",
		"http://[::1]/",
		"https://[2606:4700:4700::1111]/",
	])("rejects the IP literal in %s", (url) => {
		expect(reasonFor(url)).toBe("ip_literal");
	});

	it.each([
		"http://localhost/",
		"http://localhost./",
		"http://app.localhost/",
		"http://printer.local/",
		"http://metadata.google.internal/",
		"http://intranet/",
		"http://printer.lan/",
		"http://nas.home.arpa/",
		"http://wiki.corp/",
		"http://router.home/",
		"http://files.private/",
		"http://box.localdomain/",
		"http://portal.intranet/",
		"http://www.example.net./",
	])("rejects the local or internal host in %s", (url) => {
		expect(reasonFor(url)).toBe("local_host");
	});

	it.each([
		[
			"a percent-encoded query",
			"https://news.example.net/search?q=Example%20Org%20Holdings",
		],
		[
			"a plus-encoded query",
			"https://news.example.net/search?q=example+org+holdings",
		],
		["a fragment", "https://news.example.net/page#example-org"],
		["a path segment", "https://news.example.net/company/example-org"],
		[
			"an encoded path segment",
			"https://news.example.net/company/Example%20Org%20Holdings",
		],
		["a subdomain", "https://contoso.news.example.net/"],
	])(
		"rejects a confidential name in %s and names its kind",
		(_label, url) => {
			const result = checkResearchUrl(url, matcher);

			expect(result.allowed).toBe(false);
			expect(!result.allowed && result.reason).toBe("confidential_term");
			expect(!result.allowed && result.matchKind).toBeDefined();
		},
	);

	it("rejects the client's own website as a confidential term", () => {
		const result = checkResearchUrl(
			"https://www.contoso.example/about",
			matcher,
		);

		expect(result).toMatchObject({
			allowed: false,
			reason: "confidential_term",
		});
	});

	it("does not throw on a malformed percent sequence", () => {
		expect(() =>
			checkResearchUrl(
				"https://news.example.net/a%E0%A4%A/b?q=%E0%A4%A",
				matcher,
			),
		).not.toThrow();
		expect(
			reasonFor("https://news.example.net/a%E0%A4%A/b?q=%E0%A4%A"),
		).toBeNull();
	});

	it.each([
		[
			"a stray % in the query",
			"https://news.example.net/s?q=Example%20Org%20Holdings&x=100%",
		],
		[
			"a broken escape in the query",
			"https://news.example.net/s?q=Example%20Org%20Holdings&z=%E0%A4%A",
		],
		[
			"a stray % in the path",
			"https://news.example.net/Example%20Org%20Holdings/100%",
		],
		[
			"double encoding",
			"https://news.example.net/s?q=Example%2520Org%2520Holdings",
		],
		[
			"plus signs in the path",
			"https://news.example.net/search/Example+Org+Holdings",
		],
	])("still finds the name with %s", (_label, url) => {
		expect(reasonFor(url)).toBe("confidential_term");
	});

	it("reads an internationalized host in Unicode, not punycode", () => {
		const accented = buildConfidentialMatcher({
			clientName: "Café Nordique",
		});

		const result = checkResearchUrl(
			"https://café-nordique.example.net/menu",
			accented,
		);

		expect(result).toMatchObject({
			allowed: false,
			reason: "confidential_term",
			matchKind: "client_name",
		});
	});

	it("checks only the network rules when called without a matcher", () => {
		expect(
			checkResearchUrl("https://news.example.net/company/example-org")
				.allowed,
		).toBe(true);
		expect(checkResearchUrl("http://127.0.0.1/").allowed).toBe(false);
	});
});
