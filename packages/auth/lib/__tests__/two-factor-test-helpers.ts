/**
 * Harness helpers shared by the 2FA suites that drive Better Auth's public
 * test instance (`two-factor-lockout-behavior.test.ts` and
 * `two-factor-challenge-contract.test.ts`). Kept in ONE module because both
 * suites exist to pin upstream behavior: two hand-copied versions of these
 * helpers could drift apart and make the suites disagree about the same
 * library.
 *
 * This includes the replica-challenge test plugin
 * (`createReplicaChallengePlugin` / `startReplicaChallenge`), which drives
 * `createTwoFactorChallenge` — the same bridge `auth.ts` uses to gate
 * magic-link and OAuth sign-ins — through a real endpoint. Both suites need
 * it: the contract-drift suite to compare the rows it writes against
 * better-auth's own native challenge, and the lockout suite to prove the
 * account-level lock also protects bridge-created challenges, not just ones
 * from native email/username/phone sign-in.
 *
 * Not a test file itself — the vitest include is `lib/__tests__/**\/*.test.ts`,
 * so nothing here runs on its own.
 */

import { APIError, createAuthEndpoint } from "better-auth/api";
import { parseSetCookieHeader } from "better-auth/cookies";
import { symmetricDecrypt } from "better-auth/crypto";
import { expect } from "vitest";
import { createTwoFactorChallenge } from "../two-factor-challenge";

/**
 * A TOTP body value guaranteed to fail the account's TOTP comparison, with
 * zero derivation needed. Better Auth's `verifyTOTP` always compares
 * against a `digits`-length (6 — the plugin's unconfigured default in
 * these suites) code produced by RFC 4226's `generateHOTP`, which always
 * pads to exactly that length, via `@better-auth/utils`'s
 * `constantTimeEqualOTP` (otp.mjs:9-15): `difference = input.length ^
 * expected.length`, then OR'd with a per-character XOR. A length mismatch
 * alone makes that nonzero (false) before any character is even compared —
 * no throw. A 7-digit value therefore can never equal the real 6-digit
 * code in ANY time window, unlike a fixed 6-digit guess (even one
 * excluding the current window's code): Better Auth's `verify()` checks a
 * window of ±1 step (`@better-auth/utils@0.4.2` otp.mjs, `verifyTOTP`'s
 * `window = 1` default), so a 6-digit guess could still coincide with the
 * previous or next 30s step's code, and a boundary crossed between
 * deriving and submitting it would reopen that race. This still reaches
 * the real factor comparison and counts as a failed attempt exactly like
 * a wrong 6-digit code would — it fails only on VALUE, never on shape.
 */
export const WRONG_TOTP_CODE = "0000000";

/**
 * Extract a `name=value` Cookie-header fragment from a response's
 * Set-Cookie headers, matching by substring (e.g. "two_factor",
 * "session_token") — robust to the `better-auth.` prefix and to an
 * optional `__Secure-` prefix, neither of which this asserts on.
 */
export function extractCookie(headers: Headers, nameIncludes: string): string {
	const rawSetCookies =
		typeof headers.getSetCookie === "function"
			? headers.getSetCookie()
			: [headers.get("set-cookie")].filter((v): v is string => !!v);
	for (const raw of rawSetCookies) {
		for (const [name, attrs] of parseSetCookieHeader(raw)) {
			if (name.includes(nameIncludes)) {
				return `${name}=${attrs.value}`;
			}
		}
	}
	throw new Error(`No Set-Cookie header found containing "${nameIncludes}"`);
}

export function expectAPIErrorCode(error: unknown, code: string) {
	expect(error).toBeInstanceOf(APIError);
	expect((error as APIError).body?.code).toBe(code);
}

/**
 * A 6-digit OTP guaranteed to differ from every code in `delivered`.
 *
 * Unlike TOTP (see WRONG_TOTP_CODE, which fails on LENGTH and so can never
 * match), Better Auth's 2FA OTP is compared with `constantTimeEqual` against a
 * randomly generated `digits`-length numeric string, so a hard-coded guess is
 * a genuine one-in-a-million collision per issued code — a CI flake that would
 * surface as a success where the test expects a rejection. Deriving the wrong
 * value from what was actually delivered removes the possibility entirely.
 */
export function wrongOTPCode(...delivered: (string | undefined)[]): string {
	const taken = new Set(delivered.filter((code): code is string => !!code));
	for (let candidate = 0; candidate <= taken.size; candidate++) {
		const code = String(candidate).padStart(6, "0");
		if (!taken.has(code)) {
			return code;
		}
	}
	/* c8 ignore next -- unreachable: the loop tries one more value than exists */
	throw new Error("Could not derive an unused OTP value");
}

// The instance type varies with the plugin list passed to getTestInstance;
// narrowing it fully isn't worth it for the handful of `auth.api.*` calls the
// suites make.
type TestInstance = {
	auth: any;
	testUser: { email: string; password: string };
};

/**
 * Produce a currently-valid TOTP for an enrolled user on a test instance.
 *
 * The enrolment response and `/two-factor/get-totp-uri` both hand back the
 * BASE32 form of the secret, while the server-only `generateTOTP` endpoint —
 * which derives codes exactly as `verifyTOTP` checks them — takes the raw one.
 * So the raw secret is read back from the stored row and decrypted with the
 * instance's own key (`secretConfig` is the plain `secret` when no secrets
 * array is configured, which is the harness's shape).
 */
export async function currentTOTPFor(
	instance: { auth: any; db: any },
	userId: string,
): Promise<string> {
	const row = (await instance.db.findOne({
		model: "twoFactor",
		where: [{ field: "userId", value: userId }],
	})) as { secret: string } | null;
	if (!row) {
		throw new Error(`No twoFactor row for user ${userId}`);
	}
	const secret = await symmetricDecrypt({
		key: (instance.auth as { options: { secret: string } }).options.secret,
		data: row.secret,
	});
	const { code } = await instance.auth.api.generateTOTP({ body: { secret } });
	return code as string;
}

/**
 * Enable 2FA for the instance's default test user and return a cookie for a
 * LIVE authenticated session — the precondition for every step-up scenario.
 *
 * The rotation handling is the whole reason this is shared. With
 * `skipVerificationOnEnable`, `/two-factor/enable` mints a replacement session
 * and deletes the one that authorized the call
 * (`dist/plugins/two-factor/index.mjs:96-104`), so the sign-in cookie is
 * already dead when it returns. A suite that keeps using it silently tests the
 * UNAUTHENTICATED branch instead — every verify comes back
 * INVALID_TWO_FACTOR_COOKIE, which looks like a wrong-code rejection at a
 * glance and would quietly void a step-up assertion.
 */
export async function enrollTwoFactorAndAuthenticate(instance: TestInstance) {
	const { auth, testUser } = instance;

	const signIn = await auth.api.signInEmail({
		body: { email: testUser.email, password: testUser.password },
		returnHeaders: true,
	});
	const userId: string = signIn.response.user.id;
	const signInCookie = extractCookie(signIn.headers, "session_token");

	const enabled = await auth.api.enableTwoFactor({
		body: { password: testUser.password },
		headers: new Headers({ cookie: signInCookie }),
		returnHeaders: true,
	});

	let sessionCookie = signInCookie;
	try {
		sessionCookie = extractCookie(enabled.headers, "session_token");
	} catch {
		// Not rotated on this configuration — the sign-in cookie still stands.
	}

	/** Start a fresh sign-in 2FA challenge (the unauthenticated branch). */
	async function startChallenge(): Promise<string> {
		const res = await auth.api.signInEmail({
			body: { email: testUser.email, password: testUser.password },
			returnHeaders: true,
		});
		return extractCookie(res.headers, "two_factor");
	}

	return {
		userId,
		sessionCookie,
		backupCodes: enabled.response.backupCodes as string[],
		startChallenge,
	};
}

/**
 * Mutable slot the replica endpoint below reads its target user from.
 * `createAuthEndpoint` handlers take no per-call arguments, so a caller
 * stages the user id here immediately before invoking the endpoint (see
 * `startReplicaChallenge`).
 */
export interface ReplicaChallengeState {
	userId?: string;
}

/**
 * A test-only plugin exposing ONE endpoint that performs exactly the two
 * production statements `auth.ts` runs when it gates a magic-link or OAuth
 * sign-in: `createTwoFactorChallenge(...)` against the live
 * `ctx.context.internalAdapter`, then the signed `two_factor` cookie via
 * `createAuthCookie` + `setSignedCookie`.
 *
 * Running the replica through a real endpoint (rather than calling it with a
 * synthetic adapter) is what makes it meaningful for both consumers of this
 * helper: the contract-drift suite compares rows written by the same
 * `internalAdapter` on the same instance as the native hook, and the lockout
 * suite exercises the same signed-cookie mechanism `auth.ts` uses rather than
 * reimplementing it.
 *
 * The endpoint carries none of auth.ts's surrounding logic (session
 * revocation, redirect recovery) — that is not what either consumer proves.
 *
 * Shared by two-factor-challenge-contract.test.ts and
 * two-factor-lockout-behavior.test.ts (see the module doc comment above) —
 * this and `startReplicaChallenge` were previously hand-copied only into the
 * former; extracted here so both suites can drive bridge-created challenges
 * against a single implementation.
 */
export function createReplicaChallengePlugin(
	state: ReplicaChallengeState,
	maxAgeSeconds: number,
) {
	return {
		id: "test-replica-two-factor-challenge",
		endpoints: {
			createReplicaTwoFactorChallenge: createAuthEndpoint(
				"/test-replica-two-factor/challenge",
				{ method: "POST" },
				async (ctx) => {
					const userId = state.userId;
					if (!userId) {
						throw new Error(
							"test setup error: no userId staged for the replica challenge endpoint",
						);
					}
					// Consume the staged value so a later call that forgets to
					// stage its own userId trips the guard above instead of
					// silently reusing this one.
					state.userId = undefined;

					const { identifier } = await createTwoFactorChallenge({
						internalAdapter: ctx.context.internalAdapter,
						userId,
						maxAgeSeconds,
						ctx,
					});

					const cookieConfig = ctx.context.createAuthCookie(
						"two_factor",
						{
							maxAge: maxAgeSeconds,
						},
					);
					await ctx.setSignedCookie(
						cookieConfig.name,
						identifier,
						ctx.context.secret,
						cookieConfig.attributes,
					);

					return ctx.json({ identifier });
				},
			),
		},
	};
}

/**
 * Minimal shape `startReplicaChallenge` needs from a `getTestInstance()`
 * result that was built with `createReplicaChallengePlugin` in its plugin
 * list and spreads the same state object back out as `challengeState` (both
 * consumers' `setup()` do this — see their module doc comments). `auth` is
 * typed `any`, matching the `TestAuth` alias both consuming files already
 * use for the same reason: the real type varies with the plugin list passed
 * to `getTestInstance` and isn't worth narrowing for a handful of
 * `auth.api.*` calls.
 */
export interface ReplicaChallengeHarness {
	auth: any;
	challengeState: ReplicaChallengeState;
}

/**
 * Stage `userId` for the replica endpoint and invoke it, returning the
 * signed `two_factor` cookie fragment it minted — i.e. a bridge-created
 * challenge, indistinguishable on the wire from one `auth.ts` creates for a
 * real magic-link or OAuth sign-in.
 */
export async function startReplicaChallenge(
	instance: ReplicaChallengeHarness,
	userId: string,
): Promise<string> {
	instance.challengeState.userId = userId;
	const res = await instance.auth.api.createReplicaTwoFactorChallenge({
		returnHeaders: true,
	});
	return extractCookie(res.headers, "two_factor");
}
