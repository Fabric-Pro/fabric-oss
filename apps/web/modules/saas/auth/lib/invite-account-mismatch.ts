/**
 * True when a signed-in user is viewing an invite addressed to a *different*
 * account. Used to break the invite redirect loop: when this is true we must
 * NOT auto-redirect an authenticated user; we prompt them to switch accounts.
 *
 * Returns false when either email is missing (logged-out, or no invite target)
 * so callers fall back to their normal behavior.
 */
export function isInviteAccountMismatch(
	sessionEmail: string | null | undefined,
	inviteEmail: string | null | undefined,
): boolean {
	if (!sessionEmail || !inviteEmail) {
		return false;
	}
	return sessionEmail.toLowerCase() !== inviteEmail.toLowerCase();
}
