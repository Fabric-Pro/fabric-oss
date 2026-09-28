/**
 * The website brand extractor, with no network: the pinned fetch is replaced
 * by an in-memory site that applies the same content-type and size rules.
 * Hops that must be refused are handed to the REAL `safeFetchOutboundPinned`
 * with a stubbed resolver, so the refusal comes from the production guard and
 * is raised before any socket would open.
 */
import { crc32 } from "node:zlib";
import {
	OutboundResponseRejectedError,
	PINNED_FETCH_DEFAULT_CONTENT_TYPES,
	type PinnedFetchOptions,
	type ResolvedAddress,
	safeFetchOutboundPinned,
} from "@repo/utils/url-security";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	fetchWebsiteBrand,
	normalizeWebsiteUrl,
	type PinnedFetch,
	WEBSITE_BRAND_FAILURE_CODES,
} from "../fetch-website-brand";

type Handler = (
	url: string,
	init: RequestInit,
	opts: PinnedFetchOptions,
) => Promise<Response>;

type Reply =
	| { status?: number; type?: string; body?: string | Uint8Array }
	| { redirect: string; status?: number }
	| Handler;

interface Call {
	url: string;
	init: RequestInit;
	opts: PinnedFetchOptions;
}

/** An in-memory site keyed by exact URL; anything else fails to connect. */
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
				throw new TypeError("fetch failed", {
					cause: new Error(`connect ECONNREFUSED ${url}`),
				});
			}
			if (typeof reply === "function") {
				return reply(url, init, opts);
			}
			if ("redirect" in reply) {
				return new Response(null, {
					status: reply.status ?? 302,
					headers: { location: reply.redirect },
				});
			}
			// The same checks the pinned fetch applies before handing back a body.
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
	return { fetch: fetch as unknown as PinnedFetch, calls };
}

/** Hand the hop to the real pinned guard with a stubbed resolver. */
function viaRealGuard(
	lookup: (hostname: string) => Promise<ResolvedAddress[]>,
): Handler {
	return (url, init, opts) =>
		safeFetchOutboundPinned(url, init, { ...opts, lookup });
}

const resolvesTo =
	(address: string) => async (): Promise<ResolvedAddress[]> => [
		{ address, family: 4 },
	];

function page(head: string) {
	return {
		type: "text/html",
		body: `<!doctype html><html><head>${head}</head><body></body></html>`,
	};
}

const HOST_OR_RESOLVER_TEXT =
	/example|internal|10\.0\.0|169\.254|resolve|getaddrinfo|ENOTFOUND|ECONNREFUSED/i;

let bluePng: Uint8Array;
let hugePng: Uint8Array;

beforeAll(async () => {
	bluePng = await sharp({
		create: { width: 32, height: 32, channels: 4, background: "#1d4ed8" },
	})
		.png()
		.toBuffer();
	// A real PNG whose header claims 40000 x 40000 (IHDR CRC fixed up).
	const huge = Buffer.from(bluePng);
	huge.writeUInt32BE(40_000, 16);
	huge.writeUInt32BE(40_000, 20);
	huge.writeUInt32BE(crc32(huge.subarray(12, 29)), 29);
	hugePng = huge;
});

describe("normalizeWebsiteUrl", () => {
	it.each([
		["example.com", "https://example.com"],
		["Example.COM/about?x=1#top", "https://example.com"],
		["http://www.example.com./path", "https://www.example.com"],
		["https://example.com:443/", "https://example.com"],
		["example.com:80", "https://example.com"],
	])("normalizes %j to %j", (input, expected) => {
		expect(normalizeWebsiteUrl(input)).toBe(expected);
	});

	it.each([
		["ftp://example.com"],
		["javascript:alert(1)"],
		["mailto:dev@example.com"],
		["https://user:secret@example.com"],
		["https://example.com:8443"],
		["example.com:8080"],
		["not a url at all"],
		[""],
	])("refuses %j", (input) => {
		expect(normalizeWebsiteUrl(input)).toBeNull();
	});
});

describe("fetchWebsiteBrand", () => {
	it("follows a redirect and resolves relative icons against the final hop", async () => {
		const { fetch, calls } = site({
			"https://example.com/": {
				redirect: "https://www.example.com/home/",
				status: 301,
			},
			"https://www.example.com/home/": page(
				`<link rel="apple-touch-icon" href="touch.png">
				<meta name="theme-color" content="#0d9488">`,
			),
			"https://www.example.com/home/touch.png": {
				type: "image/png",
				body: bluePng,
			},
		});

		const result = await fetchWebsiteBrand("Example.com/pricing", {
			fetch,
		});

		expect(result).toMatchObject({
			ok: true,
			colors: ["#0d9488"],
			finalHost: "www.example.com",
		});
		expect(calls.map((c) => c.url)).toEqual([
			"https://example.com/",
			"https://www.example.com/home/",
			"https://www.example.com/home/touch.png",
		]);
		// Every hop re-enters the pinned fetch itself: GET, no redirect-following
		// inside it, and a timeout bounded by the one shared deadline.
		for (const call of calls) {
			expect(call.init.method).toBe("GET");
			expect(call.init.body).toBeUndefined();
			expect(call.opts.followRedirects).toBe(false);
			expect(call.opts.maxRedirects).toBe(0);
			expect(call.opts.timeoutMs).toBeLessThanOrEqual(15_000);
			expect(call.init.signal).toBeInstanceOf(AbortSignal);
		}
		const png = result.ok ? result.logoPng : Buffer.alloc(0);
		expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});

	it("tries candidates in order and stops at the first logo that normalizes", async () => {
		const { fetch, calls } = site({
			"https://example.com/": page(
				`<meta property="og:image" content="/og.png">
				<link rel="icon" sizes="512x512" href="/icon.png">
				<link rel="apple-touch-icon" href="/touch.png">`,
			),
			"https://example.com/touch.png": { status: 404, type: "image/png" },
			"https://example.com/icon.png": {
				type: "image/png",
				body: bluePng,
			},
			"https://example.com/og.png": { type: "image/png", body: bluePng },
		});

		const result = await fetchWebsiteBrand("example.com", { fetch });

		expect(result.ok).toBe(true);
		expect(calls.map((c) => c.url)).toEqual([
			"https://example.com/",
			"https://example.com/touch.png",
			"https://example.com/icon.png",
		]);
	});

	it("tries at most three logo candidates and reports the best one's failure", async () => {
		const { fetch, calls } = site({
			"https://example.com/": page(
				`<link rel="apple-touch-icon" href="/touch.png">
				<link rel="icon" href="/icon.png">
				<link rel="manifest" href="/site.webmanifest">
				<meta property="og:image" content="/og.png">
				<meta name="theme-color" content="#0d9488">`,
			),
			"https://example.com/site.webmanifest": {
				type: "application/manifest+json",
				body: JSON.stringify({
					icons: [{ src: "/manifest-512.png", sizes: "512x512" }],
				}),
			},
			"https://example.com/touch.png": {
				type: "image/png",
				body: hugePng,
			},
			"https://example.com/icon.png": { status: 500, type: "image/png" },
			"https://example.com/manifest-512.png": {
				status: 404,
				type: "image/png",
			},
			"https://example.com/og.png": { type: "image/png", body: bluePng },
		});

		const result = await fetchWebsiteBrand("example.com", { fetch });

		expect(result).toEqual({
			ok: false,
			code: "too_large",
			colors: ["#0d9488"],
		});
		expect(calls.map((c) => c.url)).not.toContain(
			"https://example.com/og.png",
		);
	});

	it("uses manifest icons and theme color when the page has neither", async () => {
		const { fetch } = site({
			"https://example.com/": page(
				`<link rel="manifest" href="/static/app.webmanifest">`,
			),
			"https://example.com/static/app.webmanifest": {
				type: "application/manifest+json",
				body: JSON.stringify({
					theme_color: "#1D4ED8",
					icons: [{ src: "icon-192.png", sizes: "192x192" }],
				}),
			},
			"https://example.com/static/icon-192.png": {
				type: "image/png",
				body: bluePng,
			},
		});

		const result = await fetchWebsiteBrand("example.com", { fetch });

		expect(result).toMatchObject({ ok: true, colors: ["#1d4ed8"] });
	});

	it("refuses a redirect to a host that resolves privately at that hop, as unreachable", async () => {
		const { fetch, calls } = site({
			"https://example.com/": {
				redirect: "http://internal.example.com/admin",
			},
			"http://internal.example.com/admin": viaRealGuard(
				resolvesTo("10.0.0.7"),
			),
		});

		const result = await fetchWebsiteBrand("example.com", { fetch });

		expect(result).toEqual({ ok: false, code: "unreachable", colors: [] });
		expect(calls).toHaveLength(2);
	});

	it("refuses a literal metadata or private address as blocked, without fetching it", async () => {
		for (const location of [
			"http://169.254.169.254/latest/meta-data/",
			"http://10.0.0.7/admin",
			"http://[::1]/",
		]) {
			const { fetch, calls } = site({
				"https://example.com/": { redirect: location },
				[location]: viaRealGuard(resolvesTo("93.184.216.34")),
			});
			expect(await fetchWebsiteBrand("example.com", { fetch })).toEqual({
				ok: false,
				code: "blocked",
				colors: [],
			});
			expect(calls).toHaveLength(1);
		}
	});

	it("reports a private logo host as unreachable", async () => {
		const privateLogo = site({
			"https://example.com/": page(
				`<link rel="apple-touch-icon" href="https://cdn.example.com/touch.png">`,
			),
			"https://cdn.example.com/touch.png": viaRealGuard(
				resolvesTo("192.168.1.20"),
			),
		});
		expect(
			await fetchWebsiteBrand("example.com", {
				fetch: privateLogo.fetch,
			}),
		).toEqual({ ok: false, code: "unreachable", colors: [] });
	});

	// The server's resolver may know private names (a private zone, say). A
	// name that resolves privately and one that does not resolve must read
	// the same, wherever the name appears: typed, redirected to, or named as
	// a logo candidate by a page the editor does not control.
	it("gives a private answer and no answer the same result, so the codes carry nothing the resolver knows", async () => {
		const privateAnswer = viaRealGuard(resolvesTo("10.0.0.7"));
		const noAnswer = viaRealGuard(async (hostname) => {
			throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
		});
		const probes = (target: Handler): Array<Record<string, Reply>> => [
			{ "https://example.com/": target },
			{
				"https://example.com/": {
					redirect: "https://probe.example.net/",
				},
				"https://probe.example.net/": target,
			},
			{
				"https://example.com/": page(
					`<link rel="apple-touch-icon" href="https://probe.example.net/touch.png">`,
				),
				"https://probe.example.net/touch.png": target,
			},
		];

		const privateResults = await Promise.all(
			probes(privateAnswer).map((routes) =>
				fetchWebsiteBrand("example.com", { fetch: site(routes).fetch }),
			),
		);
		const missingResults = await Promise.all(
			probes(noAnswer).map((routes) =>
				fetchWebsiteBrand("example.com", { fetch: site(routes).fetch }),
			),
		);

		expect(privateResults).toEqual(missingResults);
		for (const result of privateResults) {
			expect(result).toMatchObject({ ok: false, code: "unreachable" });
		}
	});

	it("refuses other ports, schemes and credentials without fetching them", async () => {
		for (const location of [
			"https://example.com:8443/",
			"ftp://example.com/",
			"https://user:secret@example.com/",
		]) {
			const { fetch, calls } = site({
				"https://example.com/": { redirect: location },
			});
			expect(await fetchWebsiteBrand("example.com", { fetch })).toEqual({
				ok: false,
				code: "blocked",
				colors: [],
			});
			expect(calls).toHaveLength(1);
		}

		const { fetch, calls } = site({});
		expect(
			await fetchWebsiteBrand("https://example.com:8443", { fetch }),
		).toEqual({ ok: false, code: "blocked", colors: [] });
		expect(calls).toHaveLength(0);
	});

	it("follows at most three redirects", async () => {
		const { fetch, calls } = site({
			"https://example.com/": { redirect: "/1" },
			"https://example.com/1": { redirect: "/2" },
			"https://example.com/2": { redirect: "/3" },
			"https://example.com/3": { redirect: "/4" },
			"https://example.com/4": page(""),
		});

		const result = await fetchWebsiteBrand("example.com", { fetch });

		expect(result).toEqual({ ok: false, code: "unreachable", colors: [] });
		expect(calls).toHaveLength(4);
	});

	it("fetches HTML only because the page hop passes its own allowlist", async () => {
		// The pinned fetch's default allowlist has no HTML (or images), so a
		// hop that forgot to name its types could not read a page at all.
		expect(PINNED_FETCH_DEFAULT_CONTENT_TYPES).not.toContain("text/html");

		const { fetch, calls } = site({
			"https://example.com/": page(
				`<link rel="apple-touch-icon" href="/touch.png">`,
			),
			// A logo URL that serves a page is refused by the image allowlist.
			"https://example.com/touch.png": page(""),
		});

		const result = await fetchWebsiteBrand("example.com", { fetch });

		expect(result).toEqual({ ok: false, code: "unsupported", colors: [] });
		expect(calls[0]?.opts.allowedContentTypes).toEqual([
			"text/html",
			"application/xhtml+xml",
		]);
		expect(calls[1]?.opts.allowedContentTypes).not.toContain("text/html");
		expect(calls[1]?.opts.allowedContentTypes).not.toContain(
			"image/svg+xml",
		);
	});

	it("fails fast with too_large for a PNG declaring huge dimensions", async () => {
		const { fetch } = site({
			"https://example.com/": page(
				`<link rel="apple-touch-icon" href="/touch.png">`,
			),
			"https://example.com/touch.png": {
				type: "image/png",
				body: hugePng,
			},
		});
		const started = performance.now();

		const result = await fetchWebsiteBrand("example.com", { fetch });

		expect(result).toEqual({ ok: false, code: "too_large", colors: [] });
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	it("returns unsupported for image/png whose bytes are HTML", async () => {
		const { fetch } = site({
			"https://example.com/": page(
				`<link rel="apple-touch-icon" href="/touch.png">`,
			),
			"https://example.com/touch.png": {
				type: "image/png",
				body: "<!doctype html><html><body>Not found</body></html>",
			},
		});

		expect(await fetchWebsiteBrand("example.com", { fetch })).toEqual({
			ok: false,
			code: "unsupported",
			colors: [],
		});
	});

	it("returns colors and no_logo for an SVG-only or ICO-only site", async () => {
		const { fetch, calls } = site({
			"https://example.com/": page(
				`<link rel="icon" href="/favicon.ico">
				<link rel="icon" type="image/svg+xml" href="/logo.svg">
				<link rel="mask-icon" href="/mask.svg" color="#0d9488">
				<meta name="theme-color" content="#0d9488">`,
			),
		});

		const result = await fetchWebsiteBrand("example.com", { fetch });

		expect(result).toEqual({
			ok: false,
			code: "no_logo",
			colors: ["#0d9488"],
		});
		expect(calls).toHaveLength(1);
	});

	it("drops a theme-color carrying CSS and falls back to the logo's dominant color", async () => {
		const { fetch } = site({
			"https://example.com/": page(
				`<meta name="theme-color" content="red;background:url(x)">
				<meta name="theme-color" content="#ffffff">
				<link rel="apple-touch-icon" href="/touch.png">`,
			),
			"https://example.com/touch.png": {
				type: "image/png",
				body: bluePng,
			},
		});

		const result = await fetchWebsiteBrand("example.com", { fetch });

		expect(result).toMatchObject({ ok: true, colors: ["#1d4ed8"] });
	});

	it("aborts a slow site at the deadline as unreachable", async () => {
		const { fetch } = site({
			"https://example.com/": (_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					);
				}),
		});
		const started = performance.now();

		const result = await fetchWebsiteBrand("example.com", {
			fetch,
			timeoutMs: 50,
		});

		expect(result).toEqual({ ok: false, code: "unreachable", colors: [] });
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("keeps the deadline even when the fetch ignores the signal", async () => {
		const { fetch } = site({
			"https://example.com/": () => new Promise<Response>(() => {}),
		});

		const result = await fetchWebsiteBrand("example.com", {
			fetch,
			timeoutMs: 50,
		});

		expect(result).toEqual({ ok: false, code: "unreachable", colors: [] });
	});

	describe("failure payloads", () => {
		const scenarios: Array<[string, Record<string, Reply>]> = [
			[
				"an unresolvable host",
				{
					"https://example.com/": viaRealGuard(async (hostname) => {
						throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
					}),
				},
			],
			[
				"a private resolution",
				{
					"https://example.com/": viaRealGuard(
						resolvesTo("10.0.0.7"),
					),
				},
			],
			["a refused connection", {}],
			[
				"a page over the size cap",
				{
					"https://example.com/": {
						type: "text/html",
						body: new Uint8Array(5 * 1024 * 1024 + 1),
					},
				},
			],
			[
				"a page of the wrong type",
				{
					"https://example.com/": {
						type: "application/pdf",
						body: "%PDF",
					},
				},
			],
		];

		it.each(scenarios)(
			"carry only a fixed code for %s",
			async (_label, routes) => {
				const { fetch } = site(routes);

				const result = await fetchWebsiteBrand("example.com", {
					fetch,
				});

				expect(result.ok).toBe(false);
				expect(Object.keys(result).sort()).toEqual([
					"code",
					"colors",
					"ok",
				]);
				expect(WEBSITE_BRAND_FAILURE_CODES).toContain(
					result.ok ? null : result.code,
				);
				expect(JSON.stringify(result)).not.toMatch(
					HOST_OR_RESOLVER_TEXT,
				);
			},
		);

		it("classifies an unresolvable host as unreachable, not blocked", async () => {
			const { fetch } = site({
				"https://example.com/": viaRealGuard(async () => {
					throw new Error("getaddrinfo ENOTFOUND");
				}),
			});
			expect(await fetchWebsiteBrand("example.com", { fetch })).toEqual({
				ok: false,
				code: "unreachable",
				colors: [],
			});
		});
	});
});
