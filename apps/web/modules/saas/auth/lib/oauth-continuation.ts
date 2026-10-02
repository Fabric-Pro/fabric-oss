/**
 * Resuming an agent's authorization after the person signs in.
 *
 * The authorization server sends an unauthenticated browser to the login page
 * with the original authorization request in the query, plus the parameters it
 * signed (`sig`, `exp`, `ba_*`). Whatever way the person signs in — password,
 * magic link, passkey, a second factor in between — the one thing every one of
 * them can do is navigate to a path afterwards, so the path to come back to
 * resumes the authorization endpoint with the original request. The signature
 * parameters are dropped: they authenticate the login page's query, not the
 * authorization request.
 *
 * The request travels base64url-encoded behind `/auth/oauth/resume` rather than
 * as the authorize URL itself. A magic link carries its destination as
 * `callbackURL`, and Better Auth's link endpoint decodes that value twice
 * before checking it against a relative-path pattern that refuses `:` — so the
 * encoded `redirect_uri` inside an authorize URL failed the check after the
 * second decode and the link answered 403 (reproduced against a local server).
 * Base64url has nothing a decode can change.
 */

import { OAUTH_ISSUER_PATH } from "@repo/auth/lib/oauth-scopes";

const AUTHORIZE_PATH = `${OAUTH_ISSUER_PATH}/oauth2/authorize`;

/** A route handler that redirects to the authorization endpoint. */
export const OAUTH_RESUME_PATH = "/auth/oauth/resume";

const DROPPED_PARAMS = new Set(["sig", "exp", "ba_iat", "ba_pl", "ba_param"]);

function toBase64Url(text: string): string {
	return btoa(text)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string | null {
	if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
		return null;
	}
	try {
		return atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
	} catch {
		return null;
	}
}

/**
 * The path that resumes the authorization, or null when this login was not
 * started by an agent. A request without a signature, a client and a redirect
 * target is not one.
 */
export function oauthContinuationPath(
	search: Pick<URLSearchParams, "get" | "entries">,
): string | null {
	if (
		!search.get("sig") ||
		!search.get("client_id") ||
		!search.get("redirect_uri")
	) {
		return null;
	}

	const resumed = new URLSearchParams();
	for (const [key, value] of search.entries()) {
		if (!DROPPED_PARAMS.has(key)) {
			resumed.append(key, value);
		}
	}
	return `${OAUTH_RESUME_PATH}?q=${toBase64Url(resumed.toString())}`;
}

/**
 * Where the resume route sends the browser: the authorization endpoint with
 * the original request, or null for a value that is not one. The endpoint
 * validates the client and the redirect itself; this only refuses what could
 * not be an authorization request at all.
 */
export function authorizationResumeLocation(q: string | null): string | null {
	const query = q ? fromBase64Url(q) : null;
	if (query === null) {
		return null;
	}
	const params = new URLSearchParams(query);
	if (!params.get("client_id") || !params.get("redirect_uri")) {
		return null;
	}
	return `${AUTHORIZE_PATH}?${params.toString()}`;
}

/** The resume path is a route handler: it needs a real navigation. */
export function isServerNavigationPath(path: string): boolean {
	return path.startsWith("/api/") || path.startsWith(OAUTH_RESUME_PATH);
}
