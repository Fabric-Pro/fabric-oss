/**
 * Account-level 2FA lockout policy (SOC 2 CC6.1).
 *
 * Applies only to sign-in challenges — Better Auth gates the check on
 * `isSignIn`, so an already-authenticated user verifying/enrolling TOTP
 * never touches this counter. It caps consecutive failed factor
 * comparisons — TOTP, OTP, and backup codes all increment the same
 * account-wide counter, regardless of which challenge or IP the attempt
 * came from. After `maxFailedAttempts` (10) consecutive failures the
 * account is locked for `durationSeconds` (900s / 15 minutes); a
 * successful verification resets the counter to zero. State lives on the
 * `two_factor` row: `failedVerificationCount` / `lockedUntil`
 * (`packages/database/prisma/schema.prisma`, migration
 * `20260814060000_add_two_factor_lockout_columns`).
 *
 * This delegates a SOC 2 CC6.1 control to Better Auth's built-in
 * `accountLockout` (`better-auth`, exact-pinned — see
 * `packages/auth/package.json`) rather than reimplementing it. The
 * contract this delegation depends on — the plugin id, the exact option
 * values, the verify endpoint paths, and the `two_factor` schema fields —
 * is pinned by `__tests__/two-factor-lockout-policy.test.ts`; a
 * better-auth upgrade that silently changes any of it fails that suite.
 *
 * Aligns with SP 800-63B-4 §3.2.2's consecutive-failure throttling and its
 * reset of prior failed attempts following successful authentication
 * (alignment with those principles, not a claim of implementing every
 * authenticator-disabling requirement in the publication).
 *
 * Complementary layers, deliberately untouched here:
 *  - the per-IP rate limiter (`packages/api/lib/auth-rate-limit.ts`)
 *  - Better Auth's per-challenge attempt budget (`beginAttempt(5)`,
 *    wired via `packages/auth/lib/two-factor-challenge.ts`)
 */

import { APIError } from "better-auth/api";
import type { TwoFactorOptions } from "better-auth/plugins";
import { twoFactor } from "better-auth/plugins";

export const TWO_FACTOR_ACCOUNT_LOCKOUT: NonNullable<
	TwoFactorOptions["accountLockout"]
> = {
	enabled: true,
	maxFailedAttempts: 10,
	durationSeconds: 900,
};

export function createTwoFactorPlugin() {
	return twoFactor({ accountLockout: TWO_FACTOR_ACCOUNT_LOCKOUT });
}

/**
 * True iff `error` is better-auth's account-lockout rejection
 * (`ACCOUNT_TEMPORARILY_LOCKED`, thrown by `assertTwoFactorNotLocked`).
 * That code has exactly one throw site in better-auth — the account
 * lockout — so the code alone is a precise discriminator for identifying
 * the error itself. Used from `auth.ts`'s `hooks.after` middleware
 * (`ctx.context.returned`), alongside a path check that scopes WHERE the
 * resulting security log fires — not because the classifier itself needs
 * one.
 */
export function isTwoFactorAccountLockedError(error: unknown): boolean {
	return (
		error instanceof APIError &&
		error.body?.code === "ACCOUNT_TEMPORARILY_LOCKED"
	);
}
