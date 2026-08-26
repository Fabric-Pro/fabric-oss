/**
 * Behavioral (black-box) suite for the account-level 2FA lockout, driven
 * against better-auth's own public test harness (`better-auth/test`'s
 * `getTestInstance`, an in-memory `node:sqlite` instance with a real
 * request/response cycle running in-process) — never `better-auth/dist/**`.
 *
 * Every scenario is built around `auth.api.*` (the same public server
 * surface `packages/auth/auth.ts` uses) plus one direct adapter write
 * (assertion 5, simulating a lock that has already expired). No test
 * asserts a version string; these pin BEHAVIOR, which is what a
 * better-auth upgrade could silently change.
 *
 * `twoFactor()` here is configured with the same `TWO_FACTOR_ACCOUNT_LOCKOUT`
 * constant `createTwoFactorPlugin()` (../two-factor-policy.ts) uses in
 * production — see two-factor-lockout-policy.test.ts for the contract pin
 * that keeps the two in sync. `skipVerificationOnEnable` and
 * `otpOptions.sendOTP` are test-only setup conveniences (they let a test
 * enable 2FA and drive the OTP factor without a real authenticator app or
 * email channel); production `auth.ts` sets neither.
 *
 * KEY MECHANIC — two independent, non-overlapping attempt budgets:
 *   - PER-CHALLENGE (better-auth's existing `beginAttempt(5)`, wired via
 *     packages/auth/lib/two-factor-challenge.ts): caps comparisons on a
 *     single sign-in challenge (one `two_factor` cookie) at 5; the 6th
 *     request on the same challenge throws
 *     TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE without ever reaching the
 *     account-level counter.
 *   - PER-ACCOUNT (this consolidation's target, `assertTwoFactorNotLocked`
 *     / `recordTwoFactorFailure`): caps *consecutive* failures across ALL
 *     challenges and factors at `maxFailedAttempts` (10), and is checked
 *     BEFORE the per-challenge budget on every verify request.
 * Because of the first budget, reaching 10 account-level failures requires
 * spreading them across at least two fresh challenges (fresh sign-in ⇒
 * fresh `two_factor` cookie ⇒ fresh per-challenge budget).
 *
 * The "bridge-created challenges" describe block below joins this account
 * lockout to `createTwoFactorChallenge()` (../two-factor-challenge.ts) — the
 * hand-rolled replica `auth.ts` uses to gate magic-link and OAuth sign-ins,
 * paths the `twoFactor()` plugin's own `hooks.after` matcher doesn't cover.
 * two-factor-challenge-contract.test.ts already proves a bridge-created
 * challenge is structurally identical to a native one and exhausts the
 * PER-CHALLENGE budget the same way, but its instance carries no
 * `accountLockout` option, so it can never exercise the ACCOUNT-level lock
 * this file pins. The tests here drive repeated wrong codes against
 * bridge-created challenges (via the same `createReplicaChallengePlugin`
 * test plugin the contract suite uses, shared through
 * ./two-factor-test-helpers) until the account locks, proving the lock
 * protects that path too — not just native sign-in.
 *
 * Run with: pnpm --filter @repo/auth test lib/__tests__/two-factor-lockout-behavior.test.ts
 */

import { APIError } from "better-auth/api";
import { symmetricDecrypt } from "better-auth/crypto";
import { twoFactor } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { describe, expect, it } from "vitest";
import { TWO_FACTOR_ACCOUNT_LOCKOUT } from "../two-factor-policy";
import {
	createReplicaChallengePlugin,
	expectAPIErrorCode,
	extractCookie,
	startReplicaChallenge,
	WRONG_TOTP_CODE,
} from "./two-factor-test-helpers";

interface TwoFactorRow {
	id: string;
	userId: string;
	failedVerificationCount: number;
	lockedUntil: Date | null;
}

async function verifyTOTPWrong(auth: TestAuth, cookie: string) {
	return auth.api
		.verifyTOTP({
			body: { code: WRONG_TOTP_CODE },
			headers: new Headers({ cookie }),
		})
		.catch((e: unknown) => e);
}

// The instance type varies with the plugin list passed to getTestInstance;
// narrowing it fully isn't worth it here, so the handful of `auth.api.*`
// calls this file makes are typed loosely via this alias.
type TestAuth = any;

/**
 * The challenge lifetime the replica endpoint mints its `two_factor` cookie
 * with. Matches `auth.ts`'s own `const maxAgeSeconds = 3 * 60` (see
 * ../two-factor-challenge.ts's doc comment) — no assertion below depends on
 * the exact value, but there's no reason to test against an unrealistic one.
 */
const BRIDGE_CHALLENGE_MAX_AGE_SECONDS = 3 * 60;

/**
 * The lock duration the assertions below expect, derived from the same
 * policy constant `setup()` feeds the test instance so the two can't drift.
 * The raw value itself is pinned by two-factor-lockout-policy.test.ts.
 * better-auth types `durationSeconds` as optional, so narrow it once here.
 */
const LOCKOUT_DURATION_SECONDS = TWO_FACTOR_ACCOUNT_LOCKOUT.durationSeconds;
if (LOCKOUT_DURATION_SECONDS === undefined) {
	throw new Error("test setup error: lockout duration must be configured");
}
const LOCKOUT_DURATION_MS = LOCKOUT_DURATION_SECONDS * 1000;

/**
 * Build a fresh in-memory better-auth instance with the account-lockout
 * policy wired the same way production does, plus an OTP send stub so the
 * OTP factor is testable without a real email channel, plus the
 * replica-challenge test plugin so bridge-created challenges (the
 * magic-link/OAuth path) can be driven the same way native sign-in
 * challenges are below.
 */
async function setup() {
	const otpSent: { code?: string } = {};
	const challengeState: { userId?: string } = {};
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
			createReplicaChallengePlugin(
				challengeState,
				BRIDGE_CHALLENGE_MAX_AGE_SECONDS,
			),
		],
	});
	return { ...instance, otpSent, challengeState };
}

/**
 * Enable 2FA (password-authenticated) for the instance's default test
 * user. Returns the user's id, the plaintext TOTP secret, plaintext backup
 * codes (from the enable response), and two challenge starters: one for a
 * native sign-in challenge (the plugin's own `hooks.after` hook), one for a
 * bridge-created challenge (the replica endpoint driving
 * `createTwoFactorChallenge` — the magic-link/OAuth path).
 *
 * The TOTP secret is decrypted from the stored `twoFactor` record the same
 * way two-factor-challenge-contract.test.ts does: `auth.api.generateTOTP`
 * derives its code from the raw secret, not from the base32 copy in the
 * enable response's `totpURI`, so recovering it needs better-auth's own
 * `symmetricDecrypt` and the context's `secretConfig` — how the plugin
 * itself recovers it.
 */
async function enableTwoFactorForTestUser(
	instance: Awaited<ReturnType<typeof setup>>,
) {
	const auth = instance.auth as TestAuth;
	const { testUser } = instance;

	const signIn = await auth.api.signInEmail({
		body: { email: testUser.email, password: testUser.password },
		returnHeaders: true,
	});
	const userId: string = signIn.response.user.id;
	const sessionCookie = extractCookie(signIn.headers, "session_token");

	const enabled = await auth.api.enableTwoFactor({
		body: { password: testUser.password },
		headers: new Headers({ cookie: sessionCookie }),
	});

	const twoFactorRow = await instance.db.findOne<{ secret: string }>({
		model: "twoFactor",
		where: [{ field: "userId", value: userId }],
	});
	if (!twoFactorRow) {
		throw new Error(`No twoFactor row for user ${userId}`);
	}
	const authCtx = await auth.$context;
	const totpSecret = await symmetricDecrypt({
		key: authCtx.secretConfig,
		data: twoFactorRow.secret,
	});

	async function startChallenge(): Promise<string> {
		const res = await auth.api.signInEmail({
			body: { email: testUser.email, password: testUser.password },
			returnHeaders: true,
		});
		return extractCookie(res.headers, "two_factor");
	}

	async function startBridgeChallenge(): Promise<string> {
		return startReplicaChallenge(instance, userId);
	}

	return {
		userId,
		totpSecret,
		backupCodes: enabled.backupCodes as string[],
		startChallenge,
		startBridgeChallenge,
	};
}

async function findTwoFactorRow(
	instance: Awaited<ReturnType<typeof setup>>,
	userId: string,
): Promise<TwoFactorRow> {
	const row = await instance.db.findOne<TwoFactorRow>({
		model: "twoFactor",
		where: [{ field: "userId", value: userId }],
	});
	if (!row) {
		throw new Error(`No twoFactor row for user ${userId}`);
	}
	return row;
}

describe("account-level 2FA lockout — behavioral", () => {
	it("counts 9 consecutive failures across 2 challenges without locking, then locks on the 10th and rejects a subsequent verify on every endpoint (backup code, TOTP, OTP) while locked", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { userId, backupCodes, startChallenge } =
			await enableTwoFactorForTestUser(instance);

		// Challenge A: 5 failed TOTP comparisons — this challenge's own
		// per-attempt budget (beginAttempt(5)) is now fully spent.
		const challengeA = await startChallenge();
		for (let i = 0; i < 5; i++) {
			expectAPIErrorCode(
				await verifyTOTPWrong(auth, challengeA),
				"INVALID_CODE",
			);
		}
		expect(
			(await findTwoFactorRow(instance, userId)).failedVerificationCount,
		).toBe(5);

		// Challenge B (fresh): 4 more failures — 9 total, still not locked.
		const challengeB = await startChallenge();
		for (let i = 0; i < 4; i++) {
			expectAPIErrorCode(
				await verifyTOTPWrong(auth, challengeB),
				"INVALID_CODE",
			);
		}
		const rowAtNine = await findTwoFactorRow(instance, userId);
		expect(rowAtNine.failedVerificationCount).toBe(9);
		expect(rowAtNine.lockedUntil).toBeNull();

		// 10th failure, still on challenge B (its per-challenge budget has
		// room for one more: 4 comparisons used so far, cap is 5).
		expectAPIErrorCode(
			await verifyTOTPWrong(auth, challengeB),
			"INVALID_CODE",
		);
		const rowAtTen = await findTwoFactorRow(instance, userId);
		expect(rowAtTen.failedVerificationCount).toBe(10);
		expect(rowAtTen.lockedUntil).not.toBeNull();
		const lockedUntil = rowAtTen.lockedUntil as Date;
		const expectedUnlock = Date.now() + LOCKOUT_DURATION_MS;
		expect(Math.abs(lockedUntil.getTime() - expectedUnlock)).toBeLessThan(
			5_000,
		);

		// A subsequent request with a VALID code (a real, unused backup
		// code) is still rejected — the account-level lock check
		// (assertTwoFactorNotLocked) runs before the code is ever compared,
		// on every verify endpoint, so a locked account can't be unlocked by
		// guessing right.
		const validCodeAttempt = await auth.api
			.verifyBackupCode({
				body: { code: backupCodes[0] },
				headers: new Headers({ cookie: challengeB }),
			})
			.catch((e: unknown) => e);
		expect(validCodeAttempt).toBeInstanceOf(APIError);
		expect((validCodeAttempt as APIError).status).toBe("TOO_MANY_REQUESTS");
		expectAPIErrorCode(validCodeAttempt, "ACCOUNT_TEMPORARILY_LOCKED");

		// The same lock gate (assertTwoFactorNotLocked) runs before the code
		// comparison on EVERY verify endpoint, not just backup codes — a
		// future better-auth upgrade could drop it from TOTP or OTP alone
		// while keeping this file's other assertions passing, so each gets
		// its own proof here. Each uses a FRESH challenge so the per-challenge
		// attempt budget (beginAttempt(5)) can never be the reason for the
		// rejection instead of the account lock.

		// TOTP: even a wrong code is rejected specifically as
		// ACCOUNT_TEMPORARILY_LOCKED (not INVALID_CODE, and not the
		// per-challenge TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE) — proving the
		// lock check precedes the code comparison on this endpoint too.
		const challengeC = await startChallenge();
		const lockedTotpAttempt = await auth.api
			.verifyTOTP({
				body: { code: WRONG_TOTP_CODE },
				headers: new Headers({ cookie: challengeC }),
			})
			.catch((e: unknown) => e);
		expectAPIErrorCode(lockedTotpAttempt, "ACCOUNT_TEMPORARILY_LOCKED");

		// OTP: even the REAL current code (captured from the sendOTP stub)
		// is rejected — proving a genuinely correct credential doesn't
		// bypass the lock.
		const challengeD = await startChallenge();
		await auth.api.sendTwoFactorOTP({
			headers: new Headers({ cookie: challengeD }),
		});
		const realOtpCode = instance.otpSent.code;
		expect(realOtpCode).toBeTruthy();
		const lockedOtpAttempt = await auth.api
			.verifyTwoFactorOTP({
				body: { code: realOtpCode },
				headers: new Headers({ cookie: challengeD }),
			})
			.catch((e: unknown) => e);
		expectAPIErrorCode(lockedOtpAttempt, "ACCOUNT_TEMPORARILY_LOCKED");
	});

	it("below threshold: one failure then a success resets the count to 0 and clears lockedUntil", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { userId, backupCodes, startChallenge } =
			await enableTwoFactorForTestUser(instance);

		const challenge = await startChallenge();
		expectAPIErrorCode(
			await verifyTOTPWrong(auth, challenge),
			"INVALID_CODE",
		);
		expect(
			(await findTwoFactorRow(instance, userId)).failedVerificationCount,
		).toBe(1);

		const success = await auth.api.verifyBackupCode({
			body: { code: backupCodes[0] },
			headers: new Headers({ cookie: challenge }),
		});
		expect(success.token).toBeTruthy();

		const rowAfterSuccess = await findTwoFactorRow(instance, userId);
		expect(rowAfterSuccess.failedVerificationCount).toBe(0);
		expect(rowAfterSuccess.lockedUntil).toBeNull();
	});

	it("an already-locked account with lockedUntil in the past auto-clears on the next verify and a valid sign-in succeeds", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { userId, backupCodes, startChallenge } =
			await enableTwoFactorForTestUser(instance);

		// Simulate an expired lock via a direct adapter write, per the spec
		// ("moved into the past (direct adapter write)") — this is the
		// state a real account would be in 15+ minutes after locking.
		const row = await findTwoFactorRow(instance, userId);
		await instance.db.update({
			model: "twoFactor",
			where: [{ field: "id", value: row.id }],
			update: {
				failedVerificationCount: 10,
				lockedUntil: new Date(Date.now() - 60_000),
			},
		});
		const rowBefore = await findTwoFactorRow(instance, userId);
		expect(rowBefore.lockedUntil).not.toBeNull();
		expect((rowBefore.lockedUntil as Date).getTime()).toBeLessThan(
			Date.now(),
		);

		const challenge = await startChallenge();
		const success = await auth.api.verifyBackupCode({
			body: { code: backupCodes[0] },
			headers: new Headers({ cookie: challenge }),
		});
		expect(success.token).toBeTruthy();

		const rowAfter = await findTwoFactorRow(instance, userId);
		expect(rowAfter.failedVerificationCount).toBe(0);
		expect(rowAfter.lockedUntil).toBeNull();
	});

	it("TOTP, backup-code, and OTP failures all increment the same account counter; an absent OTP record does not count", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { userId, startChallenge } =
			await enableTwoFactorForTestUser(instance);

		const challenge = await startChallenge();

		// 1: invalid TOTP comparison.
		expectAPIErrorCode(
			await verifyTOTPWrong(auth, challenge),
			"INVALID_CODE",
		);
		expect(
			(await findTwoFactorRow(instance, userId)).failedVerificationCount,
		).toBe(1);

		// 2: invalid backup-code comparison — same account counter.
		const backupFail = await auth.api
			.verifyBackupCode({
				body: { code: "not-a-real-backup-code" },
				headers: new Headers({ cookie: challenge }),
			})
			.catch((e: unknown) => e);
		expectAPIErrorCode(backupFail, "INVALID_BACKUP_CODE");
		expect(
			(await findTwoFactorRow(instance, userId)).failedVerificationCount,
		).toBe(2);

		// An OTP verify with no record on file (send-otp was never called for
		// this challenge) must NOT count toward the account lockout — the OTP
		// path still looks up the account and checks lockedUntil first, but
		// then fails consuming the (nonexistent) OTP record before it ever
		// reaches a factor comparison, so recordTwoFactorFailure is never
		// called.
		const otpAbsent = await auth.api
			.verifyTwoFactorOTP({
				body: { code: "000000" },
				headers: new Headers({ cookie: challenge }),
			})
			.catch((e: unknown) => e);
		expectAPIErrorCode(otpAbsent, "OTP_HAS_EXPIRED");
		expect(
			(await findTwoFactorRow(instance, userId)).failedVerificationCount,
		).toBe(2);

		// 3: a real OTP record, then a wrong code — same account counter.
		await auth.api.sendTwoFactorOTP({
			headers: new Headers({ cookie: challenge }),
		});
		expect(instance.otpSent.code).toBeTruthy();
		const wrongOtp =
			instance.otpSent.code === "000000" ? "111111" : "000000";
		const otpFail = await auth.api
			.verifyTwoFactorOTP({
				body: { code: wrongOtp },
				headers: new Headers({ cookie: challenge }),
			})
			.catch((e: unknown) => e);
		expectAPIErrorCode(otpFail, "INVALID_CODE");
		expect(
			(await findTwoFactorRow(instance, userId)).failedVerificationCount,
		).toBe(3);
	});

	it("concurrent failures across distinct challenges lose no increments and the account ends locked", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { userId, startChallenge } =
			await enableTwoFactorForTestUser(instance);

		// One fresh challenge PER request, so the only contention under
		// concurrency is the account-level counter (incrementOne) — not
		// better-auth's separate, non-atomic per-challenge attempt budget
		// (consume-then-recreate), which is not what this test targets.
		const cookies = await Promise.all(
			Array.from({ length: 12 }, () => startChallenge()),
		);

		const results = await Promise.allSettled(
			cookies.map((cookie) =>
				auth.api.verifyTOTP({
					body: { code: WRONG_TOTP_CODE },
					headers: new Headers({ cookie }),
				}),
			),
		);

		// Every request must fail one way or another (they're all wrong
		// codes on fresh challenges never resubmitted).
		const rejected = results.filter(
			(r): r is PromiseRejectedResult => r.status === "rejected",
		);
		expect(rejected).toHaveLength(12);

		const invalidCodeCount = rejected.filter(
			(r) => (r.reason as APIError).body?.code === "INVALID_CODE",
		).length;
		const lockedCount = rejected.filter(
			(r) =>
				(r.reason as APIError).body?.code ===
				"ACCOUNT_TEMPORARILY_LOCKED",
		).length;
		// Every rejection must be attributable to one of these two codes —
		// there is no per-challenge contention in this setup (one fresh
		// challenge per request) to produce TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE.
		expect(invalidCodeCount + lockedCount).toBe(12);

		const finalRow = await findTwoFactorRow(instance, userId);
		expect(finalRow.lockedUntil).not.toBeNull();
		// incrementOne loses no updates — natively atomic (one SQL UPDATE)
		// on the production Prisma adapter; on this harness the emulated
		// fallback runs serialized on in-process SQLite: the final
		// count equals exactly the number of comparisons that actually ran
		// (invalidCodeCount) — not the number of requests sent, and not
		// less than that either. Per better-auth's own lock-check ordering,
		// a request already past assertTwoFactorNotLocked when the 10th
		// failure lands will still complete its comparison and its own
		// recordTwoFactorFailure — there is no atomic "reservation" against
		// the threshold — so this count is legitimately allowed to exceed
		// 10 (bounded above by the 12 requests sent).
		expect(finalRow.failedVerificationCount).toBe(invalidCodeCount);
		expect(finalRow.failedVerificationCount).toBeGreaterThanOrEqual(10);
		expect(finalRow.failedVerificationCount).toBeLessThanOrEqual(12);
	});
});

describe("bridge-created challenges (magic-link/OAuth path)", () => {
	it("counts 9 consecutive failures across 2 bridge challenges without locking, then locks on the 10th and rejects a fresh bridge challenge's genuinely correct TOTP code and a valid backup code while locked", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { userId, totpSecret, backupCodes, startBridgeChallenge } =
			await enableTwoFactorForTestUser(instance);

		// Bridge challenge A: 5 failed TOTP comparisons, created through the
		// replica endpoint (createTwoFactorChallenge) — exactly the path
		// auth.ts uses to gate a magic-link or OAuth sign-in, never through
		// native email sign-in. This challenge's own per-attempt budget
		// (beginAttempt(5)) is now fully spent.
		const bridgeChallengeA = await startBridgeChallenge();
		for (let i = 0; i < 5; i++) {
			expectAPIErrorCode(
				await verifyTOTPWrong(auth, bridgeChallengeA),
				"INVALID_CODE",
			);
		}
		expect(
			(await findTwoFactorRow(instance, userId)).failedVerificationCount,
		).toBe(5);

		// Bridge challenge B (fresh): 4 more failures — 9 total, still not
		// locked. The account-level counter accumulates across bridge
		// challenges exactly like it does across native ones (see the native
		// version of this assertion above).
		const bridgeChallengeB = await startBridgeChallenge();
		for (let i = 0; i < 4; i++) {
			expectAPIErrorCode(
				await verifyTOTPWrong(auth, bridgeChallengeB),
				"INVALID_CODE",
			);
		}
		const rowAtNine = await findTwoFactorRow(instance, userId);
		expect(rowAtNine.failedVerificationCount).toBe(9);
		expect(rowAtNine.lockedUntil).toBeNull();

		// 10th failure, still on bridge challenge B (its per-challenge budget
		// has room for one more: 4 comparisons used so far, cap is 5).
		expectAPIErrorCode(
			await verifyTOTPWrong(auth, bridgeChallengeB),
			"INVALID_CODE",
		);
		const rowAtTen = await findTwoFactorRow(instance, userId);
		expect(rowAtTen.failedVerificationCount).toBe(10);
		expect(rowAtTen.lockedUntil).not.toBeNull();
		const lockedUntil = rowAtTen.lockedUntil as Date;
		const expectedUnlock = Date.now() + LOCKOUT_DURATION_MS;
		expect(Math.abs(lockedUntil.getTime() - expectedUnlock)).toBeLessThan(
			5_000,
		);

		// The joining assertion: a FRESH bridge challenge is still rejected by
		// the account lock, even with the user's genuinely correct TOTP code.
		// A fresh challenge has a fully unspent per-challenge budget, so this
		// is the black-box proof that bridge-created challenges are protected
		// by the account-level gate itself — not merely by their own
		// per-challenge cap, which this challenge hasn't come close to
		// spending.
		const bridgeChallengeC = await startBridgeChallenge();
		const { code } = await auth.api.generateTOTP({
			body: { secret: totpSecret },
		});
		const lockedCorrectTotpAttempt = await auth.api
			.verifyTOTP({
				body: { code },
				headers: new Headers({ cookie: bridgeChallengeC }),
			})
			.catch((e: unknown) => e);
		expectAPIErrorCode(
			lockedCorrectTotpAttempt,
			"ACCOUNT_TEMPORARILY_LOCKED",
		);

		// Same proof again with a valid backup code on another fresh bridge
		// challenge, so the lock's precedence over the code comparison isn't
		// specific to the TOTP endpoint.
		const bridgeChallengeD = await startBridgeChallenge();
		const lockedBackupCodeAttempt = await auth.api
			.verifyBackupCode({
				body: { code: backupCodes[0] },
				headers: new Headers({ cookie: bridgeChallengeD }),
			})
			.catch((e: unknown) => e);
		expectAPIErrorCode(
			lockedBackupCodeAttempt,
			"ACCOUNT_TEMPORARILY_LOCKED",
		);
	});

	it("shares the account failure counter with native sign-in challenges: 5 bridge failures plus 5 native failures locks the account", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { userId, startChallenge, startBridgeChallenge } =
			await enableTwoFactorForTestUser(instance);

		// 5 failures on a bridge challenge.
		const bridgeChallenge = await startBridgeChallenge();
		for (let i = 0; i < 5; i++) {
			expectAPIErrorCode(
				await verifyTOTPWrong(auth, bridgeChallenge),
				"INVALID_CODE",
			);
		}
		expect(
			(await findTwoFactorRow(instance, userId)).failedVerificationCount,
		).toBe(5);

		// 4 more failures on a native sign-in challenge — still not locked,
		// same account counter regardless of which path created the challenge.
		const nativeChallenge = await startChallenge();
		for (let i = 0; i < 4; i++) {
			expectAPIErrorCode(
				await verifyTOTPWrong(auth, nativeChallenge),
				"INVALID_CODE",
			);
		}
		const rowAtNine = await findTwoFactorRow(instance, userId);
		expect(rowAtNine.failedVerificationCount).toBe(9);
		expect(rowAtNine.lockedUntil).toBeNull();

		// The 10th failure, still on that native challenge (its per-challenge
		// budget has room: 4 of 5 used), locks the account — proving the two
		// paths feed one shared counter, not two independent ones.
		expectAPIErrorCode(
			await verifyTOTPWrong(auth, nativeChallenge),
			"INVALID_CODE",
		);
		const rowAtTen = await findTwoFactorRow(instance, userId);
		expect(rowAtTen.failedVerificationCount).toBe(10);
		expect(rowAtTen.lockedUntil).not.toBeNull();
	});
});
