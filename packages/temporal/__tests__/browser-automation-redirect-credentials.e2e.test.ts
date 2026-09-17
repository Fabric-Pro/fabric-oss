/**
 * The browser relay against a real Chromium: redirects and cookies.
 *
 * Chromium follows a redirect that a route fulfilled with its own network
 * stack, without sending the next hop back through `context.route`, so the
 * relay never fulfills a 3xx. It also fulfills a relayed response as if it
 * came from the origin Chromium asked for, so it must not follow a
 * subresource redirect to another origin (CORS, opaque responses and
 * resource taint would no longer apply), and it leaves cookies to Chromium
 * by passing every hop's `Set-Cookie` through on the fulfilled response.
 * These tests pin all of that in a real browser.
 *
 * Local HTTP servers stand in for hosts. A and B are "public", served to
 * the browser as https: the relay's DNS hook answers a public address, the
 * test's fetch wrapper rewrites the scheme to reach the plain-HTTP server,
 * and the dispatcher connects to loopback with the production pin
 * (`pinnedConnectLookup`). https lets `Secure` and `Partitioned` cookies be
 * exercised. INTERNAL is `internal.localhost`, which the guard refuses and
 * which Chromium itself resolves to loopback, so a request that bypassed
 * the relay would reach it.
 *
 * This is a security regression suite, so it does not skip itself when
 * Chromium is missing: a launch failure fails it. CI installs Chromium for
 * it (`.github/workflows/unit-tests.yml`, job `browser-security`). Set
 * `FABRIC_SKIP_BROWSER_E2E=1` to opt out explicitly — the unit-test shards
 * do, because that job runs it instead.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import {
	type PinnedFetchOptions,
	pinnedConnectLookup,
	type ResolvedAddress,
} from "@repo/utils/url-security";
import type { Browser, BrowserContext, Page } from "playwright";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV,
	createBrowserPinnedFetch,
	installOutboundRequestGuard,
} from "../src/activities/browser-automation/url-guard";

type PinnedDispatcher = NonNullable<PinnedFetchOptions["dispatcher"]> & {
	close(): Promise<void>;
};
type UndiciAgentConstructor = new (options: {
	connect: { lookup: ReturnType<typeof pinnedConnectLookup> };
}) => PinnedDispatcher;

/**
 * undici's `Agent`, loaded through `@repo/utils`' own resolution: this
 * package does not depend on undici, and the dispatcher must be the same
 * undici instance the pinned fetch hands it to.
 */
function loadUndiciAgent(): UndiciAgentConstructor {
	const require = createRequire(import.meta.url);
	const fromUtils = createRequire(
		require.resolve("@repo/utils/url-security"),
	);
	return (fromUtils("undici") as { Agent: UndiciAgentConstructor }).Agent;
}

const SKIP_BROWSER_E2E = process.env.FABRIC_SKIP_BROWSER_E2E === "1";

const HOST_A = "a.example.com";
const HOST_B = "b.example.com";
const HOST_INTERNAL = "internal.localhost";
const PUBLIC: ResolvedAddress = { address: "93.184.216.34", family: 4 };

type Recorded = {
	path: string;
	method: string;
	headers: IncomingMessage["headers"];
};

let browser: Browser | null = null;
let serverA: Server;
let serverB: Server;
let serverInternal: Server;
let originA = "";
let originB = "";
let originInternal = "";
const seenA: Recorded[] = [];
const seenB: Recorded[] = [];
const seenInternal: Recorded[] = [];

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ALLOWED = process.env[BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV];

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	return (server.address() as AddressInfo).port;
}

function record(seen: Recorded[], req: IncomingMessage) {
	seen.push({
		path: req.url ?? "",
		method: req.method ?? "",
		headers: req.headers,
	});
}

function recorder(seen: Recorded[], body: string) {
	return createServer((req, res) => {
		record(seen, req);
		res.writeHead(200, { "content-type": "text/plain" });
		res.end(body);
	});
}

beforeAll(async () => {
	process.env.NODE_ENV = "production";
	delete process.env[BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV];

	serverB = recorder(seenB, "landed on B");
	originB = `https://${HOST_B}:${await listen(serverB)}`;
	serverInternal = recorder(seenInternal, "internal secret");
	originInternal = `http://${HOST_INTERNAL}:${await listen(serverInternal)}`;

	serverA = createServer((req, res) => {
		record(seenA, req);
		const url = new URL(req.url ?? "/", "http://placeholder");
		const redirect = (location: string, cookies: string[] = []) => {
			res.writeHead(302, [
				["location", location],
				...cookies.map((c) => ["set-cookie", c] as [string, string]),
			]);
			res.end();
		};
		switch (url.pathname) {
			case "/go":
				return redirect(`${originB}/landing`);
			case "/go-internal":
				return redirect(`${originInternal}/metadata`);
			case "/set-then-delete":
				// One response sets a cookie and then deletes it; the next
				// hop, which names no Path, sets another.
				return redirect("/auth/step", [
					"sid=new; Path=/",
					"sid=; Max-Age=0; Path=/",
				]);
			case "/auth/step":
				return redirect("/plain", ["chain=1"]);
			case "/redirect-set":
				return redirect("/plain", [
					`${url.searchParams.get("name")}=1; Path=/`,
				]);
			case "/set":
				res.writeHead(200, {
					"content-type": "text/plain",
					"set-cookie": `${url.searchParams.get("name")}=1; Path=/`,
				});
				res.end("set");
				return;
			case "/partitioned":
				res.writeHead(200, {
					"content-type": "text/plain",
					"set-cookie":
						"pc=1; Secure; SameSite=None; Path=/; Partitioned",
				});
				res.end("partitioned");
				return;
			case "/plain":
				res.writeHead(200, { "content-type": "text/plain" });
				res.end("plain");
				return;
			default:
				res.writeHead(200, {
					"content-type": "text/html; charset=utf-8",
					"set-cookie": "session=a-secret; Path=/",
				});
				res.end("<html><body><h1>A</h1></body></html>");
		}
	});
	originA = `https://${HOST_A}:${await listen(serverA)}`;

	if (!SKIP_BROWSER_E2E) {
		// No catch: a browser that cannot launch fails this suite rather than
		// quietly skipping the security checks in it.
		const { chromium } = await import("playwright");
		browser = await chromium.launch({ headless: true });
	}
}, 60_000);

afterAll(async () => {
	await browser?.close();
	serverA?.close();
	serverB?.close();
	serverInternal?.close();
	if (ORIGINAL_NODE_ENV === undefined) {
		delete process.env.NODE_ENV;
	} else {
		process.env.NODE_ENV = ORIGINAL_NODE_ENV;
	}
	if (ORIGINAL_ALLOWED === undefined) {
		delete process.env[BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV];
	} else {
		process.env[BROWSER_AUTOMATION_ALLOWED_HOSTS_ENV] = ORIGINAL_ALLOWED;
	}
});

beforeEach(() => {
	seenA.length = 0;
	seenB.length = 0;
	seenInternal.length = 0;
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

function launchedBrowser(): Browser {
	if (!browser) {
		throw new Error("Chromium did not launch");
	}
	return browser;
}

/**
 * A guarded context whose relay reaches A and B's plain-HTTP servers on
 * loopback. Returns the URLs the relay fetched, as the browser named them.
 */
async function guardedContext(b: Browser): Promise<{
	context: BrowserContext;
	page: Page;
	relayed: string[];
	close: () => Promise<void>;
}> {
	const relayed: string[] = [];
	const Agent = loadUndiciAgent();
	// The production pin, pointed at loopback: real Node sockets call it in
	// the all-addresses shape, so this exercises that path too.
	const dispatcher = new Agent({
		connect: {
			lookup: pinnedConnectLookup({ address: "127.0.0.1", family: 4 }),
		},
	});
	const pinned = createBrowserPinnedFetch({
		lookup: async () => [PUBLIC],
		dispatcher,
	});
	const context = await b.newContext({ serviceWorkers: "block" });
	await installOutboundRequestGuard(context, (url, init) => {
		relayed.push(url);
		return pinned(url.replace(/^https:/, "http:"), init);
	});
	const page = await context.newPage();
	return {
		context,
		page,
		relayed,
		close: async () => {
			await context.close();
			await dispatcher.close();
		},
	};
}

async function cookieNames(context: BrowserContext): Promise<string[]> {
	return (await context.cookies(originA)).map((c) => c.name).sort();
}

describe.skipIf(SKIP_BROWSER_E2E)(
	"browser relay: redirects and cookies (real Chromium)",
	() => {
		it("sends a navigation redirect back through the relay: the next hop is relayed and A's cookie does not reach B", async () => {
			const { context, page, relayed, close } = await guardedContext(
				launchedBrowser(),
			);
			try {
				await page.goto(`${originA}/`);
				expect(await cookieNames(context)).toContain("session");

				await page.goto(`${originA}/go`);
				await page.waitForURL(`${originB}/landing`);
				expect(await page.textContent("body")).toContain("landed on B");

				expect(
					seenA.find((r) => r.path === "/go")?.headers.cookie,
				).toContain("session=a-secret");
				expect(seenB).toHaveLength(1);
				expect(seenB[0].headers.cookie).toBeUndefined();
				expect(relayed).toEqual([
					`${originA}/`,
					`${originA}/go`,
					`${originB}/landing`,
				]);
			} finally {
				await close();
			}
		}, 60_000);

		it("does not let a navigation redirect reach an internal address", async () => {
			const { page, relayed, close } = await guardedContext(
				launchedBrowser(),
			);
			try {
				await page.goto(`${originA}/go-internal`);
				// The refresh to the internal host is its own navigation,
				// which the route refuses; give it time to have happened.
				await page
					.waitForURL(`${originInternal}/metadata`, {
						timeout: 2_000,
					})
					.catch(() => undefined);
				expect(seenInternal).toHaveLength(0);
				expect(relayed).toEqual([`${originA}/go-internal`]);
			} finally {
				await close();
			}
		}, 60_000);

		it("refuses a cross-origin subresource redirect: the page's fetch fails and B receives nothing", async () => {
			const { page, close } = await guardedContext(launchedBrowser());
			try {
				await page.goto(`${originA}/`);
				const outcome = await page.evaluate(async () => {
					try {
						const response = await fetch("/go", {
							headers: { authorization: "Bearer a-secret" },
							credentials: "include",
						});
						return `status ${response.status}: ${await response.text()}`;
					} catch (error) {
						return `rejected: ${String(error)}`;
					}
				});
				expect(outcome).toMatch(/^rejected/);
				expect(seenA.find((r) => r.path === "/go")).toBeDefined();
				expect(seenB).toHaveLength(0);
			} finally {
				await close();
			}
		}, 60_000);

		it("does not let a fetch redirect reach an internal address", async () => {
			const { page, close } = await guardedContext(launchedBrowser());
			try {
				await page.goto(`${originA}/`);
				const outcome = await page.evaluate(async () => {
					try {
						const response = await fetch("/go-internal");
						return `status ${response.status}`;
					} catch {
						return "failed";
					}
				});
				expect(outcome).toBe("failed");
				expect(seenInternal).toHaveLength(0);
			} finally {
				await close();
			}
		}, 60_000);

		it("applies a redirect chain's cookies in wire order: set then deleted leaves none, and a later hop's cookie keeps that hop's path", async () => {
			const { context, page, close } = await guardedContext(
				launchedBrowser(),
			);
			try {
				await page.goto(`${originA}/`);
				const body = await page.evaluate(async () => {
					const response = await fetch("/set-then-delete");
					return response.text();
				});
				expect(body).toBe("plain");

				const cookies = await context.cookies(`${originA}/auth/`);
				expect(cookies.map((c) => c.name)).not.toContain("sid");
				const chain = cookies.find((c) => c.name === "chain");
				expect(chain?.path).toBe("/auth");
				expect(
					(await context.cookies(`${originA}/`)).map((c) => c.name),
				).not.toContain("chain");

				// Follow-up hops carry no cookie at all: the relay cannot prove
				// which of the page's cookies Chromium would send to another
				// path, so it sends none (the page's `session` cookie included).
				const step = seenA.find((r) => r.path === "/auth/step");
				expect(step).toBeDefined();
				expect(step?.headers.cookie).toBeUndefined();
			} finally {
				await close();
			}
		}, 60_000);

		it("leaves credentials mode to Chromium: a fetch with credentials omit stores no cookie, same-origin and include do", async () => {
			const { context, page, close } = await guardedContext(
				launchedBrowser(),
			);
			try {
				await page.goto(`${originA}/`);
				await page.evaluate(async () => {
					for (const [path, mode] of [
						["/redirect-set?name=omit_redirect", "omit"],
						["/set?name=omit_plain", "omit"],
						["/redirect-set?name=default_redirect", "same-origin"],
						["/redirect-set?name=include_redirect", "include"],
						["/set?name=include_plain", "include"],
					] as const) {
						await fetch(path, { credentials: mode });
					}
				});
				const names = await cookieNames(context);
				expect(names).not.toContain("omit_redirect");
				expect(names).not.toContain("omit_plain");
				expect(names).toContain("default_redirect");
				expect(names).toContain("include_redirect");
				expect(names).toContain("include_plain");

				// And an omit request was relayed without a Cookie header, so
				// its follow-up hop gained none either.
				const omitted = seenA.filter((r) =>
					r.path.includes("name=omit_redirect"),
				);
				expect(omitted).toHaveLength(1);
				expect(omitted[0].headers.cookie).toBeUndefined();
			} finally {
				await close();
			}
		}, 60_000);

		it("does not turn a Partitioned cookie into an ordinary one: the relay drops it rather than let Chromium store it unpartitioned", async () => {
			// Chromium stores a cookie set through route.fulfill without its
			// partition key (a directly fetched one keeps it), so the only
			// safe outcome through the relay is no cookie at all.
			const { context, page, close } = await guardedContext(
				launchedBrowser(),
			);
			try {
				await page.goto(`${originA}/`);
				await page.evaluate(async () => {
					await fetch("/partitioned");
				});
				expect(
					(await context.cookies()).filter((c) => c.name === "pc"),
				).toEqual([]);
			} finally {
				await close();
			}
		}, 60_000);
	},
);
