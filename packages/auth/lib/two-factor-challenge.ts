/**
 * Creates the pair of verification rows Better Auth's 2FA challenge flow
 * requires, for use by the `hooks.after` replica in `auth.ts` that enforces
 * 2FA on magic-link and OAuth sign-ins (paths Better Auth's own `twoFactor()`
 * plugin hook does not intercept — see auth.ts for why).
 *
 * Better Auth 1.6.22's own challenge creation (`dist/plugins/two-factor/
 * index.mjs`) writes two rows for every challenge:
 *   - `2fa-<random>`                      — the challenge itself, value = userId
 *   - `2fa-attempts-<the identifier above>` — the attempt-budget counter, value = "0"
 * both sharing one `expiresAt`. `verifyTwoFactor().beginAttempt()`
 * (`dist/plugins/two-factor/verify-two-factor.mjs`) consumes the attempts
 * row to enforce `TOO_MANY_ATTEMPTS` — but only for an unauthenticated
 * sign-in submission (`isSignIn`, i.e. exactly the challenge this module
 * creates): `dist/plugins/two-factor/totp/index.mjs` calls
 * `isSignIn ? await beginAttempt(5) : null`, so an already-authenticated
 * user verifying/enrolling TOTP never calls it at all, and never touches
 * this row. On a sign-in submission, if the row is missing it throws
 * `UNAUTHORIZED` / `INVALID_TWO_FACTOR_COOKIE` before the submitted code
 * is ever compared. Extracted here (rather than left inline in the
 * `createAuthMiddleware` hook) so the row pairing is unit-testable
 * without booting Better Auth.
 */

import { randomBytes } from "node:crypto";

interface TwoFactorChallengeAdapter {
	createVerificationValue: (
		value: { value: string; identifier: string; expiresAt: Date },
		ctx: unknown,
	) => Promise<unknown>;
}

export interface CreateTwoFactorChallengeParams {
	internalAdapter: TwoFactorChallengeAdapter;
	userId: string;
	maxAgeSeconds: number;
	ctx: unknown;
}

export interface TwoFactorChallenge {
	identifier: string;
	expiresAt: Date;
}

export async function createTwoFactorChallenge({
	internalAdapter,
	userId,
	maxAgeSeconds,
	ctx,
}: CreateTwoFactorChallengeParams): Promise<TwoFactorChallenge> {
	const identifier = `2fa-${randomBytes(15).toString("base64url")}`;
	// Both rows share one timestamp. It isn't compared between the two rows —
	// what matters is that the attempts row's budget can't outlive or expire
	// before the challenge it belongs to: `beginAttempt()`'s `rearm()`
	// (`dist/plugins/two-factor/verify-two-factor.mjs`) re-writes the
	// attempts row — using the *challenge* row's `expiresAt` — after a
	// failed or aborted comparison (`recordFailure`/`restore`; a success or
	// an already-exhausted budget never calls it), so seeding it here with
	// the same value up front just anticipates what rearm() would set.
	const expiresAt = new Date(Date.now() + maxAgeSeconds * 1000);

	// Sequential, not Promise.all: matches Better Auth's own challenge
	// creation (`dist/plugins/two-factor/index.mjs`). This doesn't prevent
	// every orphan — if the attempts write below rejects, the challenge row
	// above still exists until it expires — but with Promise.all the two
	// writes race independently, so a rejected challenge write could still
	// leave a *successful* attempts write behind: an attempts-only row with
	// no challenge row to attach to. Sequential order rules that out, since
	// the attempts write is never attempted until the challenge write above
	// has already succeeded.
	await internalAdapter.createVerificationValue(
		{
			value: userId,
			identifier,
			expiresAt,
		},
		ctx,
	);
	await internalAdapter.createVerificationValue(
		{
			value: "0",
			identifier: `2fa-attempts-${identifier}`,
			expiresAt,
		},
		ctx,
	);

	return { identifier, expiresAt };
}
