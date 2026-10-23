/**
 * The vendor-site brand fetch (Fizzy #2946), with no network: the pinned
 * fetch is replaced by an in-memory site that applies the same content-type
 * and size rules, so every refusal and cap below is the module's own.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BRAND_FETCH_FAILURE_CODES } from "@repo/utils/proposal-artifact/brand-sources";
import {
	OutboundResponseRejectedError,
	PINNED_FETCH_DEFAULT_CONTENT_TYPES,
	type PinnedFetchOptions,
} from "@repo/utils/url-security";
import { describe, expect, it, vi } from "vitest";
import { isPinnedSiteHost, type PinnedFetch } from "../fetch-website-brand";
import { fetchVendorBrand } from "../vendor-brand";

type Reply =
	| { status?: number; type?: string; body?: string | Uint8Array }
	| { redirect: string; status?: number }
	| ((init: RequestInit) => Promise<Response>);

interface Call {
	url: string;
	init: RequestInit;
	opts: PinnedFetchOptions;
}

/** An in-memory site keyed by exact URL; anything else answers 404. */
function site(routes: Record<string, Reply>) {
	const calls: Call[] = [];
	const fetch = vi.fn(
		async (
			input: string | URL,
			init: RequestInit = {},
			opts: PinnedFetchOptions = {},
		) => {
			const url = String(input);
			calls.push({ url, init, opts });
			const reply = routes[url];
			if (reply === undefined) {
				return new Response(null, { status: 404 });
			}
			if (typeof reply === "function") {
				return reply(init);
			}
			if ("redirect" in reply) {
				return new Response(null, {
					status: reply.status ?? 302,
					headers: { location: reply.redirect },
				});
			}
			const allowed =
				opts.allowedContentTypes ?? PINNED_FETCH_DEFAULT_CONTENT_TYPES;
			if (!reply.type || !allowed.includes(reply.type)) {
				throw new OutboundResponseRejectedError(
					"CONTENT_TYPE_NOT_ALLOWED",
					`Content type ${reply.type ?? "(none)"} is not allowed`,
				);
			}
			const body =
				typeof reply.body === "string"
					? new TextEncoder().encode(reply.body)
					: new Uint8Array(reply.body ?? []);
			if (
				opts.maxBytes !== undefined &&
				body.byteLength > opts.maxBytes
			) {
				throw new OutboundResponseRejectedError(
					"RESPONSE_TOO_LARGE",
					`Response body exceeds ${opts.maxBytes} bytes`,
				);
			}
			return new Response(body, {
				status: reply.status ?? 200,
				headers: { "content-type": reply.type },
			});
		},
	);
	return {
		fetch: fetch as unknown as PinnedFetch,
		urls: () => calls.map((call) => call.url),
		calls,
	};
}

function html(head: string, body = "") {
	return {
		type: "text/html",
		body: `<!doctype html><html><head>${head}</head><body>${body}</body></html>`,
	};
}

const HOME = "https://example.com/";
const BRAND = "https://example.com/brand";
const LLMS = "https://example.com/llms.txt";

const home = html(
	"<title>Example — payments for teams</title>",
	"<h1>Payments for teams</h1><p>Start now.</p>",
);

function brandPage(body: string, title = "Brand guidelines") {
	return html(`<title>${title}</title>`, body);
}

describe("fetchVendorBrand", () => {
	it("takes the brand page's first chromatic hex as primary and drops near-white", async () => {
		const { fetch } = site({
			[HOME]: home,
			[BRAND]: brandPage(
				"<h1>Our colours</h1><p>Navy #0A2540</p><p>Off-white #F2F2F2</p>",
			),
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toEqual({
			ok: true,
			primaryColor: "#0a2540",
			accentColors: [],
			source: "brand_page",
		});
	});

	it("takes the next three distinct chromatic six-digit values as accents, skipping #rgb", async () => {
		const { fetch } = site({
			[HOME]: home,
			[BRAND]: brandPage(
				`<h2>Palette</h2>
				<ul>
					<li>#0a2540</li><li>#0A2540</li><li>#ffffff</li><li>#000</li>
					<li>#111111</li><li>#0f172a</li><li>#6b7280</li>
					<li>#635BFF</li><li>#0cf</li><li>#FF5996</li><li>#1d4ed8</li>
				</ul>`,
			),
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toEqual({
			ok: true,
			primaryColor: "#0a2540",
			accentColors: ["#635bff", "#ff5996", "#1d4ed8"],
			source: "brand_page",
		});
	});

	it("does not apply a three-digit hex from the brand page's text", async () => {
		const shortOnly = brandPage(
			"<h1>Brand</h1><p>Primary #0cf, accent #f59</p>",
		);

		const fallsThrough = site({
			[HOME]: html(`<meta name="theme-color" content="#1d4ed8">`),
			[BRAND]: shortOnly,
		});
		expect(
			await fetchVendorBrand("example.com", {
				fetch: fallsThrough.fetch,
			}),
		).toEqual({
			ok: true,
			primaryColor: "#1d4ed8",
			accentColors: [],
			source: "theme_color",
		});

		const nothingElse = site({ [HOME]: home, [BRAND]: shortOnly });
		expect(
			await fetchVendorBrand("example.com", { fetch: nothingElse.fetch }),
		).toEqual({ ok: false, code: "no_colors" });
	});

	it("still widens a three-digit theme-color, which the site declares as a colour", async () => {
		const { fetch } = site({
			[HOME]: html(`<meta name="theme-color" content="#0cf">`),
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toEqual({
			ok: true,
			primaryColor: "#00ccff",
			accentColors: [],
			source: "theme_color",
		});
	});

	it("reads no colour from a <style> palette, attributes, SVG, scripts, noscript or comments", async () => {
		const { fetch } = site({
			[HOME]: html(`<meta name="theme-color" content="#1d4ed8">`),
			[BRAND]: brandPage(
				`<style>:root { --brand: #0a2540; --accent: #635bff; }</style>
				<h1 style="color:#ff5996" data-color="#0d9488">Brand</h1>
				<div title='#7c3aed' class="x">Our palette is shown above.</div>
				<svg viewBox="0 0 10 10"><svg><text>#16a34a</text></svg><text>#ca8a04</text></svg>
				<script>const brand = "#dc2626";</script>
				<noscript>#9333ea</noscript>
				<template><p>#0891b2</p></template>
				<!-- #be123c -->
				<a href="#c026d3">top</a>`,
			),
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toEqual({
			ok: true,
			primaryColor: "#1d4ed8",
			accentColors: [],
			source: "theme_color",
		});
	});

	it("does not read 8-digit, 4-digit or fragment-like values as colours", async () => {
		const { fetch } = site({
			[HOME]: home,
			[BRAND]: brandPage(
				"<h1>Brand</h1><p>#0a2540ff #abcd page#635bff #0a25 &amp;#635bff</p>",
			),
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toEqual({
			ok: false,
			code: "no_colors",
		});
	});

	it("reads an entity-encoded hex in visible text", async () => {
		const { fetch } = site({
			[HOME]: home,
			[BRAND]: brandPage("<h1>Brand</h1><p>&#35;0A2540</p>"),
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toMatchObject({
			ok: true,
			primaryColor: "#0a2540",
		});
	});

	it("ignores a /brand answered with the home page", async () => {
		// A single-page app answers every path with the same document.
		const spa = html(
			`<title>Example</title><meta name="theme-color" content="#1d4ed8">`,
			`<div id="root"></div><p>#635bff</p>`,
		);
		const { fetch } = site({ [HOME]: spa, [BRAND]: spa });

		expect(await fetchVendorBrand("example.com", { fetch })).toEqual({
			ok: true,
			primaryColor: "#1d4ed8",
			accentColors: [],
			source: "theme_color",
		});
	});

	it("ignores a /brand page whose title and first heading do not name the brand", async () => {
		const { fetch } = site({
			[HOME]: home,
			[BRAND]: html(
				"<title>Pricing</title>",
				"<h1>Plans</h1><h2>Brand colours</h2><p>#635bff</p>",
			),
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toEqual({
			ok: false,
			code: "no_colors",
		});
	});

	it("ignores a /brand that redirects to the home page", async () => {
		const { fetch } = site({
			[HOME]: html("<title>Brand studio</title>", "<p>#635bff</p>"),
			[BRAND]: { redirect: "/" },
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toEqual({
			ok: false,
			code: "no_colors",
		});
	});

	it("drops a theme-color carrying CSS and a manifest colour that is not hex", async () => {
		const { fetch } = site({
			[HOME]: html(
				`<meta name="theme-color" content="red;} body{display:none">
				<link rel="manifest" href="/site.webmanifest">`,
			),
			"https://example.com/site.webmanifest": {
				type: "application/manifest+json",
				body: JSON.stringify({ theme_color: "url(x)" }),
			},
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toEqual({
			ok: false,
			code: "no_colors",
		});
	});

	it("never uses a logo: a logo-only site has no vendor colours and no image is fetched", async () => {
		const { fetch, urls } = site({
			[HOME]: html(
				`<link rel="apple-touch-icon" href="/touch.png">
				<link rel="icon" sizes="512x512" href="/icon.png">
				<meta property="og:image" content="/og.png">`,
			),
			"https://example.com/touch.png": { type: "image/png", body: "png" },
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toEqual({
			ok: false,
			code: "no_colors",
		});
		expect(urls().some((url) => url.endsWith(".png"))).toBe(false);
	});

	it("falls back to theme-color, then to the manifest's theme colour", async () => {
		const manifestOnly = site({
			[HOME]: html(
				`<meta name="theme-color" content="#ffffff">
				<link rel="manifest" href="/app.webmanifest">`,
			),
			"https://example.com/app.webmanifest": {
				type: "application/manifest+json",
				body: JSON.stringify({ theme_color: "#0D9488" }),
			},
		});
		expect(
			await fetchVendorBrand("example.com", {
				fetch: manifestOnly.fetch,
			}),
		).toEqual({
			ok: true,
			primaryColor: "#0d9488",
			accentColors: [],
			source: "manifest",
		});
	});

	it("probes one llms.txt link that names the brand when /brand has none", async () => {
		const { fetch, urls } = site({
			[HOME]: home,
			[LLMS]: {
				type: "text/markdown",
				body: `# Example
- [Docs](https://example.com/docs): API reference
- [Brand assets](https://brand.example.net/kit): on another host
- [Press kit](/press/brand-guidelines): logos and colours
- [Brand portal](https://example.com/brand-portal)`,
			},
			"https://example.com/press/brand-guidelines": brandPage(
				"<h1>Brand guidelines</h1><p>Primary: #635BFF</p>",
				"Press",
			),
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toEqual({
			ok: true,
			primaryColor: "#635bff",
			accentColors: [],
			source: "brand_page",
		});
		expect(urls()).toEqual([
			HOME,
			LLMS,
			BRAND,
			"https://example.com/press/brand-guidelines",
		]);
	});

	it("ignores an llms.txt brand link on another host", async () => {
		const { fetch, urls } = site({
			[HOME]: html(`<meta name="theme-color" content="#1d4ed8">`),
			[LLMS]: {
				type: "text/plain",
				body: "Brand: https://brand.example.net/brand\n[Brand](http://example.com/brand-kit)",
			},
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toMatchObject({
			source: "theme_color",
		});
		expect(urls()).toEqual([HOME, LLMS, BRAND]);
	});

	it("skips an llms.txt over its cap and still probes /brand", async () => {
		const { fetch, calls } = site({
			[HOME]: home,
			[LLMS]: {
				type: "text/plain",
				body: `[Brand](/brand-kit)\n${"x".repeat(1024 * 1024)}`,
			},
			[BRAND]: brandPage("<h1>Brand</h1><p>#0a2540</p>"),
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toMatchObject({
			ok: true,
			primaryColor: "#0a2540",
		});
		expect(calls.map((call) => call.url)).toEqual([HOME, LLMS, BRAND]);
		const llms = calls[1];
		expect(llms?.opts.maxBytes).toBe(64 * 1024);
		expect(llms?.opts.allowedContentTypes).toEqual([
			"text/plain",
			"text/markdown",
		]);
	});

	it("treats an llms.txt of another type as absent", async () => {
		const { fetch, urls } = site({
			[HOME]: home,
			[LLMS]: brandPage(`<a href="/brand-kit">Brand</a>`),
			[BRAND]: brandPage("<h1>Brand</h1><p>#0a2540</p>"),
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toMatchObject({
			primaryColor: "#0a2540",
		});
		expect(urls()).not.toContain("https://example.com/brand-kit");
	});

	it("probes at most two brand-page candidates", async () => {
		const { fetch, urls } = site({
			[HOME]: home,
			[LLMS]: {
				type: "text/plain",
				body: "[Brand](/brand-a)\n[Brand](/brand-b)",
			},
			[BRAND]: brandPage("<h1>Brand</h1><p>No colours listed.</p>"),
			"https://example.com/brand-a": brandPage("<h1>Brand</h1>"),
			"https://example.com/brand-b": brandPage(
				"<h1>Brand</h1><p>#0a2540</p>",
			),
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toEqual({
			ok: false,
			code: "no_colors",
		});
		expect(urls()).toEqual([
			HOME,
			LLMS,
			BRAND,
			"https://example.com/brand-a",
		]);
	});

	it("follows a redirect between the site's host and its www host", async () => {
		const location = "https://www.example.com/";
		const { fetch } = site({
			[HOME]: { redirect: location, status: 301 },
			[location]: html(`<meta name="theme-color" content="#1d4ed8">`),
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toMatchObject({
			ok: true,
			primaryColor: "#1d4ed8",
			source: "theme_color",
		});
	});

	it("follows a redirect from the www host to the site's bare host", async () => {
		const start = "https://www.example.com/";
		const location = "https://example.com/home";
		const { fetch, urls } = site({
			[start]: { redirect: location, status: 301 },
			[location]: html(`<meta name="theme-color" content="#1d4ed8">`),
		});

		expect(
			await fetchVendorBrand("www.example.com", { fetch }),
		).toMatchObject({
			ok: true,
			primaryColor: "#1d4ed8",
			source: "theme_color",
		});
		expect(urls().slice(0, 2)).toEqual([start, location]);
	});

	it("refuses a home page that redirects to another host or a subdomain", async () => {
		for (const location of [
			"https://shop.example.com/",
			"https://brand.example.net/",
		]) {
			const { fetch, calls } = site({
				[HOME]: { redirect: location, status: 301 },
				[location]: home,
			});

			expect(await fetchVendorBrand("example.com", { fetch })).toEqual({
				ok: false,
				code: "blocked",
			});
			expect(calls).toHaveLength(1);
		}
	});

	it("refuses an http: hop, even on the same host", async () => {
		const { fetch, calls } = site({
			[HOME]: { redirect: "http://example.com/" },
			"http://example.com/": home,
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toEqual({
			ok: false,
			code: "blocked",
		});
		expect(calls).toHaveLength(1);
	});

	it("ignores a /brand that redirects off the host or to http:", async () => {
		for (const location of [
			"https://brand.example.net/guide",
			"http://example.com/brand",
		]) {
			const { fetch, urls } = site({
				[HOME]: html(`<meta name="theme-color" content="#1d4ed8">`),
				[BRAND]: { redirect: location },
				[location]: brandPage("<h1>Brand</h1><p>#635bff</p>"),
			});

			expect(
				await fetchVendorBrand("example.com", { fetch }),
			).toMatchObject({ source: "theme_color" });
			expect(urls()).not.toContain(location);
		}
	});

	it("does not fetch a manifest on another host", async () => {
		const { fetch, urls } = site({
			[HOME]: html(
				`<link rel="manifest" href="https://cdn.example.net/app.webmanifest">`,
			),
			"https://cdn.example.net/app.webmanifest": {
				type: "application/manifest+json",
				body: JSON.stringify({ theme_color: "#0d9488" }),
			},
		});

		expect(await fetchVendorBrand("example.com", { fetch })).toEqual({
			ok: false,
			code: "no_colors",
		});
		expect(urls()).not.toContain("https://cdn.example.net/app.webmanifest");
	});

	it("fetches every hop as a GET without redirect-following, under one deadline", async () => {
		const { fetch, calls } = site({
			[HOME]: html(`<link rel="manifest" href="/app.webmanifest">`),
			[BRAND]: brandPage("<h1>Brand</h1><p>#0a2540</p>"),
		});

		await fetchVendorBrand("example.com", { fetch });

		expect(calls.length).toBeGreaterThanOrEqual(3);
		for (const call of calls) {
			expect(call.url.startsWith("https://example.com/")).toBe(true);
			expect(call.init.method).toBe("GET");
			expect(call.opts.followRedirects).toBe(false);
			expect(call.opts.maxRedirects).toBe(0);
			expect(call.opts.timeoutMs).toBeLessThanOrEqual(15_000);
			expect(call.init.signal).toBeInstanceOf(AbortSignal);
		}
	});

	it("stops at the deadline", async () => {
		const { fetch } = site({
			[HOME]: () => new Promise<Response>(() => {}),
		});
		const started = performance.now();

		expect(
			await fetchVendorBrand("example.com", { fetch, timeoutMs: 50 }),
		).toEqual({ ok: false, code: "unreachable" });
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("refuses a website that is not a public https host without fetching", async () => {
		const { fetch, calls } = site({});

		expect(
			await fetchVendorBrand("https://example.com:8443", { fetch }),
		).toEqual({ ok: false, code: "blocked" });
		expect(calls).toHaveLength(0);
	});

	it("fails with a fixed code and nothing the site sent", async () => {
		const { fetch } = site({
			[HOME]: { status: 500, type: "text/html", body: "secret page" },
		});

		const result = await fetchVendorBrand("example.com", { fetch });

		expect(Object.keys(result).sort()).toEqual(["code", "ok"]);
		expect(BRAND_FETCH_FAILURE_CODES).toContain(
			result.ok ? null : result.code,
		);
	});
});

describe("isPinnedSiteHost", () => {
	it.each([
		["example.com", "example.com", true],
		["www.example.com", "example.com", true],
		["example.com", "www.example.com", true],
		["www.example.com", "www.example.com", true],
		["EXAMPLE.com", "example.com", true],
		["WWW.Example.COM", "example.com", true],
		["Example.COM", "www.example.com", true],
		["example.com", "EXAMPLE.COM", true],
		["shop.example.com", "example.com", false],
		["notexample.com", "example.com", false],
		["www.shop.example.com", "example.com", false],
		["example.com.evil.example.net", "example.com", false],
		["shop.example.com", "www.example.com", false],
		["notexample.com", "www.example.com", false],
		["www.shop.example.com", "www.example.com", false],
		["example.com.evil.example.net", "www.example.com", false],
	])("%j on pinned %j is %j", (hostname, pinned, expected) => {
		expect(isPinnedSiteHost(hostname, pinned)).toBe(expected);
	});
});

describe("no model reach", () => {
	// Fetched text must never reach a prompt: the website-brand modules
	// import no model, provider or prompt code.
	const MODEL_IMPORT =
		/from\s+["'](?:@repo\/ai(?:\/[^"']*)?|ai|@ai-sdk\/[^"']+|@repo\/temporal[^"']*|@langchain\/[^"']+|openai|@anthropic-ai\/[^"']+)["']/;

	it.each([
		"vendor-brand.ts",
		"fetch-website-brand.ts",
		"extract-candidates.ts",
		"normalize-logo.ts",
	])("%s imports no model or prompt module", (file) => {
		const source = readFileSync(resolve(__dirname, "..", file), "utf8");
		expect(source).not.toMatch(MODEL_IMPORT);
	});
});
