import { routing } from "@i18n/routing";
import { config as appConfig } from "@repo/config";
import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import createMiddleware from "next-intl/middleware";
import { withQuery } from "ufo";

const intlMiddleware = createMiddleware(routing);
const DEFAULT_LOCALE = "en";
const SESSION_DATA_COOKIE = `${appConfig.auth.cookiePrefix}.session_data`;
const SESSION_DATA_COOKIE_SECURE = `__Secure-${appConfig.auth.cookiePrefix}.session_data`;

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
		return NextResponse.next();
	}

	// Handle /en/blog, /de/blog etc. — bypass intl middleware to prevent locale stripping
	const localeBlogMatch = pathname.match(/^\/([a-z]{2})\/blog(\/.*)?$/);
	if (localeBlogMatch) {
		if (!appConfig.ui.marketing.enabled) {
			return NextResponse.redirect(new URL("/app", origin));
		}
		return NextResponse.next();
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
			return NextResponse.next();
		}
		const appRes = NextResponse.next();
		appRes.headers.set("X-Frame-Options", "SAMEORIGIN");
		appRes.headers.set("Content-Security-Policy", "frame-ancestors 'self'");
		return appRes;
	}

	if (pathname.startsWith("/auth")) {
		if (!appConfig.ui.saas.enabled) {
			return NextResponse.redirect(new URL("/", origin));
		}

		return NextResponse.next();
	}

	// Public embeddable widgets (iframe), e.g. app/embed/newsletter. Frameable by
	// any origin AND flagged via x-embed-route so the root providers suppress
	// analytics/SpeedInsights and consent-cookie writes inside third-party
	// iframes (see ClientProviders / ConsentProvider). Outside (marketing)/[locale],
	// so it also bypasses the intl middleware.
	if (pathname.startsWith("/embed")) {
		const requestHeaders = new Headers(req.headers);
		requestHeaders.set("x-embed-route", "1");
		const res = NextResponse.next({ request: { headers: requestHeaders } });
		res.headers.set("Content-Security-Policy", "frame-ancestors *");
		return res;
	}

	const pathsWithoutLocale = [
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
		"/change-password",
	];

	if (pathsWithoutLocale.some((path) => pathname.startsWith(path))) {
		return NextResponse.next();
	}

	if (!appConfig.ui.marketing.enabled) {
		return NextResponse.redirect(new URL("/app", origin));
	}

	return intlMiddleware(req);
}

export const config = {
	matcher: [
		"/((?!api|mcp|image-proxy|images|integrations|fonts|_next/static|_next/image|favicon.ico|icon.png|manifest\\.json|sitemap.xml|robots.txt|llms\\.txt|llms-full\\.txt).*)",
	],
};
