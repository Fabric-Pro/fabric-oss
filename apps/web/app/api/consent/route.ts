/**
 * `/api/consent` — records a privacy-banner decision without any client-side
 * JavaScript.
 *
 * The banner's buttons are a real form submit. When the page is hydrated the
 * client handler cancels the submit and keeps the SPA experience; when the
 * client bundle never runs — a blocked or failed script, an extension that
 * interferes with React's event delegation, a crashed provider subtree — the
 * browser posts the form here instead. Without this path a banner whose
 * handlers were never attached is undismissable: its hover and focus styles
 * still work (they are pure CSS), so it looks alive while every click is a
 * no-op.
 */

import {
	CONSENT_COOKIE_NAME,
	CONSENT_DECISION_FIELD,
	CONSENT_EXPIRY_DAYS,
	CONSENT_PREFERENCES_COOKIE_NAME,
	CONSENT_RETURN_TO_FIELD,
	FABRIC_ANALYTICS_CONSENT_COOKIE_NAME,
	getConsentCookieDomain,
	resolveConsentDecision,
	sanitizeReturnTo,
} from "@shared/lib/consent";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const CONSENT_MAX_AGE_SECONDS = CONSENT_EXPIRY_DAYS * 24 * 60 * 60;

function getHost(request: Request) {
	return request.headers.get("host") ?? new URL(request.url).host;
}

function getHostname(request: Request) {
	const host = getHost(request);
	// Strip the port, but leave a bracketed IPv6 literal intact.
	return host.startsWith("[")
		? host.slice(0, host.indexOf("]") + 1)
		: host.split(":")[0];
}

/** The same-site path the referring page was on, query string included. */
function refererPath(request: Request) {
	const referer = request.headers.get("referer");
	if (!referer) {
		return null;
	}

	try {
		const url = new URL(referer);
		if (url.host !== getHost(request)) {
			return null;
		}
		return sanitizeReturnTo(`${url.pathname}${url.search}`);
	} catch {
		return null;
	}
}

/**
 * Where to send the browser back to.
 *
 * The posted field carries only a pathname — `usePathname()` cannot see the
 * query — so the referring page wins whenever it is the same page, which is
 * what keeps a visitor's `?page=2` from being dropped on dismissal. Both
 * candidates are constrained to a same-site path.
 */
function resolveReturnTo(request: Request, posted: string | undefined) {
	const fromField = sanitizeReturnTo(posted);
	const fromReferer = refererPath(request);

	if (fromField && fromReferer) {
		const [refererPathname] = fromReferer.split("?");
		return refererPathname === fromField ? fromReferer : fromField;
	}

	return fromField ?? fromReferer ?? "/";
}

/**
 * Route handlers get none of the origin validation Next.js builds into Server
 * Actions, and this endpoint takes no session and no token. Without this check
 * any third-party page could auto-submit a form and opt a visitor into
 * analytics they never accepted — and stop the banner from ever asking them.
 * Browsers send `Origin` on every POST, so rejecting only a present-and-
 * mismatched value leaves the no-JS path intact.
 */
function isCrossSitePost(request: Request) {
	const origin = request.headers.get("origin");
	if (!origin) {
		return false;
	}

	try {
		return new URL(origin).host !== getHost(request);
	} catch {
		return true;
	}
}

export async function POST(request: Request) {
	if (isCrossSitePost(request)) {
		return new NextResponse("Cross-site consent posts are not accepted", {
			status: 403,
		});
	}

	const formData = await request.formData();
	const decision = formData.get(CONSENT_DECISION_FIELD);
	const postedReturnTo = formData.get(CONSENT_RETURN_TO_FIELD);

	const { state, preferences } = resolveConsentDecision(
		typeof decision === "string" ? decision : undefined,
	);
	const returnTo = resolveReturnTo(
		request,
		typeof postedReturnTo === "string" ? postedReturnTo : undefined,
	);

	const forwardedProto = request.headers.get("x-forwarded-proto");
	const isSecure = forwardedProto
		? forwardedProto.split(",")[0].trim() === "https"
		: new URL(request.url).protocol === "https:";

	// 303 so the browser follows up with a GET — a reload of the page the
	// banner was shown on, now rendered with the consent cookies in place.
	// Built from the forwarded host rather than `request.url`, which behind a
	// proxy can carry an internal hostname.
	const response = NextResponse.redirect(
		new URL(
			returnTo,
			`${isSecure ? "https" : "http"}://${getHost(request)}`,
		),
		303,
	);

	const cookieOptions = {
		domain: getConsentCookieDomain(getHostname(request)),
		path: "/",
		maxAge: CONSENT_MAX_AGE_SECONDS,
		sameSite: "lax" as const,
		secure: isSecure,
		// Readable by the client provider, which keeps its own copy in sync.
		httpOnly: false,
	};

	response.cookies.set(CONSENT_COOKIE_NAME, state, cookieOptions);
	response.cookies.set(
		CONSENT_PREFERENCES_COOKIE_NAME,
		JSON.stringify(preferences),
		cookieOptions,
	);
	response.cookies.set(
		FABRIC_ANALYTICS_CONSENT_COOKIE_NAME,
		preferences.analytics ? "granted" : "denied",
		cookieOptions,
	);

	return response;
}
