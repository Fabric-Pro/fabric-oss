/**
 * Drift guard for the step-up 2FA lockout (../two-factor-step-up-lockout.ts).
 *
 * The repo-side hook exists ONLY because Better Auth gates its own
 * account-level lockout on `isSignIn`, leaving an authenticated caller with no
 * budget at all. Three upstream facts carry that design, and each fails
 * silently rather than loudly if it changes — a renamed error code just stops
 * the counting, and an upstream fix just leaves us running a redundant second
 * counter. So each is pinned behaviorally here:
 *
 *  1. Better Auth still applies NO account lockout to a session-present
 *     verify. When this fails, the fix has landed upstream and the repo-side
 *     hook should be retired rather than kept alongside it.
 *  2. The wrong-code rejections still carry the exact codes the failure
 *     allowlist matches on.
 *  3. Better Auth's own lockout rejection still has the status and body this
 *     module reproduces, so a step-up lock is indistinguishable from a sign-in
 *     one to `isTwoFactorAccountLockedError()` and to the client's error map.
 *
 * Asserted against the PUBLIC surface (`auth.api.*` through
 * `better-auth/test`), never `better-auth/dist/**` and never a version string.
 *
 * Run with: pnpm --filter @repo/auth test lib/__tests__/two-factor-step-up-lockout-drift.test.ts
 */

import type { APIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { describe, expect, it } from "vitest";
import {
	isTwoFactorAccountLockedError,
	TWO_FACTOR_ACCOUNT_LOCKOUT,
} from "../two-factor-policy";
import {
	ACCOUNT_TEMPORARILY_LOCKED_MESSAGE,
	STEP_UP_FAILURE_CODES,
	STEP_UP_MAX_FAILED_ATTEMPTS,
} from "../two-factor-step-up-lockout";
import {
	enrollTwoFactorAndAuthenticate,
	expectAPIErrorCode,
	WRONG_TOTP_CODE,
	wrongOTPCode,
} from "./two-factor-test-helpers";

type TestAuth = any;

const THRESHOLD = STEP_UP_MAX_FAILED_ATTEMPTS;

/** A bare instance with NO repo hooks — this pins upstream, not our code. */
async function setupUpstreamOnly() {
	const otpSent: { code?: string } = {};
	const instance = await getTestInstance({
		plugins: [
			twoFactor({
				accountLockout: TWO_FACTOR_ACCOUNT_LOCKOUT,
				skipVerificationOnEnable: true,
				otpOptions: {
					sendOTP: async ({ otp }: { otp: string }) => {
						otpSent.code = otp;
					},
				},
			}),
		],
	});
	return { ...instance, otpSent };
}

describe("better-auth 2FA lockout drift", () => {
	it("still applies NO account lockout to session-present verifies on ANY factor — retire the repo-side hook when this fails", async () => {
		const instance = await setupUpstreamOnly();
		const auth = instance.auth as TestAuth;
		const { userId, sessionCookie } =
			await enrollTwoFactorAndAuthenticate(instance);
		const headers = () => new Headers({ cookie: sessionCookie });

		// Each factor is gated on `isSignIn` at its own call site upstream, so
		// each is exercised separately: a fix that lands on one but not the others
		// must still fire this guard.

		// TOTP — well past the account threshold, and past the per-challenge
		// budget of 5 that a sign-in submission would have spent.
		for (let attempt = 0; attempt < THRESHOLD + 2; attempt++) {
			expectAPIErrorCode(
				await auth.api
					.verifyTOTP({
						body: { code: WRONG_TOTP_CODE },
						headers: headers(),
					})
					.catch((e: unknown) => e),
				"INVALID_CODE",
			);
		}

		// Backup codes.
		for (let attempt = 0; attempt < THRESHOLD + 2; attempt++) {
			expectAPIErrorCode(
				await auth.api
					.verifyBackupCode({
						body: { code: "aaaaa-bbbbb" },
						headers: headers(),
					})
					.catch((e: unknown) => e),
				"INVALID_BACKUP_CODE",
			);
		}

		// OTP, through real delivery. Its per-code budget of 5 is the one limit
		// that DOES apply while authenticated, so the code is re-sent to get past
		// it — which is exactly why it is not an account-level cap.
		//
		// Asserted on the outcome SET rather than a single code: a re-send appends
		// another record under the same identifier rather than replacing the
		// previous one (`otp/index.mjs:78-82`), so a given verify may consume
		// either and may legitimately answer INVALID_CODE or the per-code
		// TOO_MANY_ATTEMPTS. What this guard claims — and what must never
		// change — is that neither is ever the ACCOUNT-level lockout.
		const deliveredOTPs: string[] = [];
		for (let round = 0; round < 3; round++) {
			await auth.api.sendTwoFactorOTP({ body: {}, headers: headers() });
			deliveredOTPs.push(instance.otpSent.code as string);
			// Derived from every code delivered so far, since a re-send leaves the
			// earlier record in play and any of them may be the one consumed.
			const wrong = wrongOTPCode(...deliveredOTPs);
			for (let attempt = 0; attempt < 5; attempt++) {
				const error = await auth.api
					.verifyTwoFactorOTP({
						body: { code: wrong },
						headers: headers(),
					})
					.catch((e: unknown) => e);
				expect(isTwoFactorAccountLockedError(error)).toBe(false);
				expect([
					"INVALID_CODE",
					"TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
				]).toContain(
					(error as { body?: { code?: string } })?.body?.code,
				);
			}
		}

		// No account-level lock was engaged by any of the failures above — the
		// counters upstream would have moved are untouched.
		const row = await instance.db.findOne<{
			failedVerificationCount: number;
			lockedUntil: Date | null;
		}>({
			model: "twoFactor",
			where: [{ field: "userId", value: userId }],
		});
		expect(row?.failedVerificationCount).toBe(0);
		expect(row?.lockedUntil ?? null).toBeNull();
	});

	it("still rejects a wrong code with the exact codes the failure allowlist matches", async () => {
		const instance = await setupUpstreamOnly();
		const auth = instance.auth as TestAuth;
		const { sessionCookie } =
			await enrollTwoFactorAndAuthenticate(instance);

		expectAPIErrorCode(
			await auth.api
				.verifyTOTP({
					body: { code: WRONG_TOTP_CODE },
					headers: new Headers({ cookie: sessionCookie }),
				})
				.catch((e: unknown) => e),
			STEP_UP_FAILURE_CODES["/two-factor/verify-totp"],
		);

		expectAPIErrorCode(
			await auth.api
				.verifyBackupCode({
					body: { code: "not-a-real-backup-code" },
					headers: new Headers({ cookie: sessionCookie }),
				})
				.catch((e: unknown) => e),
			STEP_UP_FAILURE_CODES["/two-factor/verify-backup-code"],
		);

		// One fresh delivery, one wrong comparison: without this the OTP entry in
		// the allowlist would be pinned by nothing, since the guard above accepts
		// the per-code TOO_MANY_ATTEMPTS as well.
		await auth.api.sendTwoFactorOTP({
			body: {},
			headers: new Headers({ cookie: sessionCookie }),
		});
		expectAPIErrorCode(
			await auth.api
				.verifyTwoFactorOTP({
					body: { code: wrongOTPCode(instance.otpSent.code) },
					headers: new Headers({ cookie: sessionCookie }),
				})
				.catch((e: unknown) => e),
			STEP_UP_FAILURE_CODES["/two-factor/verify-otp"],
		);
	});

	it("pins the failure allowlist to one code per verifying endpoint", () => {
		expect(STEP_UP_FAILURE_CODES).toEqual({
			"/two-factor/verify-totp": "INVALID_CODE",
			"/two-factor/verify-backup-code": "INVALID_BACKUP_CODE",
			"/two-factor/verify-otp": "INVALID_CODE",
		});
	});

	it("still rejects a locked sign-in with the status and body this module reproduces", async () => {
		const instance = await setupUpstreamOnly();
		const auth = instance.auth as TestAuth;
		const { startChallenge } =
			await enrollTwoFactorAndAuthenticate(instance);

		// Spend the account budget across fresh challenges: each challenge's own
		// budget caps it at 5 comparisons, so reaching 10 needs more than one.
		let locked: unknown;
		for (let round = 0; round < 4 && !locked; round++) {
			const cookie = await startChallenge();
			for (let attempt = 0; attempt < 5; attempt++) {
				const error = await auth.api
					.verifyTOTP({
						body: { code: WRONG_TOTP_CODE },
						headers: new Headers({ cookie }),
					})
					.catch((e: unknown) => e);
				if (isTwoFactorAccountLockedError(error)) {
					locked = error;
					break;
				}
			}
		}

		expect(locked).toBeDefined();
		const error = locked as APIError;
		expect(error.status).toBe("TOO_MANY_REQUESTS");
		expect(error.body?.code).toBe("ACCOUNT_TEMPORARILY_LOCKED");
		// The message this module throws for a step-up lock is upstream's, so
		// the two are indistinguishable on the wire.
		expect(error.body?.message).toBe(ACCOUNT_TEMPORARILY_LOCKED_MESSAGE);
	});
});
