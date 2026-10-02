/**
 * What the consent screen shows, derived from the authorization request in the
 * page's query.
 *
 * Everything here is display only. The authorization server verifies the
 * signature on the query when the person answers, so a forged link cannot make
 * the screen say one thing and grant another.
 */

import { isOAuthScope, type OAuthScope } from "@repo/auth/lib/oauth-scopes";

/** The scopes the request asks for that Fabric knows how to describe. */
export function requestedScopes(scopeParam: string | null): OAuthScope[] {
	return (scopeParam ?? "")
		.split(" ")
		.filter((scope): scope is OAuthScope => isOAuthScope(scope));
}

/** Scopes the request asks for that this screen has no sentence for. */
export function unknownScopes(scopeParam: string | null): string[] {
	return (scopeParam ?? "")
		.split(" ")
		.filter((scope) => scope.length > 0 && !isOAuthScope(scope));
}

/**
 * Where the person is sent after deciding. The host for web and loopback
 * targets, the scheme for a private-use scheme such as an editor's.
 */
export function redirectTargetLabel(redirectUri: string | null): string | null {
	if (!redirectUri) {
		return null;
	}
	try {
		const url = new URL(redirectUri);
		if (url.protocol === "http:" || url.protocol === "https:") {
			return url.host;
		}
		return url.protocol;
	} catch {
		return null;
	}
}
