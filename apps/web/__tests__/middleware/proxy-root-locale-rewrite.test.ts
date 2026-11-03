// @vitest-environment node
/**
 * Regression tests for the root `/` locale rewrite and `127.0.0.1` self-proxy
 * redirect loop fix.
 *
 * Exercises the real `proxy.ts` + `next-intl/middleware` + `NextRequest` stack
 * together with Next.js 16's `resolve-routes.js` header-override and sequential
 * `beforeFiles` rewrite pipeline.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

// `modules/i18n/routing.ts` also exports client navigation helpers via
// `createNavigation(routing)`, which pulls `redirect` from `next/navigation`
// (not included in the global `vitest.setup.ts` router stub). Stubbing only
// `next-intl/navigation` keeps the real `defineRouting()` config and the real
// `next-intl/middleware` implementation intact.
vi.mock("next-intl/navigation", () => ({
	createNavigation: () => ({}),
}));

import { LOCALE_REWRITE_HEADER } from "../../lib/locale-rewrite";
import proxy, { config as proxyConfig } from "../../proxy";

const APP_ROOT = path.resolve(__dirname, "../..");
const requireNext = createRequire(import.meta.url);
const loadConfig = requireNext("next/dist/server/config").default as (
	phase: string,
	dir: string,
) => Promise<Record<string, unknown>>;
const loadCustomRoutes = requireNext("next/dist/lib/load-custom-routes")
	.default as (config: Record<string, unknown>) => Promise<{
	rewrites: { beforeFiles: unknown[] };
}>;
const { PHASE_PRODUCTION_BUILD } = requireNext(
	"next/dist/shared/lib/constants",
) as {
	PHASE_PRODUCTION_BUILD: string;
};
const { buildCustomRoute } = requireNext(
	"next/dist/server/lib/router-utils/filesystem",
) as {
	buildCustomRoute: (
		type: string,
		item: unknown,
	) => {
		destination: string;
		has?: unknown[];
		missing?: unknown[];
		match: (pathname: string) => Record<string, string> | false;
	};
};
const { matchHas, prepareDestination } = requireNext(
	"next/dist/shared/lib/router/utils/prepare-destination",
) as {
	matchHas: (
		req: { headers: Record<string, string | undefined> },
		query: Record<string, string | string[]>,
		has?: unknown[],
		missing?: unknown[],
	) => Record<string, string> | false;
	prepareDestination: (args: {
		appendParamsToQuery: boolean;
		destination: string;
		params: Record<string, string>;
		query: Record<string, string | string[]>;
	}) => {
		parsedDestination: {
			pathname: string;
			protocol: string | null;
			query: Record<string, string | string[]>;
		};
	};
};
const { getRelativeURL } = requireNext(
	"next/dist/shared/lib/router/utils/relativize-url",
) as {
	getRelativeURL: (url: string, base: string) => string;
};
const { parseUrl } = requireNext(
	"next/dist/shared/lib/router/utils/parse-url",
) as {
	parseUrl: (url: string) => {
		pathname?: string;
		protocol?: string | null;
		query: Record<string, string | string[]>;
	};
};

let beforeFilesRoutes: ReturnType<typeof buildCustomRoute>[] = [];

beforeAll(async () => {
	const loadedConfig = await loadConfig(PHASE_PRODUCTION_BUILD, APP_ROOT);
	const customRoutes = await loadCustomRoutes(loadedConfig);
	beforeFilesRoutes = customRoutes.rewrites.beforeFiles.map((item) =>
		buildCustomRoute("before_files_rewrite", item),
	);
});

/**
 * Simulates the `resolve-routes.js` pipeline when Next.js 16 is bound to
 * `--hostname 127.0.0.1 --port 3032`:
 * 1. `initUrl` uses raw `opts.hostname` (`http://127.0.0.1:3032/...`).
 * 2. `NextRequest` normalizes `127.0.0.1` to `localhost` via `NextURL`.
 * 3. `x-middleware-override-headers` mutates `req.headers`.
 * 4. Any `x-middleware-rewrite` is checked via `getRelativeURL(value, initUrl)`;
 *    a non-null `protocol` means `router-server.js` externally HTTP-proxies the
 *    request back into the server instead of resolving internally.
 * 5. Every `beforeFiles` rewrite runs sequentially in place (mutating
 *    `parsedUrl.pathname` without early exit, matching `resolve-routes.js`).
 */
async function simulateLoopbackRouteResolution(
	pathAndSearch: string,
	options: {
		headers?: Record<string, string>;
	} = {},
) {
	const initUrl = `http://127.0.0.1:3032${pathAndSearch}`;
	const reqHeaders: Record<string, string | undefined> = {
		host: "localhost:3032",
	};
	for (const [k, v] of Object.entries(options.headers ?? {})) {
		reqHeaders[k.toLowerCase()] = v;
	}

	const parsedUrl = parseUrl(pathAndSearch);
	const matchesMiddleware = unstable_doesMiddlewareMatch({
		config: proxyConfig,
		url: pathAndSearch,
		headers: reqHeaders,
	});

	let proxyRes: Awaited<ReturnType<typeof proxy>> | null = null;
	if (matchesMiddleware) {
		const nextReq = new NextRequest(initUrl, {
			headers: options.headers,
		});
		proxyRes = await proxy(nextReq);

		const overrideRaw = proxyRes.headers.get(
			"x-middleware-override-headers",
		);
		if (overrideRaw !== null) {
			const overridden = new Set(
				overrideRaw
					.split(",")
					.map((k) => k.trim().toLowerCase())
					.filter(Boolean),
			);
			for (const existingKey of Object.keys(reqHeaders)) {
				if (!overridden.has(existingKey)) {
					delete reqHeaders[existingKey];
				}
			}
			for (const key of overridden) {
				const val = proxyRes.headers.get(`x-middleware-request-${key}`);
				reqHeaders[key] = val === null ? undefined : val;
			}
		}

		const middlewareRewrite = proxyRes.headers.get("x-middleware-rewrite");
		if (middlewareRewrite) {
			const destination = getRelativeURL(middlewareRewrite, initUrl);
			const parsedRewrite = parseUrl(destination);
			if (parsedRewrite.protocol) {
				return {
					kind: "external-proxy-rewrite" as const,
					externalUrl: destination,
					proxyRes,
					reqHeaders,
				};
			}
			parsedUrl.pathname = parsedRewrite.pathname;
		}

		const location = proxyRes.headers.get("location");
		if (location && proxyRes.status >= 300 && proxyRes.status < 400) {
			// Mirror `adapter.js`: redirects relativize `Location` against
			// `requestURL` (`nextReq.nextUrl`) before `resolve-routes.js` runs,
			// whereas `x-middleware-rewrite` above is left as `String(destination)`.
			const adapterLocation = getRelativeURL(
				location,
				nextReq.nextUrl.toString(),
			);
			return {
				kind: "redirect" as const,
				status: proxyRes.status,
				location: getRelativeURL(adapterLocation, initUrl),
				proxyRes,
				reqHeaders,
			};
		}
	}

	for (const route of beforeFilesRoutes) {
		const curPathname = parsedUrl.pathname || "/";
		let params = route.match(curPathname);
		if ((route.has || route.missing) && params) {
			const hasParams = matchHas(
				{ headers: reqHeaders },
				parsedUrl.query,
				route.has,
				route.missing,
			);
			if (hasParams) {
				Object.assign(params, hasParams);
			} else {
				params = false;
			}
		}
		if (params) {
			const { parsedDestination } = prepareDestination({
				appendParamsToQuery: true,
				destination: route.destination,
				params,
				query: parsedUrl.query,
			});
			parsedUrl.pathname = parsedDestination.pathname;
			Object.assign(parsedUrl.query, parsedDestination.query);
		}
	}

	return {
		kind: "internal" as const,
		status: proxyRes?.status ?? 200,
		resolvedPathname: parsedUrl.pathname ?? "/",
		resolvedQuery: parsedUrl.query,
		proxyRes,
		reqHeaders,
	};
}

describe("root `/` locale rewrite on loopback dev/server hosts", () => {
	it("resolves GET / signed out to /en internally without external rewrite or 307 loop", async () => {
		const result = await simulateLoopbackRouteResolution("/");

		expect(result.kind).toBe("internal");
		if (result.kind !== "internal") {
			return;
		}
		expect(result.status).toBe(200);
		expect(result.resolvedPathname).toBe("/en");
		expect(result.proxyRes?.headers.get("x-middleware-rewrite")).toBeNull();
		expect(result.proxyRes?.headers.get("location")).toBeNull();
		expect(result.reqHeaders["x-next-intl-locale"]).toBe("en");
		expect(result.proxyRes?.headers.get("set-cookie")).toContain(
			"NEXT_LOCALE=en",
		);
	});

	it("resolves GET / with a session cookie to /en internally without redirecting", async () => {
		const result = await simulateLoopbackRouteResolution("/", {
			headers: {
				cookie: "fabric.session_token=synthetic-session-token",
			},
		});

		expect(result.kind).toBe("internal");
		if (result.kind !== "internal") {
			return;
		}
		expect(result.status).toBe(200);
		expect(result.resolvedPathname).toBe("/en");
		expect(result.proxyRes?.headers.get("x-middleware-rewrite")).toBeNull();
	});

	it("redirects GET /en once to / and resolves the follow-up GET / to /en (no loop)", async () => {
		const firstHop = await simulateLoopbackRouteResolution("/en");
		expect(firstHop.kind).toBe("redirect");
		if (firstHop.kind !== "redirect") {
			return;
		}
		expect(firstHop.status).toBe(307);
		expect(firstHop.location).toBe("/");

		const secondHop = await simulateLoopbackRouteResolution(
			firstHop.location,
		);
		expect(secondHop.kind).toBe("internal");
		if (secondHop.kind !== "internal") {
			return;
		}
		expect(secondHop.status).toBe(200);
		expect(secondHop.resolvedPathname).toBe("/en");
	});

	it("rewrites unprefixed marketing subpaths once and preserves query params", async () => {
		const result = await simulateLoopbackRouteResolution(
			"/legal/privacy-policy?utm_source=example",
		);

		expect(result.kind).toBe("internal");
		if (result.kind !== "internal") {
			return;
		}
		expect(result.status).toBe(200);
		expect(result.resolvedPathname).toBe("/en/legal/privacy-policy");
		expect(result.resolvedQuery.utm_source).toBe("example");
	});

	it("strips client-sent x-fabric-locale-rewrite headers on non-marketing proxy routes", async () => {
		for (const path of [
			"/auth/login",
			"/onboarding",
			"/en/docs",
			"/en/blog",
		]) {
			const result = await simulateLoopbackRouteResolution(path, {
				headers: {
					[LOCALE_REWRITE_HEADER]: "en",
				},
			});

			expect(result.kind).toBe("internal");
			if (result.kind !== "internal") {
				continue;
			}
			expect(result.reqHeaders[LOCALE_REWRITE_HEADER]).toBeUndefined();
			expect(result.resolvedPathname).toBe(path);
		}

		const authedApp = await simulateLoopbackRouteResolution("/app", {
			headers: {
				cookie: "fabric.session_token=synthetic-session-token",
				[LOCALE_REWRITE_HEADER]: "en",
			},
		});
		expect(authedApp.kind).toBe("internal");
		if (authedApp.kind === "internal") {
			expect(authedApp.reqHeaders[LOCALE_REWRITE_HEADER]).toBeUndefined();
			expect(authedApp.resolvedPathname).toBe("/app");
		}
	});

	it("ignores client-sent x-fabric-locale-rewrite headers on matcher-excluded paths", async () => {
		for (const excludedPath of [
			"/api/health",
			"/mcp",
			"/.well-known/fabric-cli.json",
			"/cli/fabric.tgz",
			"/_next/static/chunks/main.js",
			"/favicon.ico",
			"/robots.txt",
		]) {
			const result = await simulateLoopbackRouteResolution(excludedPath, {
				headers: {
					[LOCALE_REWRITE_HEADER]: "en",
				},
			});

			expect(result.proxyRes).toBeNull();
			expect(result.kind).toBe("internal");
			if (result.kind === "internal") {
				expect(result.resolvedPathname).toBe(excludedPath);
			}
		}
	});
});
