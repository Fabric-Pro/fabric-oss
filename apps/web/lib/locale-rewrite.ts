import type { Rewrite } from "next/dist/lib/load-custom-routes";

/**
 * Internal request header set only by `proxy.ts` when `next-intl` resolves an
 * unprefixed marketing path (such as `/` or `/contact`) to an internal
 * `/[locale]` route.
 *
 * Why `beforeFiles` instead of `NextResponse.rewrite()` in `proxy.ts`:
 * When Next.js 16 is bound to a loopback IP (`--hostname 127.0.0.1` or `::1`),
 * `adapter()` normalizes `x-middleware-rewrite` through `NextURL` (rewriting
 * `127.0.0.1` / `[::1]` to `localhost`), whereas `resolveRoutes()` builds
 * `initUrl` from raw `opts.hostname` (`http://127.0.0.1:<port>/`) and checks
 * `getRelativeURL(rewrite, initUrl)` via `URL.origin`. Because the origins
 * differ (`http://localhost:<port>` !== `http://127.0.0.1:<port>`), Next.js
 * treats the internal rewrite to `/en` as an external HTTP proxy request back
 * into the same server; that second request enters `proxy.ts` as `GET /en`,
 * where `next-intl` (`localePrefix: "never"`) answers `307 Location: /`,
 * creating an infinite redirect loop.
 *
 * Relative-destination `beforeFiles` rewrites run inside `resolveRoutes()`
 * immediately after `proxy.ts` with `parsedDestination.protocol === null`,
 * bypassing the `NextURL` vs `initUrl` origin comparison altogether.
 */
export const LOCALE_REWRITE_HEADER = "x-fabric-locale-rewrite";

const LOCALE_REWRITE_HAS = [
	{
		type: "header" as const,
		key: LOCALE_REWRITE_HEADER,
		value: "(?<locale>[a-z]{2})",
	},
];

type Join<
	Items extends readonly string[],
	Sep extends string,
> = Items extends readonly [infer Head extends string]
	? Head
	: Items extends readonly [
				infer Head extends string,
				...infer Tail extends readonly string[],
			]
		? `${Head}${Sep}${Join<Tail, Sep>}`
		: "";

/**
 * Canonical list of path-prefix regex patterns excluded from `proxy.ts`
 * `config.matcher[0]` and from `beforeFiles` subpath locale rewrites.
 *
 * Next.js statically parses `export const config` in `proxy.ts` from the SWC
 * AST (`next/dist/build/analysis/extract-const-value.js`), rejecting imported
 * identifiers, template expressions, `.join()` calls and `satisfies`
 * expressions. Keep `proxy.ts` `config.matcher[0]` a plain string literal;
 * `proxy-root-locale-rewrite.test.ts` fails whenever the two lists diverge.
 */
export const PROXY_EXCLUDED_PATH_PATTERNS = [
	"api",
	"mcp(?:/|$)",
	"\\.well-known",
	"cli/",
	"image-proxy",
	"images",
	"integrations",
	"fonts",
	"fabric-web-assets",
	"_next/static",
	"_next/image",
	"favicon.ico",
	"icon.png",
	"manifest\\.json",
	"sitemap.xml",
	"docs-sitemap\\.xml",
	"robots.txt",
	"llms\\.txt",
	"llms-full\\.txt",
] as const;

type ProxyExcludedAlternation = Join<typeof PROXY_EXCLUDED_PATH_PATTERNS, "|">;

const PROXY_EXCLUDED_ALTERNATION = PROXY_EXCLUDED_PATH_PATTERNS.join(
	"|",
) as ProxyExcludedAlternation;

/**
 * Expected string literal for `proxy.ts` `config.matcher[0]`.
 */
export const PROXY_PRIMARY_MATCHER_SOURCE =
	`/((?!${PROXY_EXCLUDED_ALTERNATION}).*)` as const;

/**
 * Mirrors the negative lookahead in `proxy.ts` `config.matcher[0]` so a client
 * sending `x-fabric-locale-rewrite` on a path that bypasses `proxy.ts`
 * (`/api/*`, `/mcp`, `/.well-known/*`, `/cli/*`, `/docs-sitemap.xml`, static
 * assets) cannot trigger a locale rewrite. Paths covered by `proxy.ts` strip
 * any client-sent copy of the header in `forwardedRequestHeaders()`.
 */
export const NON_PROXY_SUBPATH_SOURCE =
	`/:path((?!${PROXY_EXCLUDED_ALTERNATION}).+)` as const;

export function buildLocaleBeforeFilesRewrites(): Rewrite[] {
	// Order is load-bearing: `resolveRoutes()` evaluates every `beforeFiles`
	// entry sequentially in place (`parsedUrl.pathname` mutates without early
	// exit). Putting the `/:path(.+)` rule first ensures `/` skips it (`.+`
	// requires >=1 char after `/`) and then matches `/` -> `/:locale` last,
	// whereas `/foo` matches `/:path` -> `/:locale/foo` and skips `/` last.
	return [
		{
			source: NON_PROXY_SUBPATH_SOURCE,
			has: LOCALE_REWRITE_HAS,
			destination: "/:locale/:path",
		},
		{
			source: "/",
			has: LOCALE_REWRITE_HAS,
			destination: "/:locale",
		},
	];
}
