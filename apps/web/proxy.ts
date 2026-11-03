import { routing } from "@i18n/routing";
import { config as appConfig } from "@repo/config";
import { RETURN_TO_HEADER } from "@saas/auth/lib/login-redirect";
import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import createMiddleware from "next-intl/middleware";
import { withQuery } from "ufo";
import { LOCALE_REWRITE_HEADER } from "./lib/locale-rewrite";

const intlMiddleware = createMiddleware(routing);
const DEFAULT_LOCALE = "en";
const SESSION_DATA_COOKIE = `${appConfig.auth.cookiePrefix}.session_data`;
const SESSION_DATA_COOKIE_SECURE = `__Secure-${appConfig.auth.cookiePrefix}.session_data`;

/**
 * Paths served OUTSIDE `(marketing)/[locale]` that must bypass the intl
 * middleware.
 *
 * A path missing from this list is localized to `/en/...`, matches no marketing
 * route, and renders the marketing 404 — so an emailed link dies on a dead page
 * while its route file sits correctly in the build, which makes the failure look
 * like a bad deploy rather than a missing entry here.
 *
 * Exported so `__tests__/proxy-emailed-paths.test.ts` can assert that every link
 * the app mails out is covered. That test is the guard; this comment is not —
 * the same footgun was commented twice here and still caught the next link.
 */
export const pathsWithoutLocale = [
	"/onboarding",
	"/new-organization",
	"/choose-plan",
	"/organization-invitation",
	"/project-invitation",
	// Public one-click unsubscribe link from release-notes newsletter emails.
	// Lives at app/unsubscribe/[token] (outside (marketing)/[locale]); without
	// this bypass the intl middleware localizes the path and it 404s.
	"/unsubscribe",
	// Public double opt-in confirm link from newsletter emails. Lives at
	// app/newsletter/confirm/[token] (outside (marketing)/[locale]); without
	// this bypass the intl middleware localizes the path and it 404s.
	"/newsletter/confirm",
	"/share",
	"/vscode-auth",
	// Opened by `fabric connect chatgpt`. Lives at (saas)/connect/chatgpt
	// (outside (marketing)/[locale]); without this bypass the intl middleware
	// localizes the path and it 404s.
	"/connect/chatgpt",
	"/change-password",
	// Emailed confirmation link for deleting an organization. Lives at
	// (saas)/organizations/confirm-deletion (outside (marketing)/[locale]);
	// without this bypass the intl middleware localizes the path and it 404s.
	"/organizations/confirm-deletion",
];

const EMBED_FLAG_HEADER = "x-embed-route";

/**
 * The Content-Security-Policy of a page that frames an agent-written page, sent
 * on every response of a frame's embed view (`/app/.../embed`,
 * `/share/frame/.../embed`). The sandboxed page carries a policy of its own that
 * stops it fetching anything, but a policy cannot stop the page navigating its
 * own frame to another site with the data it holds in the address; only the
 * document that frames it can, by naming what a frame may load: itself and
 * documents without an address. Enforced, not report-only.
 */
export const FRAME_EMBED_PARENT_CSP =
	"frame-src 'self' about: blob: data:; child-src 'self' about: blob: data:";

const SHARED_FRAME_EMBED_PATH = /^\/share\/frame\/[^/]+\/embed\/?$/;

/**
 * The headers a request carries onward. `x-embed-route` is ours to set, never
 * the client's: it makes the organization layout draw without the app shell, so
 * a copy a client sent is dropped, and only an embed path puts it back.
 */
function forwardedRequestHeaders(
	req: NextRequest,
	extra: Record<string, string> = {},
): Headers {
	const headers = new Headers(req.headers);
	headers.delete(EMBED_FLAG_HEADER);
	headers.delete(LOCALE_REWRITE_HEADER);
	for (const [name, value] of Object.entries(extra)) {
		headers.set(name, value);
	}
	return headers;
}

function forward(req: NextRequest, extra?: Record<string, string>) {
	return NextResponse.next({
		request: { headers: forwardedRequestHeaders(req, extra) },
	});
}

/**
 * Hand same-origin locale rewrites from `next-intl` off to `next.config.ts`
 * `rewrites().beforeFiles` via `x-fabric-locale-rewrite` instead of returning
 * `x-middleware-rewrite`.
 *
 * When Next.js 16 is bound to a loopback IP (`--hostname 127.0.0.1` or `::1`),
 * `adapter()` normalizes `x-middleware-rewrite` via `NextURL` to `localhost`,
 * while `resolveRoutes()` builds `initUrl` from raw `opts.hostname`
 * (`127.0.0.1`) and checks `getRelativeURL` with `URL.origin`. That origin
 * mismatch turns an internal `/ -> /en` rewrite into an external HTTP proxy
 * request back into the same server, where `/en` (`localePrefix: "never"`)
 * responds `307 Location: /` and loops forever.
 */
function rewriteLocaleViaBeforeFiles(
	req: NextRequest,
	intlRes: NextResponse,
): NextResponse {
	const rewriteHeader = intlRes.headers?.get("x-middleware-rewrite");
	if (!rewriteHeader) {
		if (intlRes.headers?.get("x-middleware-next") === "1") {
			const overrideList = intlRes.headers.get(
				"x-middleware-override-headers",
			);
			if (overrideList) {
				const kept = overrideList
					.split(",")
					.map((k) => k.trim())
					.filter(
						(k) =>
							k.length > 0 &&
							k !== EMBED_FLAG_HEADER &&
							k !== LOCALE_REWRITE_HEADER,
					);
				intlRes.headers.delete(
					`x-middleware-request-${EMBED_FLAG_HEADER}`,
				);
				intlRes.headers.delete(
					`x-middleware-request-${LOCALE_REWRITE_HEADER}`,
				);
				intlRes.headers.set(
					"x-middleware-override-headers",
					kept.join(","),
				);
			}
		}
		return intlRes;
	}

	let reqOrigin: string;
	let rewriteUrl: URL;
	try {
		reqOrigin = new URL(req.url).origin;
		rewriteUrl = new URL(rewriteHeader, req.url);
	} catch {
		return intlRes;
	}

	if (rewriteUrl.origin !== reqOrigin) {
		return intlRes;
	}

	const localeMatch = rewriteUrl.pathname.match(/^\/([a-z]{2})(\/.*)?$/);
	if (!localeMatch) {
		return intlRes;
	}

	const locale = localeMatch[1];
	const strippedPathname = localeMatch[2] || "/";
	let decodedRequestPathname = req.nextUrl.pathname;
	try {
		decodedRequestPathname = decodeURI(req.nextUrl.pathname);
	} catch {
		// Leave raw pathname when URI decoding fails.
	}
	if (
		strippedPathname !== req.nextUrl.pathname &&
		strippedPathname !== decodedRequestPathname
	) {
		return intlRes;
	}

	const headers = forwardedRequestHeaders(req);
	const overrideHeaderList = intlRes.headers.get(
		"x-middleware-override-headers",
	);
	if (overrideHeaderList) {
		for (const rawKey of overrideHeaderList.split(",")) {
			const key = rawKey.trim();
			if (!key) {
				continue;
			}
			const value = intlRes.headers.get(`x-middleware-request-${key}`);
			if (value !== null) {
				headers.set(key, value);
			}
		}
	}
	headers.delete(EMBED_FLAG_HEADER);
	headers.set(LOCALE_REWRITE_HEADER, locale);

	const nextRes = NextResponse.next({
		request: { headers },
	});

	if (intlRes.cookies?.getAll) {
		for (const cookie of intlRes.cookies.getAll()) {
			nextRes.cookies.set(cookie);
		}
	} else {
		const setCookies = intlRes.headers.getSetCookie?.() ?? [];
		for (const cookie of setCookies) {
			nextRes.headers.append("set-cookie", cookie);
		}
	}

	intlRes.headers.forEach((value, key) => {
		const lower = key.toLowerCase();
		if (lower === "set-cookie" || lower.startsWith("x-middleware-")) {
			return;
		}
		nextRes.headers.set(key, value);
	});

	return nextRes;
}

function mustChangePassword(req: NextRequest): boolean {
	const raw =
		req.cookies.get(SESSION_DATA_COOKIE_SECURE)?.value ??
		req.cookies.get(SESSION_DATA_COOKIE)?.value;
	if (!raw) {
		return false;
	}
	try {
		const decoded = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
		const parsed = JSON.parse(decoded);
		return parsed?.session?.user?.mustChangePassword === true;
	} catch {
		return false;
	}
}

export default async function proxy(req: NextRequest) {
	const { pathname, origin } = req.nextUrl;
	const acceptHeader = req.headers.get("accept") || "";

	// Content negotiation for docs: serve markdown when Accept: text/markdown
	const wantsMarkdown =
		acceptHeader.includes("text/markdown") ||
		acceptHeader.includes("text/x-markdown");

	// Handle /docs without locale — redirect to /en/docs so locale stays in the URL
	if (pathname === "/docs" || pathname.startsWith("/docs/")) {
		if (wantsMarkdown) {
			const docPath = pathname.replace(/^\/docs\/?/, "");
			const newPath = docPath
				? `/api/docs/raw/${DEFAULT_LOCALE}/${docPath}`
				: `/api/docs/raw/${DEFAULT_LOCALE}`;
			const url = req.nextUrl.clone();
			url.pathname = newPath;
			return NextResponse.rewrite(url);
		}
		if (!appConfig.ui.marketing.enabled) {
			return NextResponse.redirect(new URL("/app", origin));
		}
		const url = req.nextUrl.clone();
		url.pathname = `/${DEFAULT_LOCALE}${pathname}`;
		return NextResponse.redirect(url);
	}

	// Handle /blog without locale — redirect to /en/blog so locale stays in the URL
	if (pathname === "/blog" || pathname.startsWith("/blog/")) {
		if (!appConfig.ui.marketing.enabled) {
			return NextResponse.redirect(new URL("/app", origin));
		}
		const url = req.nextUrl.clone();
		url.pathname = `/${DEFAULT_LOCALE}${pathname}`;
		return NextResponse.redirect(url);
	}

	// Handle /en/docs, /de/docs etc. — bypass intl middleware to prevent locale stripping
	const localeDocsMatch = pathname.match(/^\/([a-z]{2})\/docs(\/.*)?$/);
	if (localeDocsMatch) {
		if (wantsMarkdown) {
			const locale = localeDocsMatch[1];
			const docPath = localeDocsMatch[2]?.replace(/^\//, "") || "";
			const newPath = docPath
				? `/api/docs/raw/${locale}/${docPath}`
				: `/api/docs/raw/${locale}`;
			const url = req.nextUrl.clone();
			url.pathname = newPath;
			return NextResponse.rewrite(url);
		}
		if (!appConfig.ui.marketing.enabled) {
			return NextResponse.redirect(new URL("/app", origin));
		}
		return forward(req);
	}

	// Handle /en/blog, /de/blog etc. — bypass intl middleware to prevent locale stripping
	const localeBlogMatch = pathname.match(/^\/([a-z]{2})\/blog(\/.*)?$/);
	if (localeBlogMatch) {
		if (!appConfig.ui.marketing.enabled) {
			return NextResponse.redirect(new URL("/app", origin));
		}
		return forward(req);
	}

	const sessionCookie = getSessionCookie(req, {
		cookiePrefix: appConfig.auth.cookiePrefix,
	});

	if (pathname.startsWith("/app")) {
		if (!appConfig.ui.saas.enabled) {
			return NextResponse.redirect(new URL("/", origin));
		}

		if (!sessionCookie) {
			return NextResponse.redirect(
				new URL(
					withQuery("/auth/login", {
						redirectTo: pathname,
					}),
					origin,
				),
			);
		}

		if (mustChangePassword(req)) {
			return NextResponse.redirect(new URL("/change-password", origin));
		}

		// Clickjacking protection for the authenticated app surface (SOC 2
		// CC6.6). The ONLY framable /app routes are the frame-embed views
		// (.../frames/:id/embed) which must stay embeddable cross-origin —
		// exclude those; every other /app page denies framing to other origins.
		if (pathname.endsWith("/embed")) {
			// Rendered inside an iframe: the same embed flag as the public
			// widgets below, so the page draws without the app shell, banners
			// or analytics around it.
			const embedRes = forward(req, { [EMBED_FLAG_HEADER]: "1" });
			embedRes.headers.set(
				"Content-Security-Policy",
				FRAME_EMBED_PARENT_CSP,
			);
			return embedRes;
		}
		const appRes = forward(req);
		appRes.headers.set("X-Frame-Options", "SAMEORIGIN");
		appRes.headers.set("Content-Security-Policy", "frame-ancestors 'self'");
		return appRes;
	}

	if (pathname.startsWith("/auth")) {
		if (!appConfig.ui.saas.enabled) {
			return NextResponse.redirect(new URL("/", origin));
		}

		// The agent consent and organization screens grant access with one
		// click, so no other page may frame them (RFC 9700 section 4.16).
		if (pathname.startsWith("/auth/oauth/")) {
			// Someone who has to change their password first may not authorize
			// an agent either: the same gate as /app. The authorization server
			// refuses on its own too (`consentReferenceId`), since an agent can
			// reach it without passing through these pages.
			if (mustChangePassword(req)) {
				return NextResponse.redirect(
					new URL("/change-password", origin),
				);
			}
			const consentRes = forward(req);
			consentRes.headers.set("X-Frame-Options", "DENY");
			consentRes.headers.set(
				"Content-Security-Policy",
				"frame-ancestors 'none'",
			);
			return consentRes;
		}

		return forward(req);
	}

	// Public embeddable widgets (iframe), e.g. app/embed/newsletter. Frameable by
	// any origin AND flagged via x-embed-route so the root providers suppress
	// analytics/SpeedInsights and consent-cookie writes inside third-party
	// iframes (see ClientProviders / ConsentProvider). Outside (marketing)/[locale],
	// so it also bypasses the intl middleware.
	if (pathname.startsWith("/embed")) {
		const res = forward(req, { [EMBED_FLAG_HEADER]: "1" });
		res.headers.set("Content-Security-Policy", "frame-ancestors *");
		return res;
	}

	if (pathsWithoutLocale.some((path) => pathname.startsWith(path))) {
		// The SaaS layout has no URL of its own; without this a signed-out
		// visitor loses the link they opened, query and all (Fizzy #3036).
		const search = new URLSearchParams(req.nextUrl.search);
		search.delete("_rsc");
		const query = search.toString();
		const res = forward(req, {
			[RETURN_TO_HEADER]: query ? `${pathname}?${query}` : pathname,
		});
		if (SHARED_FRAME_EMBED_PATH.test(pathname)) {
			res.headers.set("Content-Security-Policy", FRAME_EMBED_PARENT_CSP);
		}
		return res;
	}

	if (!appConfig.ui.marketing.enabled) {
		return NextResponse.redirect(new URL("/app", origin));
	}

	return rewriteLocaleViaBeforeFiles(req, intlMiddleware(req));
}

export const config = {
	matcher: [
		"/((?!api|mcp|\\.well-known|cli/|image-proxy|images|integrations|fonts|_next/static|_next/image|favicon.ico|icon.png|manifest\\.json|sitemap.xml|robots.txt|llms\\.txt|llms-full\\.txt).*)",
	],
};
