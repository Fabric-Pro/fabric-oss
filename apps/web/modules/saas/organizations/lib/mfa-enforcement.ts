/**
 * Organization-wide MFA enforcement decision (SOC 2 CC6.1).
 *
 * Pure so the redirect logic used by the organization layout is unit-testable
 * without booting Next.js. Returns `true` when the signed-in member must be
 * redirected to enroll two-factor authentication before accessing the org.
 *
 * The rules, in order:
 *  - `twoFactorGloballyEnabled`: if 2FA is not available platform-wide there is
 *    nothing to enroll into, so never gate.
 *  - `!isGuest`: guests reach an org via project membership and are governed by
 *    their own relationship, not org membership — they are not subject to the
 *    org's member-MFA policy.
 *  - `!userHasTwoFactor`: members who already have 2FA are compliant.
 *  - `orgRequiresTwoFactor`: only enforce when the org opted in.
 */
export function shouldEnforceOrgTwoFactor(params: {
	twoFactorGloballyEnabled: boolean;
	isGuest: boolean;
	userHasTwoFactor: boolean;
	orgRequiresTwoFactor: boolean;
}): boolean {
	return (
		params.twoFactorGloballyEnabled &&
		!params.isGuest &&
		!params.userHasTwoFactor &&
		params.orgRequiresTwoFactor
	);
}
