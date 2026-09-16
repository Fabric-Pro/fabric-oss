/**
 * Message for an integration OAuth callback that the API refused outright.
 *
 * The callback procedures are session-bound: the browser the provider
 * redirected must hold a Fabric session, and it must be the account that
 * started the flow. Both refusals arrive here as oRPC errors rather than as
 * the `{ success: false }` result the popup normally renders, so without this
 * the page would show the bare code ("Unauthorized") or, on the GitHub route
 * in production, nothing more specific than "callback failed".
 *
 * Only these two codes get their own copy. UNAUTHORIZED carries no server
 * message, so the text lives here; FORBIDDEN carries the server's own
 * explanation (wrong account, no longer a member), which is written for the
 * user and safe to show. Anything else keeps the route's existing fallback.
 */

import { ORPCError } from "@orpc/client";

export const NOT_SIGNED_IN_MESSAGE =
	"You are not signed in to Fabric in this browser. Sign in, then start the connection again.";

export function oauthCallbackFailureMessage(
	error: unknown,
	fallback: string,
): string {
	if (error instanceof ORPCError) {
		if (error.code === "UNAUTHORIZED") {
			return NOT_SIGNED_IN_MESSAGE;
		}
		if (error.code === "FORBIDDEN" && error.message) {
			return error.message;
		}
	}
	return fallback;
}
