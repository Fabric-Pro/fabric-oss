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
