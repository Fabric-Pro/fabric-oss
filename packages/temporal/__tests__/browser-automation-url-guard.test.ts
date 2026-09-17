/**
 * SSRF guard on browser automation.
 *
 * A browser resolves and connects on its own, so it is never allowed to: a
 * resolved check runs before every `goto` for a clear refusal, and a
 * Playwright route on the context relays every HTTP(S) request to an
 * undeclared host through the DNS-pinned fetch in this process, aborting
 * refusals and closing WebSockets. These pin the decision, the relay and
 * the way both are installed.
 */

import type { ResolvedAddress } from "@repo/utils/url-security";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The DNS the pre-navigation check consults (the relay's lookup is injected).
const lookupMock = vi.fn();
vi.mock("node:dns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:dns")>();
	return {
		...actual,
		lookup: (...args: unknown[]) => lookupMock(...args),
	};
});

import {
	assertBrowserNavigationAllowed,
	BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV,
	BROWSER_PINNED_FETCH_TIMEOUT_MS,
	BROWSER_RELAY_MAX_REDIRECTS,
	createBrowserPinnedFetch,
	decideBrowserRequest,
	getBrowserNavigationBlockReason,
	handleGuardedRoute,
	handleGuardedWebSocket,
	installOutboundRequestGuard,
	type PinnedBrowserFetch,
} from "../src/activities/browser-automation/url-guard";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ALLOWED = process.env[BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV];

function setEnv(key: string, value: string | undefined) {
	if (value === undefined) {
		delete (process.env as Record<string, string | undefined>)[key];
	} else {
		(process.env as Record<string, string | undefined>)[key] = value;
	}
}

/** The DNS the pinned fetch consults: hostname → answers. */
function lookupFor(byHost: Record<string, ResolvedAddress[]>) {
	return async (hostname: string): Promise<ResolvedAddress[]> => {
		const answers = byHost[hostname];
		if (!answers) {
			const error: NodeJS.ErrnoException = new Error(
				`getaddrinfo ENOTFOUND ${hostname}`,
			);
			error.code = "ENOTFOUND";
			throw error;
		}
		return answers;
	};
}

const PUBLIC = { address: "93.184.216.34", family: 4 };
const METADATA = { address: "169.254.169.254", family: 4 };
const LAN = { address: "10.0.0.1", family: 4 };

/** The frame fake requests belong to unless a test names another. */
const MAIN_FRAME = {};

function redirectTo(location: string, status = 302, cookies: string[] = []) {
	return new Response(null, {
		status,
		headers: [
			["location", location],
			...cookies.map((c) => ["set-cookie", c] as [string, string]),
		],
	});
}

function fakeRoute(
	url: string,
	request: {
		method?: string;
		resourceType?: string;
		navigation?: boolean;
		frame?: object;
		headers?: Record<string, string>;
		body?: Buffer | null;
	} = {},
) {
	return {
		request: () => ({
			url: () => url,
			method: () => request.method ?? "GET",
			resourceType: () => request.resourceType ?? "document",
			isNavigationRequest: () => request.navigation ?? false,
			frame: () => request.frame ?? MAIN_FRAME,
			allHeaders: async () => request.headers ?? {},
			postDataBuffer: () => request.body ?? null,
		}),
		abort: vi.fn(async () => undefined),
		fallback: vi.fn(async () => undefined),
		fulfill: vi.fn(async () => undefined),
	};
}

function fakeSocket(url: string) {
	return {
		url: () => url,
		connectToServer: vi.fn(() => undefined),
		close: vi.fn(async () => undefined),
	};
}

/** A relay that never runs: the handler must decide before fetching. */
function neverFetch(): PinnedBrowserFetch & ReturnType<typeof vi.fn> {
	return vi.fn(async () => {
		throw new Error("the relay must not be reached");
	});
}

function preNavigationDnsAnswers(addresses: ResolvedAddress[]) {
	lookupMock.mockImplementation(
		(
			_hostname: string,
			_options: unknown,
			callback: (
				error: Error | null,
				addresses: ResolvedAddress[],
			) => void,
		) => callback(null, addresses),
	);
}

beforeEach(() => {
	lookupMock.mockReset();
	lookupMock.mockImplementation(
		(
			_hostname: string,
			_options: unknown,
			callback: (error: Error) => void,
		) => callback(new Error("no DNS in this test")),
	);
	setEnv("NODE_ENV", "production");
	setEnv(BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV, undefined);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
	setEnv("NODE_ENV", ORIGINAL_NODE_ENV);
	setEnv(BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV, ORIGINAL_ALLOWED);
	vi.restoreAllMocks();
});

describe("navigation check", () => {
	it.each([
		"http://169.254.169.254/latest/meta-data/",
		"http://127.0.0.1:7233/",
		"http://10.0.0.1/",
		"http://[::1]/",
		"file:///etc/passwd",
	])("refuses %s", (url) => {
		expect(getBrowserNavigationBlockReason(url)).not.toBeNull();
	});

	it("allows a public URL", () => {
		expect(
			getBrowserNavigationBlockReason("https://example.com/"),
		).toBeNull();
	});
});

describe("request decision", () => {
	it.each([
		"http://169.254.169.254/latest/meta-data/",
		"http://127.0.0.1:7233/",
		"http://10.0.0.1/",
		"http://[::1]/",
		"http://localhost:3000/",
		// The guard must refuse an unencrypted WebSocket to a private address; the URL is a
		// refusal fixture, never connected to.
		// nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
		"ws://10.0.0.1/socket",
		"wss://localhost:3000/socket",
	])("aborts %s and names the setting", (url) => {
		const decision = decideBrowserRequest(url);
		expect(decision.action).toBe("abort");
		expect(decision.action === "abort" && decision.reason).toMatch(
			new RegExp(BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV),
		);
	});

	it("relays a public host through the pinned fetch rather than letting the browser connect", () => {
		expect(
			decideBrowserRequest("https://public.example.com/app.js"),
		).toEqual({ action: "pinned" });
		expect(decideBrowserRequest("wss://public.example.com/socket")).toEqual(
			{
				action: "pinned",
			},
		);
	});

	it("only judges network schemes; the browser owns the rest", () => {
		expect(decideBrowserRequest("data:text/plain,hello")).toEqual({
			action: "direct",
		});
		expect(decideBrowserRequest("about:blank")).toEqual({
			action: "direct",
		});
	});

	it("lets the browser connect itself to a host the operator declared", () => {
		setEnv(BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV, "localhost");
		expect(decideBrowserRequest("http://localhost:3001/app")).toEqual({
			action: "direct",
		});
		expect(decideBrowserRequest("ws://localhost:3001/hmr")).toEqual({
			action: "direct",
		});
		// Declaring one host widens nothing else.
		expect(decideBrowserRequest("http://127.0.0.1:3001/app").action).toBe(
			"abort",
		);
	});

	it("permits loopback outside production, not link-local or LAN", () => {
		setEnv("NODE_ENV", "development");
		expect(decideBrowserRequest("http://localhost:3001/")).toEqual({
			action: "direct",
		});
		expect(decideBrowserRequest("http://169.254.169.254/").action).toBe(
			"abort",
		);
		expect(decideBrowserRequest("http://10.0.0.1/").action).toBe("abort");
	});
});

describe("route handler", () => {
	it("aborts a refused destination without fetching", async () => {
		const blocked = fakeRoute("http://169.254.169.254/latest/meta-data/");
		const relay = neverFetch();
		await handleGuardedRoute(blocked, relay);
		expect(blocked.abort).toHaveBeenCalledWith("blockedbyclient");
		expect(blocked.fallback).not.toHaveBeenCalled();
		expect(blocked.fulfill).not.toHaveBeenCalled();
		expect(relay).not.toHaveBeenCalled();
	});

	it("falls back for a declared host so the browser connects and an earlier resource blocker still runs", async () => {
		setEnv(BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV, "localhost");
		const allowed = fakeRoute("http://localhost:3001/app");
		await handleGuardedRoute(allowed, neverFetch());
		expect(allowed.fallback).toHaveBeenCalledTimes(1);
		expect(allowed.abort).not.toHaveBeenCalled();
		expect(allowed.fulfill).not.toHaveBeenCalled();
	});

	it("aborts a public name that the pinned lookup resolves to a private address, and never lets the browser connect", async () => {
		const fetchPinned = createBrowserPinnedFetch({
			lookup: lookupFor({ "internal.example.com": [LAN] }),
		});
		const route = fakeRoute("https://internal.example.com/dashboard");
		await handleGuardedRoute(route, fetchPinned);
		expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
		expect(route.fallback).not.toHaveBeenCalled();
		expect(route.fulfill).not.toHaveBeenCalled();
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringMatching(
				/non-public address.*BROWSER_AUTOMATION_ALLOWED_HOSTS/s,
			),
		);
	});

	it("aborts when any address in the DNS answer is private", async () => {
		const fetchPinned = createBrowserPinnedFetch({
			lookup: lookupFor({ "rebinding.example.com": [PUBLIC, METADATA] }),
		});
		const route = fakeRoute("https://rebinding.example.com/");
		await handleGuardedRoute(route, fetchPinned);
		expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringMatching(/non-public address/),
		);
	});

	it("binds the decision to the address the relay connects to, not to an earlier DNS answer", async () => {
		// The pre-navigation check sees a public answer and passes. The
		// answer the relay gets for the request itself is private, and that
		// is the one that counts: the request is refused and Chromium never
		// resolved or connected on its own.
		preNavigationDnsAnswers([PUBLIC]);
		await expect(
			assertBrowserNavigationAllowed("https://rebind.example.com/"),
		).resolves.toBeUndefined();

		const lookup = vi.fn(lookupFor({ "rebind.example.com": [LAN] }));
		const route = fakeRoute("https://rebind.example.com/");
		await handleGuardedRoute(route, createBrowserPinnedFetch({ lookup }));
		expect(lookup).toHaveBeenCalledWith("rebind.example.com");
		expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
		expect(route.fallback).not.toHaveBeenCalled();
		expect(route.fulfill).not.toHaveBeenCalled();
	});

	it("fails closed when the hostname cannot be resolved", async () => {
		const fetchPinned = createBrowserPinnedFetch({ lookup: lookupFor({}) });
		const route = fakeRoute("https://nx.example.com/");
		await handleGuardedRoute(route, fetchPinned);
		expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
		expect(route.fallback).not.toHaveBeenCalled();
	});

	it("relays a public request through the pinned fetch and fulfills the response", async () => {
		const fetchPinned = vi.fn(
			async (_url: string, _init: RequestInit) =>
				new Response(Buffer.from("<html>hello</html>"), {
					status: 200,
					headers: [
						["content-type", "text/html; charset=utf-8"],
						["content-encoding", "gzip"],
						["content-length", "9999"],
						["transfer-encoding", "chunked"],
						["set-cookie", "a=1; Path=/"],
						[
							"set-cookie",
							"b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
						],
					],
				}),
		);
		const route = fakeRoute("https://public.example.com/form", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				cookie: "session=abc",
				"accept-encoding": "gzip, deflate, br, zstd",
				host: "public.example.com",
				connection: "keep-alive",
				"content-length": "7",
			},
			body: Buffer.from("q=hello"),
		});

		await handleGuardedRoute(route, fetchPinned);

		expect(route.fallback).not.toHaveBeenCalled();
		expect(route.abort).not.toHaveBeenCalled();
		expect(fetchPinned).toHaveBeenCalledTimes(1);
		const [url, init] = fetchPinned.mock.calls[0];
		expect(url).toBe("https://public.example.com/form");
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			"content-type": "application/x-www-form-urlencoded",
			cookie: "session=abc",
		});
		expect(init.body).toBeInstanceOf(Uint8Array);
		expect(Buffer.from(init.body as Uint8Array).toString()).toBe("q=hello");

		expect(route.fulfill).toHaveBeenCalledTimes(1);
		const [fulfilled] = route.fulfill.mock.calls[0] as unknown as [
			{ status: number; headers: Record<string, string>; body: Buffer },
		];
		expect(fulfilled.status).toBe(200);
		expect(fulfilled.headers).toEqual({
			"content-type": "text/html; charset=utf-8",
			"set-cookie":
				"a=1; Path=/\nb=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
		});
		expect(fulfilled.body.toString()).toBe("<html>hello</html>");
	});

	it("never fulfills a navigation redirect as a 3xx, which Chromium would follow without the route; it answers a refresh page instead", async () => {
		const fetchPinned = vi.fn(async () =>
			redirectTo('http://169.254.169.254/latest/?a=1&b="x"', 302, [
				"hop=1; Path=/",
			]),
		);
		const route = fakeRoute("https://public.example.com/go", {
			navigation: true,
			frame: {},
		});
		await handleGuardedRoute(route, fetchPinned);
		expect(fetchPinned).toHaveBeenCalledTimes(1);
		const [fulfilled] = route.fulfill.mock.calls[0] as unknown as [
			{ status: number; headers: Record<string, string>; body: Buffer },
		];
		expect(fulfilled.status).toBe(200);
		expect(fulfilled.headers.location).toBeUndefined();
		expect(fulfilled.headers["set-cookie"]).toBe("hop=1; Path=/");
		expect(fulfilled.body.toString()).toContain(
			'http-equiv="refresh" content="0;url=http://169.254.169.254/latest/?a=1&amp;b=%22x%22"',
		);

		// The refresh is a new navigation; the route refuses it there.
		const next = fakeRoute("http://169.254.169.254/latest/", {
			navigation: true,
		});
		await handleGuardedRoute(next, neverFetch());
		expect(next.abort).toHaveBeenCalledWith("blockedbyclient");
	});

	it.each([
		"javascript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"file:///etc/passwd",
		"about:blank",
	])(
		"refuses a navigation redirect to a non-http(s) target (%s)",
		async (location) => {
			const route = fakeRoute("https://public.example.com/go", {
				navigation: true,
				frame: {},
			});
			await handleGuardedRoute(
				route,
				vi.fn(async () => redirectTo(location)),
			);
			expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
			expect(route.fulfill).not.toHaveBeenCalled();
		},
	);

	it.each([307, 308])(
		"refuses a %i navigation redirect that would replay a POST, instead of downgrading it to GET",
		async (status) => {
			const route = fakeRoute("https://public.example.com/submit", {
				navigation: true,
				method: "POST",
				body: Buffer.from("a=1"),
				frame: {},
			});
			await handleGuardedRoute(
				route,
				vi.fn(async () =>
					redirectTo("https://public.example.com/next", status),
				),
			);
			expect(route.abort).toHaveBeenCalledWith("failed");
			expect(route.fulfill).not.toHaveBeenCalled();
		},
	);

	it("still refreshes a 307 navigation redirect of a GET", async () => {
		const route = fakeRoute("https://public.example.com/page", {
			navigation: true,
			frame: {},
		});
		await handleGuardedRoute(
			route,
			vi.fn(async () =>
				redirectTo("https://public.example.com/moved", 307),
			),
		);
		expect(route.fulfill).toHaveBeenCalledTimes(1);
		expect(route.abort).not.toHaveBeenCalled();
	});

	it("caps a chain of refresh navigations in one frame, counting across the refresh pages", async () => {
		const frame = {};
		let n = 0;
		const fetchPinned = vi.fn(async () =>
			redirectTo(`https://loop.example.com/${++n}`),
		);
		let url = "https://loop.example.com/0";
		for (let hop = 1; hop <= BROWSER_RELAY_MAX_REDIRECTS; hop++) {
			const route = fakeRoute(url, { navigation: true, frame });
			await handleGuardedRoute(route, fetchPinned);
			expect(route.fulfill).toHaveBeenCalledTimes(1);
			// The refresh page's target is the frame's next navigation.
			url = `https://loop.example.com/${n}`;
		}
		const last = fakeRoute(url, { navigation: true, frame });
		await handleGuardedRoute(last, fetchPinned);
		expect(last.abort).toHaveBeenCalledWith("failed");
		expect(last.fulfill).not.toHaveBeenCalled();
	});

	it("starts a new chain when the frame navigates somewhere other than the pending refresh target", async () => {
		const frame = {};
		const fetchPinned = vi.fn(async () =>
			redirectTo("https://loop.example.com/next"),
		);
		for (let hop = 1; hop <= BROWSER_RELAY_MAX_REDIRECTS; hop++) {
			await handleGuardedRoute(
				fakeRoute("https://loop.example.com/next", {
					navigation: true,
					frame,
				}),
				fetchPinned,
			);
		}
		// A navigation elsewhere clears the chain, so its redirect is hop 1.
		const elsewhere = fakeRoute("https://other.example.com/", {
			navigation: true,
			frame,
		});
		await handleGuardedRoute(elsewhere, fetchPinned);
		expect(elsewhere.fulfill).toHaveBeenCalledTimes(1);
	});

	it("does not carry a chain across frames", async () => {
		const fetchPinned = vi.fn(async () =>
			redirectTo("https://loop.example.com/next"),
		);
		const a = {};
		for (let hop = 1; hop <= BROWSER_RELAY_MAX_REDIRECTS; hop++) {
			await handleGuardedRoute(
				fakeRoute("https://loop.example.com/next", {
					navigation: true,
					frame: a,
				}),
				fetchPinned,
			);
		}
		const other = fakeRoute("https://loop.example.com/next", {
			navigation: true,
			frame: {},
		});
		await handleGuardedRoute(other, fetchPinned);
		expect(other.fulfill).toHaveBeenCalledTimes(1);
	});

	it("follows a subresource redirect in the relay, refusing a hop to a private address without fetching it", async () => {
		const fetchPinned = vi.fn(async () =>
			redirectTo("http://169.254.169.254/latest/"),
		);
		const route = fakeRoute("http://public.example.com/api", {
			resourceType: "fetch",
		});
		await handleGuardedRoute(route, fetchPinned);
		expect(fetchPinned).toHaveBeenCalledTimes(1);
		expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
		expect(route.fulfill).not.toHaveBeenCalled();
	});

	it("refuses a subresource redirect to a non-http(s) target", async () => {
		const route = fakeRoute("https://public.example.com/api", {
			resourceType: "fetch",
		});
		await handleGuardedRoute(
			route,
			vi.fn(async () => redirectTo("file:///etc/passwd")),
		);
		expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
	});

	it.each([
		["another host", "https://b.example.com/landing"],
		["another scheme", "http://a.example.com/go"],
		["another port", "https://a.example.com:8443/go"],
	])(
		"refuses a subresource redirect to %s without fetching it, whatever the request carried",
		async (_label, location) => {
			const requests: Array<{
				method: string;
				headers: Record<string, string>;
				body?: Buffer;
			}> = [
				{ method: "GET", headers: {} },
				{
					method: "POST",
					headers: { authorization: "Bearer a", cookie: "s=1" },
					body: Buffer.from("x=1"),
				},
			];
			for (const request of requests) {
				const fetchPinned = vi.fn(async () => redirectTo(location));
				const route = fakeRoute("https://a.example.com/go", {
					resourceType: "fetch",
					...request,
				});
				await handleGuardedRoute(route, fetchPinned);
				expect(fetchPinned).toHaveBeenCalledTimes(1);
				expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
				expect(route.fulfill).not.toHaveBeenCalled();
			}
			expect(console.warn).toHaveBeenCalledWith(
				expect.stringMatching(/cross-origin redirect/),
			);
		},
	);

	it("passes every hop's Set-Cookie to Chromium in wire order, pinning a hop's cookie without Path to that hop's default-path", async () => {
		const fetchPinned = vi.fn(async (url: string, _init: RequestInit) => {
			if (url === "https://a.example.com/start") {
				return redirectTo("/auth/step", 302, [
					"first=1",
					"sid=new; Path=/",
				]);
			}
			if (url === "https://a.example.com/auth/step") {
				return redirectTo("/done", 302, [
					"sid=; Max-Age=0; Path=/",
					"hop=2",
				]);
			}
			return new Response("done", {
				status: 200,
				headers: [
					["content-type", "text/plain"],
					["set-cookie", "last=3; Path=/"],
				],
			});
		});
		const route = fakeRoute("https://a.example.com/start", {
			resourceType: "fetch",
		});
		await handleGuardedRoute(route, fetchPinned);
		const [fulfilled] = route.fulfill.mock.calls[0] as unknown as [
			{ status: number; headers: Record<string, string>; body: Buffer },
		];
		expect(fulfilled.status).toBe(200);
		expect(fulfilled.headers["set-cookie"].split("\n")).toEqual([
			// The first response is the one Chromium requested: unchanged.
			"first=1",
			"sid=new; Path=/",
			"sid=; Max-Age=0; Path=/",
			"hop=2; Path=/auth",
			"last=3; Path=/",
		]);
	});

	it("never hands Chromium a Partitioned cookie, which it would store unpartitioned from a fulfilled response", async () => {
		const partitioned = "p=1; Secure; SameSite=None; Path=/; Partitioned";
		// A plain relayed response.
		const plain = fakeRoute("https://a.example.com/set", {
			resourceType: "fetch",
		});
		await handleGuardedRoute(
			plain,
			vi.fn(
				async () =>
					new Response("ok", {
						status: 200,
						headers: [
							["set-cookie", "a=1; Path=/"],
							["set-cookie", partitioned],
						],
					}),
			),
		);
		const [plainFulfilled] = plain.fulfill.mock.calls[0] as unknown as [
			{ headers: Record<string, string> },
		];
		expect(plainFulfilled.headers["set-cookie"]).toBe("a=1; Path=/");

		// A followed chain.
		const chained = fakeRoute("https://a.example.com/start", {
			resourceType: "fetch",
		});
		await handleGuardedRoute(
			chained,
			vi.fn(async (url: string) =>
				url === "https://a.example.com/start"
					? redirectTo("/end", 302, [partitioned])
					: new Response("end", { status: 200 }),
			),
		);
		const [chainFulfilled] = chained.fulfill.mock.calls[0] as unknown as [
			{ headers: Record<string, string> },
		];
		expect(chainFulfilled.headers["set-cookie"]).toBeUndefined();

		// A navigation refresh page.
		const navigation = fakeRoute("https://a.example.com/login", {
			navigation: true,
			frame: {},
		});
		await handleGuardedRoute(
			navigation,
			vi.fn(async () =>
				redirectTo("https://a.example.com/home", 302, [
					partitioned,
					"n=1",
				]),
			),
		);
		const [refresh] = navigation.fulfill.mock.calls[0] as unknown as [
			{ headers: Record<string, string> },
		];
		expect(refresh.headers["set-cookie"]).toBe("n=1");
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringMatching(/Dropped 1 Partitioned cookie/),
		);
	});

	it("sends follow-up hops no Cookie header, neither the original nor one set by an earlier hop", async () => {
		// Chromium picked the first hop's cookies by that URL's path and the
		// request's credentials mode; a flat header cannot be re-scoped to
		// another path, so the relay fails closed and sends none onward.
		const fetchPinned = vi.fn(async (url: string, _init: RequestInit) =>
			url === "https://a.example.com/app/login"
				? redirectTo("/other/home", 302, ["fresh=1", "sid=; Max-Age=0"])
				: new Response("home", { status: 200 }),
		);
		const route = fakeRoute("https://a.example.com/app/login", {
			resourceType: "fetch",
			headers: {
				cookie: "sid=old; scoped=only-app",
				authorization: "Bearer a",
			},
		});
		await handleGuardedRoute(route, fetchPinned);
		const first = new Headers(fetchPinned.mock.calls[0]?.[1].headers);
		expect(first.get("cookie")).toBe("sid=old; scoped=only-app");
		const second = new Headers(fetchPinned.mock.calls[1]?.[1].headers);
		expect(second.get("cookie")).toBeNull();
		expect(second.get("authorization")).toBe("Bearer a");
		// Chromium still receives every hop's Set-Cookie in wire order. The
		// first hop is the URL Chromium itself requested, so its cookies need
		// no default-path of their own.
		const [fulfilled] = route.fulfill.mock.calls[0] as unknown as [
			{ headers: Record<string, string> },
		];
		expect(fulfilled.headers["set-cookie"].split("\n")).toEqual([
			"fresh=1",
			"sid=; Max-Age=0",
		]);
	});

	it("logs a dropped Partitioned cookie without the URL's query string or credentials", async () => {
		const fetchPinned = vi.fn(async () => {
			const response = new Response("ok", {
				status: 200,
				headers: [["set-cookie", "p=1; Secure; Partitioned; Path=/"]],
			});
			// A real pinned fetch reports the URL it fetched.
			Object.defineProperty(response, "url", {
				value: "https://user:pass@example.com/cb?code=secret-token#frag",
			});
			return response;
		});
		const route = fakeRoute(
			"https://user:pass@example.com/cb?code=secret-token#frag",
			{ resourceType: "fetch" },
		);
		await handleGuardedRoute(route, fetchPinned);
		const warned = (
			console.warn as unknown as { mock: { calls: unknown[][] } }
		).mock.calls
			.map((call) => String(call[0]))
			.filter((line) => line.includes("Partitioned"));
		expect(warned.length).toBeGreaterThan(0);
		expect(warned.join("\n")).toContain("https://example.com/cb");
		for (const line of warned) {
			expect(line).not.toContain("secret-token");
			expect(line).not.toContain("pass");
			expect(line).not.toContain("frag");
		}
	});

	it("adds no cookie to follow-up hops when Chromium sent none on the original request", async () => {
		const fetchPinned = vi.fn(async (url: string, _init: RequestInit) =>
			url === "https://a.example.com/login"
				? redirectTo("/home", 302, ["fresh=1; Path=/"])
				: new Response("home", { status: 200 }),
		);
		const route = fakeRoute("https://a.example.com/login", {
			resourceType: "fetch",
		});
		await handleGuardedRoute(route, fetchPinned);
		expect(
			new Headers(fetchPinned.mock.calls[1]?.[1].headers).get("cookie"),
		).toBeNull();
		// Chromium still receives the Set-Cookie, and decides by the
		// request's credentials mode whether to store it.
		const [fulfilled] = route.fulfill.mock.calls[0] as unknown as [
			{ headers: Record<string, string> },
		];
		expect(fulfilled.headers["set-cookie"]).toBe("fresh=1; Path=/");
	});

	it("keeps the Authorization header on a same-origin subresource redirect and switches a POST to GET on 303", async () => {
		const fetchPinned = vi.fn(async (url: string, _init: RequestInit) =>
			url === "https://a.example.com/submit"
				? redirectTo("/done", 303)
				: new Response("done", { status: 200 }),
		);
		const route = fakeRoute("https://a.example.com/submit", {
			method: "POST",
			resourceType: "fetch",
			headers: { authorization: "Bearer a-secret" },
			body: Buffer.from("x=1"),
		});
		await handleGuardedRoute(route, fetchPinned);
		const [nextUrl, nextInit] = fetchPinned.mock.calls[1];
		expect(nextUrl).toBe("https://a.example.com/done");
		expect(nextInit.method).toBe("GET");
		expect(nextInit.body).toBeUndefined();
		expect(new Headers(nextInit.headers).get("authorization")).toBe(
			"Bearer a-secret",
		);
	});

	it("gives up after too many subresource redirects", async () => {
		let n = 0;
		const fetchPinned = vi.fn(async () =>
			redirectTo(`https://loop.example.com/${++n}`),
		);
		const route = fakeRoute("https://loop.example.com/0", {
			resourceType: "fetch",
		});
		await handleGuardedRoute(route, fetchPinned);
		expect(fetchPinned).toHaveBeenCalledTimes(
			BROWSER_RELAY_MAX_REDIRECTS + 1,
		);
		expect(route.abort).toHaveBeenCalledWith("failed");
		expect(route.fulfill).not.toHaveBeenCalled();
	});

	describe("one deadline for a whole redirect chain", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("aborts a later hop when the chain's shared budget runs out, rather than giving each hop a fresh one", async () => {
			vi.useFakeTimers();
			const signals: AbortSignal[] = [];
			const fetchPinned = vi.fn(
				(url: string, init: RequestInit) =>
					new Promise<Response>((resolve, reject) => {
						const signal = init.signal as AbortSignal;
						signals.push(signal);
						if (url === "https://slow.example.com/first") {
							// The first hop takes most of the budget.
							setTimeout(
								() =>
									resolve(
										redirectTo(
											"https://slow.example.com/second",
										),
									),
								BROWSER_PINNED_FETCH_TIMEOUT_MS - 1_000,
							);
							return;
						}
						// The second hop never answers on its own.
						signal.addEventListener(
							"abort",
							() => reject(signal.reason),
							{
								once: true,
							},
						);
					}),
			);
			const route = fakeRoute("https://slow.example.com/first", {
				resourceType: "fetch",
			});
			const handled = handleGuardedRoute(route, fetchPinned);

			await vi.advanceTimersByTimeAsync(
				BROWSER_PINNED_FETCH_TIMEOUT_MS - 1_000,
			);
			expect(fetchPinned).toHaveBeenCalledTimes(2);
			expect(route.abort).not.toHaveBeenCalled();

			// Just over the original budget: a fresh per-hop deadline would
			// still have 29 s left; the shared one has run out.
			await vi.advanceTimersByTimeAsync(1_001);
			await handled;
			expect(route.abort).toHaveBeenCalledWith("failed");
			expect(signals[1]).toBe(signals[0]);
			expect(signals[0].aborted).toBe(true);
			expect((signals[0].reason as DOMException).name).toBe(
				"TimeoutError",
			);
		});
	});

	it("aborts a blocked resource type on a public host before relaying it, so blockResources is not bypassed by the relay", async () => {
		const relay = neverFetch();
		const image = fakeRoute("https://public.example.com/hero.png", {
			resourceType: "image",
		});
		await handleGuardedRoute(image, relay, {
			blockResourceTypes: ["image", "font"],
		});
		expect(image.abort).toHaveBeenCalledWith("blockedbyclient");
		expect(image.fallback).not.toHaveBeenCalled();
		expect(image.fulfill).not.toHaveBeenCalled();
		expect(relay).not.toHaveBeenCalled();

		// A type the session did not block on the same host is still relayed.
		const fetchPinned = vi.fn(
			async () => new Response("ok", { status: 200 }),
		);
		const document = fakeRoute("https://public.example.com/page", {
			resourceType: "document",
		});
		await handleGuardedRoute(document, fetchPinned, {
			blockResourceTypes: ["image", "font"],
		});
		expect(fetchPinned).toHaveBeenCalledTimes(1);
		expect(document.fulfill).toHaveBeenCalledTimes(1);
		expect(document.abort).not.toHaveBeenCalled();
	});

	it("aborts a blocked resource type on a declared host too, without falling back", async () => {
		setEnv(BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV, "localhost");
		const font = fakeRoute("http://localhost:3001/font.woff2", {
			resourceType: "font",
		});
		await handleGuardedRoute(font, neverFetch(), {
			blockResourceTypes: ["font"],
		});
		expect(font.abort).toHaveBeenCalledWith("blockedbyclient");
		expect(font.fallback).not.toHaveBeenCalled();
	});

	it("aborts as failed when the relay itself fails for a reason other than the destination", async () => {
		const fetchPinned = vi.fn(async (_url: string, _init: RequestInit) => {
			throw new Error("connect ETIMEDOUT");
		});
		const route = fakeRoute("https://public.example.com/slow");
		await handleGuardedRoute(route, fetchPinned);
		expect(route.abort).toHaveBeenCalledWith("failed");
		expect(route.fulfill).not.toHaveBeenCalled();
	});
});

describe("websocket handler", () => {
	it("closes a socket to a private address before any connection", async () => {
		// A refusal fixture, never connected to: an unencrypted WebSocket is closed too.
		// nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
		const socket = fakeSocket("ws://10.0.0.1/socket");
		await handleGuardedWebSocket(socket);
		expect(socket.connectToServer).not.toHaveBeenCalled();
		expect(socket.close).toHaveBeenCalledWith(
			expect.objectContaining({ code: 1008 }),
		);
	});

	it("closes a socket to an undeclared public host, since it cannot be relayed through the pinned fetch", async () => {
		const socket = fakeSocket("wss://public.example.com/socket");
		await handleGuardedWebSocket(socket);
		expect(socket.connectToServer).not.toHaveBeenCalled();
		expect(socket.close).toHaveBeenCalledTimes(1);
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringMatching(
				new RegExp(BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV),
			),
		);
	});

	it("connects a socket to a declared host", async () => {
		setEnv(BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV, "localhost");
		const socket = fakeSocket("ws://localhost:3001/hmr");
		await handleGuardedWebSocket(socket);
		expect(socket.connectToServer).toHaveBeenCalledTimes(1);
		expect(socket.close).not.toHaveBeenCalled();
	});
});

describe("installation", () => {
	it("registers a catch-all HTTP route and a catch-all WebSocket route on the context", async () => {
		// The guard gets only the two routing methods: it has no way to read
		// or write the context's cookie store, and any other access throws.
		const context = new Proxy(
			{
				route: vi.fn(async () => undefined),
				routeWebSocket: vi.fn(async () => undefined),
			},
			{
				get(target, key) {
					if (
						key === "route" ||
						key === "routeWebSocket" ||
						key === "then"
					) {
						return target[key as "route"];
					}
					throw new Error(`guard touched context.${String(key)}`);
				},
			},
		);
		await installOutboundRequestGuard(context, neverFetch(), {
			blockResourceTypes: ["media"],
		});

		expect(context.route).toHaveBeenCalledTimes(1);
		const [pattern, handler] = context.route.mock.calls[0] as unknown as [
			string,
			(route: ReturnType<typeof fakeRoute>) => Promise<void>,
		];
		expect(pattern).toBe("**/*");
		const route = fakeRoute("http://10.0.0.1/");
		await handler(route);
		expect(route.abort).toHaveBeenCalledWith("blockedbyclient");
		// The session's resource blocking reaches the installed handler.
		const media = fakeRoute("https://public.example.com/clip.mp4", {
			resourceType: "media",
		});
		await handler(media);
		expect(media.abort).toHaveBeenCalledWith("blockedbyclient");
		expect(media.fulfill).not.toHaveBeenCalled();

		expect(context.routeWebSocket).toHaveBeenCalledTimes(1);
		const [matcher, socketHandler] = context.routeWebSocket.mock
			.calls[0] as unknown as [
			(url: URL) => boolean,
			(socket: ReturnType<typeof fakeSocket>) => Promise<void>,
		];
		expect(matcher(new URL("wss://anything.example.com/"))).toBe(true);
		const socket = fakeSocket("wss://public.example.com/socket");
		await socketHandler(socket);
		expect(socket.connectToServer).not.toHaveBeenCalled();
		expect(socket.close).toHaveBeenCalledTimes(1);
	});
});

describe("browser-navigate step", () => {
	it("refuses an internal URL before launching a browser", async () => {
		vi.doMock("../src/activities/browser-automation", () => ({
			createBrowserSession: vi.fn(),
			navigateToUrl: vi.fn(),
			extractContent: vi.fn(),
			closeBrowserSession: vi.fn(),
		}));
		const automation = await import("../src/activities/browser-automation");
		const { executeBrowserNavigateStep } = await import(
			"../src/activities/lib/steps/browser-navigate"
		);

		const result = await executeBrowserNavigateStep({
			nodeConfig: { url: "http://169.254.169.254/latest/meta-data/" },
			inputs: {},
			userId: "user-1",
			organizationId: "org-1",
		} as never);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(
			/URL rejected.*BROWSER_AUTOMATION_ALLOWED_HOSTS/s,
		);
		expect(automation.createBrowserSession).not.toHaveBeenCalled();
		vi.doUnmock("../src/activities/browser-automation");
	});
});
