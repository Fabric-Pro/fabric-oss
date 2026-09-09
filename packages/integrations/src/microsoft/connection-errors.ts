/**
 * Recognise a Microsoft-account-not-usable error from executeMicrosoftTeamsTool.
 *
 * The integration throws six distinct messages for this condition
 * (packages/integrations/src/microsoft/index.ts:106, 135, 510, 574, 579, 680):
 * "not connected", plus four token-lifecycle failures that say "reconnect".
 * Matching only the first two — as the earlier drafts of these procedures did —
 * sends the far more common expired-token case down the generic 500 path, so
 * the UI shows "something went wrong" instead of the connect-your-account CTA.
 *
 * Deliberately dependency-free: this is a plain string classifier shared by
 * apps/web, @repo/api, and @repo/temporal (which must not depend on
 * @repo/api), so it lives in its own file that pulls in nothing else —
 * consumers get the classification without dragging in `db` or crypto just to
 * check a string.
 */
export function isMicrosoftNotConnectedError(message: string): boolean {
	return (
		message.includes("Microsoft not connected") ||
		message.includes("Microsoft account in Settings")
	);
}

/**
 * Auth-shaped 403 markers `graphRequest` (index.ts) checks to decide whether
 * to attempt a token refresh — see index.ts's `isAuthError` check. When
 * there is no refresh token, or the post-refresh retry still 403s, the
 * response is returned unchanged and the caller's error message ends up
 * containing one of these same markers. They are token-lifecycle failures
 * ("reconnect your account"), NOT "you lack access to this resource" — so
 * `isMicrosoftAccessDeniedError` below must NOT classify them as the
 * per-resource condition it exists to detect.
 */
const AUTH_SHAPED_403_MARKERS = [
	"No authorization information",
	"InvalidAuthenticationToken",
	"Access token has expired",
	"ExpiredToken",
	"AuthenticationError",
] as const;

/**
 * Recognise a Graph 403 (the caller's Microsoft account is connected, but
 * lacks access to this specific chat/channel — e.g. removed from the chat).
 *
 * Unlike `isMicrosoftNotConnectedError`, this is a per-resource condition,
 * not an account-wide one: one Teams context on a project can 403 for a
 * given user while the rest read fine. Callers that read Teams contexts on
 * behalf of a specific user (Fizzy #2450) use this to log at `warn` instead
 * of `error` — the failure is expected and already surfaced per-context to
 * that user in the project's Context tab, not an operational fault.
 *
 * A 403 alone isn't enough: `graphRequest` also returns a 403 unchanged for
 * an auth-shaped failure it couldn't refresh past (missing/invalid/expired
 * token) — see `AUTH_SHAPED_403_MARKERS`. That's the SAME account-wide,
 * reconnect-your-account condition `isMicrosoftNotConnectedError` covers
 * for other call shapes, not "this account can't read this one chat", so it
 * must return false here. The real per-resource case this function targets
 * looks like `{"error":{"code":"Forbidden","message":"UnknownError"}}` — no
 * auth marker present.
 */
export function isMicrosoftAccessDeniedError(message: string): boolean {
	const isForbidden =
		message.includes("403 Forbidden") ||
		message.includes('"code":"Forbidden"');
	if (!isForbidden) {
		return false;
	}
	return !AUTH_SHAPED_403_MARKERS.some((marker) => message.includes(marker));
}
