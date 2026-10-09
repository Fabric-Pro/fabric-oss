/**
 * Delivering an authorization refusal to the client (RFC 6749 §4.1.2.1).
 *
 * When the client and its `redirect_uri` are valid, a refusal of the
 * authorization is sent to that `redirect_uri` as `error`, `error_description`,
 * `state` and `iss` (RFC 9207), so the agent that started the flow learns it was
 * refused instead of waiting on its listener. When either is not valid, the
 * request must not be redirected, and the refusal stays the plain error answer.
 */

import { APIError } from "better-auth/api";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export interface AuthorizeRefusalContext {
	headers?: Headers;
	redirect(url: string): Error;
	context: { baseURL: string };
}

function parse(uri: string): URL | null {
	try {
		return new URL(uri);
	} catch {
		return null;
	}
}

/**
 * Whether a registered `redirect_uri` admits the requested one: an exact match,
 * or, for a loopback `http` URI, the same address and path on any port (RFC
 * 8252 §7.3), as the provider itself matches them.
 */
function admits(registered: string, requested: URL, raw: string): boolean {
	if (registered === raw) {
		return true;
	}
	const registeredUrl = parse(registered);
	return (
		registeredUrl !== null &&
		registeredUrl.protocol === "http:" &&
		requested.protocol === "http:" &&
		LOOPBACK_HOSTS.has(registeredUrl.hostname) &&
		registeredUrl.hostname === requested.hostname &&
		registeredUrl.pathname === requested.pathname &&
		registeredUrl.search === requested.search
	);
}

function isRegisteredRedirectUri(
	requested: string | null,
	registered: readonly string[],
): requested is string {
	if (!requested || requested.includes("#")) {
		return false;
	}
	const url = parse(requested);
	if (!url || url.username || url.password) {
		return false;
	}
	return registered.some((entry) => admits(entry, url, requested));
}

/**
 * The error to throw for a refused authorization: a redirect to the client's
 * registered `redirect_uri` carrying the refusal, or the plain error answer
 * when the `redirect_uri` is not one the client registered or the caller asked
 * for JSON.
 */
export function refusalForClient(
	ctx: AuthorizeRefusalContext,
	request: { redirectUri: string | null; state: string | null },
	registeredRedirectUris: readonly string[],
	status: "BAD_REQUEST" | "FORBIDDEN",
	details: { error: string; error_description: string },
): Error {
	if (
		ctx.headers?.get("accept")?.includes("application/json") ||
		!isRegisteredRedirectUri(request.redirectUri, registeredRedirectUris)
	) {
		return new APIError(status, details);
	}
	const target = new URL(request.redirectUri);
	target.searchParams.set("error", details.error);
	target.searchParams.set("error_description", details.error_description);
	if (request.state) {
		target.searchParams.set("state", request.state);
	}
	target.searchParams.set("iss", ctx.context.baseURL);
	return ctx.redirect(target.toString());
}
