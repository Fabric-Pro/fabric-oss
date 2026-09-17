/**
 * `safeFetchOutboundPinned` and the safe JSON / YAML helpers (plan Slice 4
 * outbound-fetch hardening).
 *
 * DNS is mocked so no test resolves or connects to anything real; the happy
 * path uses an injected undici MockAgent with network connections disabled.
 */
import { MockAgent } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));

vi.mock("node:dns", () => ({
	promises: { lookup: mockLookup },
}));

import {
	assertMaxDepth,
	parseJsonOrYamlSafe,
	parseJsonSafe,
	parseYamlSafe,
	UnsafeDocumentError,
} from "../lib/safe-yaml";
import {
	isPrivateIp,
	OutboundResponseRejectedError,
	PINNED_FETCH_ANY_CONTENT_TYPE,
	pinnedConnectLookup,
	resolvePinnedAddress,
	safeFetchOutboundPinned,
	UnsafeOutboundUrlError,
	withoutCrossOriginCredentials,
} from "../lib/url-security";

const PUBLIC_V4 = "93.184.216.34";

function answers(...addresses: string[]) {
	return addresses.map((address) => ({
		address,
		family: address.includes(":") ? 6 : 4,
	}));
}

function mockAgentWithNoNetwork(): MockAgent {
	const agent = new MockAgent();
	agent.disableNetConnect();
	return agent;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockLookup.mockResolvedValue(answers(PUBLIC_V4));
});

describe("isPrivateIp", () => {
	it.each([
		["10.0.0.1", true],
		["127.0.0.1", true],
		["169.254.169.254", true],
		["172.16.0.1", true],
		["172.31.255.255", true],
		["172.32.0.1", false],
		["192.168.1.1", true],
		["100.64.0.1", true],
		["100.127.255.255", true],
		["100.128.0.1", false],
		["0.0.0.0", true],
		["224.0.0.1", true],
		["255.255.255.255", true],
		["8.8.8.8", false],
		[PUBLIC_V4, false],
		["::1", true],
		["::", true],
		["fc00::1", true],
		["fd12:3456::1", true],
		["fe80::1", true],
		["fec0::1", true],
		["ff02::1", true],
		["::ffff:127.0.0.1", true],
		["::ffff:10.1.2.3", true],
		// IPv4-mapped forms are refused outright (IPv6 allowlist), even public.
		["::ffff:8.8.8.8", true],
		["::10.0.0.1", true],
		["64:ff9b::10.0.0.1", true],
		["64:ff9b::808:808", true], // NAT64 is outside 2000::/3
		["2606:2800:220:1:248:1893:25c8:1946", false],
		["not-an-ip", true],
	])("%s → %s", (ip, expected) => {
		expect(isPrivateIp(ip)).toBe(expected);
	});
});

describe("resolvePinnedAddress", () => {
	it("rejects the cloud metadata address before any DNS lookup", async () => {
		await expect(
			resolvePinnedAddress("http://169.254.169.254/latest/meta-data"),
		).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
		expect(mockLookup).not.toHaveBeenCalled();
	});

	it("rejects localhost before any DNS lookup", async () => {
		await expect(
			resolvePinnedAddress("http://localhost:3000/openapi.json"),
		).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
		expect(mockLookup).not.toHaveBeenCalled();
	});

	it("rejects a public hostname that resolves to a private address", async () => {
		mockLookup.mockResolvedValue(answers("10.0.0.5"));
		await expect(
			resolvePinnedAddress("https://internal.example.com/spec"),
		).rejects.toThrow(/non-public/);
		expect(mockLookup).toHaveBeenCalledWith("internal.example.com", {
			all: true,
		});
	});

	it("rejects when any of several answers is private (split horizon / rebinding)", async () => {
		mockLookup.mockResolvedValue(answers(PUBLIC_V4, "192.168.1.10"));
		await expect(
			resolvePinnedAddress("https://api.example.com/spec"),
		).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
	});

	it("rejects an IPv6-mapped loopback answer", async () => {
		mockLookup.mockResolvedValue(answers("::ffff:127.0.0.1"));
		await expect(
			resolvePinnedAddress("https://api.example.com/spec"),
		).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
	});

	it("rejects a hostname with no answers or a failed lookup", async () => {
		mockLookup.mockResolvedValue([]);
		await expect(
			resolvePinnedAddress("https://nowhere.example.com/"),
		).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
		mockLookup.mockRejectedValue(new Error("ENOTFOUND"));
		await expect(
			resolvePinnedAddress("https://nowhere.example.com/"),
		).rejects.toThrow(/Could not resolve/);
	});

	it("returns the first public answer and keeps the original hostname", async () => {
		mockLookup.mockResolvedValue(answers(PUBLIC_V4, "2606:2800:220:1::1"));
		const result = await resolvePinnedAddress(
			"https://api.example.com/spec",
		);
		expect(result.address).toEqual({ address: PUBLIC_V4, family: 4 });
		expect(result.url.hostname).toBe("api.example.com");
	});
});

describe("safeFetchOutboundPinned", () => {
	it("never dispatches to a private target", async () => {
		const agent = mockAgentWithNoNetwork();
		mockLookup.mockResolvedValue(answers("10.0.0.5"));
		await expect(
			safeFetchOutboundPinned(
				"https://internal.example.com/spec",
				undefined,
				{ dispatcher: agent },
			),
		).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
		expect(agent.pendingInterceptors()).toHaveLength(0);
	});

	it("rejects a body larger than maxBytes while streaming", async () => {
		const agent = mockAgentWithNoNetwork();
		agent
			.get("https://api.example.com")
			.intercept({ path: "/big.json", method: "GET" })
			.reply(200, `{"pad":"${"x".repeat(500)}"}`, {
				headers: { "content-type": "application/json" },
			});
		await expect(
			safeFetchOutboundPinned(
				"https://api.example.com/big.json",
				undefined,
				{
					dispatcher: agent,
					maxBytes: 100,
				},
			),
		).rejects.toMatchObject({
			name: "OutboundResponseRejectedError",
			code: "RESPONSE_TOO_LARGE",
		});
	});

	it("rejects a declared content-length above maxBytes before reading", async () => {
		const agent = mockAgentWithNoNetwork();
		agent
			.get("https://api.example.com")
			.intercept({ path: "/declared.json", method: "GET" })
			.reply(200, "{}", {
				headers: {
					"content-type": "application/json",
					"content-length": "999999",
				},
			});
		await expect(
			safeFetchOutboundPinned(
				"https://api.example.com/declared.json",
				undefined,
				{ dispatcher: agent, maxBytes: 1_000 },
			),
		).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
	});

	it("rejects a disallowed content type", async () => {
		const agent = mockAgentWithNoNetwork();
		agent
			.get("https://api.example.com")
			.intercept({ path: "/page", method: "GET" })
			.reply(200, "<html></html>", {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		await expect(
			safeFetchOutboundPinned("https://api.example.com/page", undefined, {
				dispatcher: agent,
			}),
		).rejects.toMatchObject({
			name: "OutboundResponseRejectedError",
			code: "CONTENT_TYPE_NOT_ALLOWED",
		});
	});

	it("rejects a response without a content type (fail closed)", async () => {
		const agent = mockAgentWithNoNetwork();
		agent
			.get("https://api.example.com")
			.intercept({ path: "/none", method: "GET" })
			.reply(200, "{}");
		await expect(
			safeFetchOutboundPinned("https://api.example.com/none", undefined, {
				dispatcher: agent,
			}),
		).rejects.toBeInstanceOf(OutboundResponseRejectedError);
	});

	it("returns a buffered Response on the happy path", async () => {
		const agent = mockAgentWithNoNetwork();
		agent
			.get("https://api.example.com")
			.intercept({ path: "/openapi.json", method: "GET" })
			.reply(200, JSON.stringify({ openapi: "3.0.0", paths: {} }), {
				headers: { "content-type": "application/json; charset=utf-8" },
			});
		const response = await safeFetchOutboundPinned(
			"https://api.example.com/openapi.json",
			{ headers: { accept: "application/json" } },
			{ dispatcher: agent },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain(
			"application/json",
		);
		await expect(response.json()).resolves.toEqual({
			openapi: "3.0.0",
			paths: {},
		});
		expect(mockLookup).toHaveBeenCalledWith("api.example.com", {
			all: true,
		});
	});

	it("re-validates every redirect hop and rejects one that lands on a private host", async () => {
		const agent = mockAgentWithNoNetwork();
		agent
			.get("https://api.example.com")
			.intercept({ path: "/old", method: "GET" })
			.reply(302, "", {
				headers: { location: "https://internal.example.com/new" },
			});
		mockLookup.mockImplementation(async (hostname: string) =>
			hostname === "internal.example.com"
				? answers("172.16.5.5")
				: answers(PUBLIC_V4),
		);
		await expect(
			safeFetchOutboundPinned("https://api.example.com/old", undefined, {
				dispatcher: agent,
			}),
		).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
		expect(mockLookup).toHaveBeenCalledWith("internal.example.com", {
			all: true,
		});
	});

	it("follows a public redirect and caps the number of hops", async () => {
		const agent = mockAgentWithNoNetwork();
		const pool = agent.get("https://api.example.com");
		pool.intercept({ path: "/a", method: "GET" }).reply(301, "", {
			headers: { location: "/b" },
		});
		pool.intercept({ path: "/b", method: "GET" }).reply(200, "ok: true\n", {
			headers: { "content-type": "application/yaml" },
		});
		const response = await safeFetchOutboundPinned(
			"https://api.example.com/a",
			undefined,
			{ dispatcher: agent },
		);
		await expect(response.text()).resolves.toBe("ok: true\n");

		const loop = mockAgentWithNoNetwork();
		const loopPool = loop.get("https://api.example.com");
		for (const path of ["/1", "/2", "/3", "/4", "/5"]) {
			loopPool.intercept({ path, method: "GET" }).reply(302, "", {
				headers: { location: `/${Number(path.slice(1)) + 1}` },
			});
		}
		await expect(
			safeFetchOutboundPinned("https://api.example.com/1", undefined, {
				dispatcher: loop,
			}),
		).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
	});
});

describe("pinnedConnectLookup", () => {
	it("answers Node's all-addresses call with an array holding only the pinned address", () => {
		const callback = vi.fn();
		pinnedConnectLookup({ address: PUBLIC_V4, family: 4 })(
			"site.example.com",
			{ all: true },
			callback,
		);
		expect(callback).toHaveBeenCalledWith(null, [
			{ address: PUBLIC_V4, family: 4 },
		]);
	});

	it("answers a single-address call with the pinned address and family", () => {
		const callback = vi.fn();
		pinnedConnectLookup({ address: "2606:2800:220:1::1", family: 6 })(
			"site.example.com",
			{},
			callback,
		);
		expect(callback).toHaveBeenCalledWith(null, "2606:2800:220:1::1", 6);
	});
});

describe("safeFetchOutboundPinned redirect credentials", () => {
	it("drops Authorization and Cookie when a followed redirect changes origin, and keeps other headers", async () => {
		const agent = mockAgentWithNoNetwork();
		const seen: Record<string, string>[] = [];
		agent
			.get("https://a.example.com")
			.intercept({ path: "/go", method: "GET" })
			.reply((options) => {
				seen.push(options.headers as Record<string, string>);
				return {
					statusCode: 302,
					data: "",
					responseOptions: {
						headers: { location: "https://b.example.com/landing" },
					},
				};
			});
		agent
			.get("https://b.example.com")
			.intercept({ path: "/landing", method: "GET" })
			.reply((options) => {
				seen.push(options.headers as Record<string, string>);
				return {
					statusCode: 200,
					data: "ok",
					responseOptions: {
						headers: { "content-type": "text/plain" },
					},
				};
			});
		const response = await safeFetchOutboundPinned(
			"https://a.example.com/go",
			{
				headers: {
					authorization: "Bearer a-secret",
					cookie: "session=a",
					"x-request-id": "r1",
				},
			},
			{ dispatcher: agent },
		);
		expect(await response.text()).toBe("ok");
		const lower = (h: Record<string, string>) =>
			Object.fromEntries(
				Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]),
			);
		expect(lower(seen[0])).toMatchObject({
			authorization: "Bearer a-secret",
			cookie: "session=a",
		});
		expect(lower(seen[1]).authorization).toBeUndefined();
		expect(lower(seen[1]).cookie).toBeUndefined();
		expect(lower(seen[1])["x-request-id"]).toBe("r1");
	});

	it("strips only credential headers", () => {
		const out = withoutCrossOriginCredentials({
			Authorization: "a",
			Cookie: "b",
			"Proxy-Authorization": "c",
			Accept: "text/html",
		});
		const names: string[] = [];
		out.forEach((_value, name) => {
			names.push(name);
		});
		expect(names).toEqual(["accept"]);
	});
});

describe("safeFetchOutboundPinned deadline", () => {
	it("times out a lookup that never answers, without attempting a fetch", async () => {
		// `AbortSignal.timeout` schedules on Node's internal timer, which fake
		// timers do not reach, so the deadline here is short and real.
		const agent = mockAgentWithNoNetwork();
		const lookup = vi.fn(
			() => new Promise<never>(() => {}) as Promise<never>,
		);
		const started = Date.now();
		await expect(
			safeFetchOutboundPinned("https://stalled.example.com/", undefined, {
				dispatcher: agent,
				lookup,
				timeoutMs: 50,
			}),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(lookup).toHaveBeenCalledTimes(1);
		// A fetch against the MockAgent with no interceptor would have thrown
		// a mock-not-matched error rather than the timeout; none was made.
		expect(agent.pendingInterceptors()).toHaveLength(0);
	});

	it("rejects at once when the caller's signal is already aborted, before any lookup", async () => {
		const lookup = vi.fn();
		const controller = new AbortController();
		controller.abort(new Error("caller gave up"));
		await expect(
			safeFetchOutboundPinned(
				"https://site.example.com/",
				{ signal: controller.signal },
				{ dispatcher: mockAgentWithNoNetwork(), lookup },
			),
		).rejects.toThrow("caller gave up");
		expect(lookup).not.toHaveBeenCalled();
	});
});

describe("safeFetchOutboundPinned as a relay (browser guard options)", () => {
	it("accepts any or no content type when asked to, keeping every Set-Cookie", async () => {
		const agent = mockAgentWithNoNetwork();
		agent
			.get("https://site.example.com")
			.intercept({ path: "/page", method: "GET" })
			.reply(200, "<html></html>", {
				headers: {
					"content-type": "text/html",
					"set-cookie": [
						"a=1; Path=/",
						"b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
					],
				},
			});
		agent
			.get("https://site.example.com")
			.intercept({ path: "/untyped", method: "GET" })
			.reply(200, "raw");
		const options = {
			dispatcher: agent,
			allowedContentTypes: [PINNED_FETCH_ANY_CONTENT_TYPE],
		};

		const page = await safeFetchOutboundPinned(
			"https://site.example.com/page",
			undefined,
			options,
		);
		expect(page.status).toBe(200);
		expect(page.headers.getSetCookie()).toEqual([
			"a=1; Path=/",
			"b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT",
		]);
		await expect(page.text()).resolves.toBe("<html></html>");

		const untyped = await safeFetchOutboundPinned(
			"https://site.example.com/untyped",
			undefined,
			options,
		);
		await expect(untyped.text()).resolves.toBe("raw");
	});

	it("still rejects a disallowed type unless the wildcard is given", async () => {
		const agent = mockAgentWithNoNetwork();
		agent
			.get("https://site.example.com")
			.intercept({ path: "/page", method: "GET" })
			.reply(200, "<html></html>", {
				headers: { "content-type": "text/html" },
			});
		await expect(
			safeFetchOutboundPinned(
				"https://site.example.com/page",
				undefined,
				{
					dispatcher: agent,
				},
			),
		).rejects.toBeInstanceOf(OutboundResponseRejectedError);
	});

	it("returns a redirect to the caller instead of following it when asked to", async () => {
		const agent = mockAgentWithNoNetwork();
		agent
			.get("https://site.example.com")
			.intercept({ path: "/go", method: "GET" })
			.reply(302, "", {
				headers: { location: "http://169.254.169.254/latest/" },
			});
		const response = await safeFetchOutboundPinned(
			"https://site.example.com/go",
			undefined,
			{
				dispatcher: agent,
				allowedContentTypes: [PINNED_FETCH_ANY_CONTENT_TYPE],
				followRedirects: false,
			},
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			"http://169.254.169.254/latest/",
		);
		// Nothing was fetched from the redirect target: the only lookup was
		// for the origin.
		expect(mockLookup).toHaveBeenCalledTimes(1);
		expect(agent.pendingInterceptors()).toHaveLength(0);
	});
});

describe("safe JSON / YAML parsing", () => {
	it("parses ordinary YAML and JSON", () => {
		expect(parseYamlSafe("openapi: 3.0.0\npaths:\n  /a: {}\n")).toEqual({
			openapi: "3.0.0",
			paths: { "/a": {} },
		});
		expect(parseJsonSafe('{"a":[1,2]}')).toEqual({ a: [1, 2] });
		expect(parseJsonOrYamlSafe('  {"a": 1}')).toEqual({ a: 1 });
		expect(parseJsonOrYamlSafe("a: 1")).toEqual({ a: 1 });
	});

	it("rejects a YAML alias bomb", () => {
		const bomb = [
			"a: &a [x, x, x, x, x, x, x, x, x, x]",
			"b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]",
			"c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]",
			"d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]",
			"e: [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]",
		].join("\n");
		expect(() => parseYamlSafe(bomb)).toThrow(UnsafeDocumentError);
		expect(() => parseYamlSafe(bomb)).toThrow(/alias/i);
	});

	it("rejects documents nested deeper than 50 levels", () => {
		const deepJson = `${"[".repeat(60)}${"]".repeat(60)}`;
		expect(() => parseJsonSafe(deepJson)).toThrow(
			expect.objectContaining({ code: "TOO_DEEP" }),
		);
		const deepYaml = `${"a:\n".replace("a:", "a:")}${Array.from({ length: 60 }, (_, i) => `${"  ".repeat(i)}k${i}:`).join("\n")}\n${"  ".repeat(60)}v: 1`;
		expect(() => parseYamlSafe(deepYaml)).toThrow(
			expect.objectContaining({ code: "TOO_DEEP" }),
		);
		expect(() => assertMaxDepth({ a: { b: { c: 1 } } }, 50)).not.toThrow();
	});

	it("rejects input above maxBytes before parsing", () => {
		expect(() => parseJsonSafe("[1]", { maxBytes: 2 })).toThrow(
			expect.objectContaining({ code: "TOO_LARGE" }),
		);
	});
});

describe("isPrivateIp — complete special-use denylist (review sprint3 #2)", () => {
	const denied = [
		"192.0.0.1", // IETF protocol assignments
		"192.0.2.10", // TEST-NET-1
		"192.88.99.1", // 6to4 anycast
		"198.18.0.1", // benchmarking /15
		"198.19.255.254",
		"198.51.100.7", // TEST-NET-2
		"203.0.113.9", // TEST-NET-3
		"2001:db8::1", // documentation
		"100::1", // discard-only
		"2002:c0a8:0101::1", // 6to4 embedding 192.168.1.1
		"2002:a9fe:0101::1", // 6to4 embedding 169.254.1.1
		"2002:0808:0808::1", // 6to4 is refused wholesale, even public-embedded
		"2001::1", // Teredo (2001::/32, inside 2001::/23)
		"2001:2::1", // benchmarking 2001:2::/48
		"2001:20::1", // ORCHIDv2 2001:20::/28
		"2001:1ff::1", // top of 2001::/23
		"3fff::1", // documentation 3fff::/20
		"3fff:fff::1", // top of 3fff::/20
		"5f00::1", // SRv6 SIDs 5f00::/16
		"64:ff9b:1::1", // local-use NAT64 64:ff9b:1::/48
		"::8.8.8.8", // IPv4-compatible, outside 2000::/3
		"4000::1", // unassigned, outside 2000::/3
		"1fff:ffff::1", // just below 2000::/3
	];
	for (const ip of denied) {
		it(`rejects ${ip}`, async () => {
			const { isPrivateIp } = await import("../lib/url-security");
			expect(isPrivateIp(ip)).toBe(true);
		});
	}
	const allowed = [
		"198.17.255.255",
		"198.20.0.1",
		"203.0.114.1",
		"2600::1",
		"2001:200::1", // first block past 2001::/23 (APNIC)
		"2001:db7:ffff::1", // just below 2001:db8::/32
		"2001:db9::1", // just above 2001:db8::/32
		"3fff:1000::1", // just past 3fff::/20
		"3ffe::1", // below 3fff::/20 (former 6bone, now plain 2000::/3)
		"2606:4700:4700::1111", // Cloudflare
		"2a00:1450:4001::1", // Google
	];
	for (const ip of allowed) {
		it(`allows globally routable ${ip}`, async () => {
			const { isPrivateIp } = await import("../lib/url-security");
			expect(isPrivateIp(ip)).toBe(false);
		});
	}
});
