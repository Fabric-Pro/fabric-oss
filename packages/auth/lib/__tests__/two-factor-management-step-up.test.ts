/**
 * Behavioral (black-box) suite for the server-enforced step-up on the 2FA
 * MANAGEMENT endpoints (../two-factor-management-step-up.ts, issue #2827),
 * driven against Better Auth's own public test harness (`better-auth/test`'s
 * `getTestInstance`, an in-memory `node:sqlite` instance running a real
 * request/response cycle in-process) — never `better-auth/dist/**`.
 *
 * Both hook pairs are mounted exactly as `../../auth.ts` mounts them, in the
 * same order, so these exercise the real dispatch semantics the design depends
 * on: that a before-hook throw skips `hooks.after`, that `ctx.context.returned`
 * carries the endpoint's APIError, and that a cookie set in `hooks.after`
 * reaches the response headers.
 *
 * THE STORES ARE DOUBLES, for the same reason as the step-up lockout suite: the
 * harness has no Prisma client. They are not synthetic, though — both read the
 * REAL `user`, `two_factor` and `session` rows through the instance's own
 * adapter and keep only the two columns this change adds
 * (`session.twoFactorStepUpGrantedAt` and the lockout counters) in memory. So a
 * rotated session, a revoked session or a deleted enrolment row behaves here
 * exactly as it will in production. The PRISMA QUERY SHAPES that carry the
 * atomicity contract are asserted separately in
 * two-factor-management-step-up-store.test.ts.
 *
 * Run with: pnpm --filter @repo/auth test lib/__tests__/two-factor-management-step-up.test.ts
 */

import { createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	recordStepUpGrantOutcome,
	requireStepUpGrant,
	STEP_UP_GRANT_TTL_MS,
	type StepUpGrantStore,
} from "../two-factor-management-step-up";
import { TWO_FACTOR_ACCOUNT_LOCKOUT } from "../two-factor-policy";
import {
	enforceStepUpLockout,
	recordStepUpVerificationOutcome,
	type StepUpLockoutStore,
} from "../two-factor-step-up-lockout";
import {
	currentTOTPFor,
	enrollTwoFactorAndAuthenticate,
	expectAPIErrorCode,
	extractCookie,
} from "./two-factor-test-helpers";

// The instance type varies with the plugin list passed to getTestInstance;
// narrowing it fully isn't worth it for the handful of `auth.api.*` calls this
// file makes.
type TestAuth = any;

const STEP_UP_COOKIE = "two_factor_step_up";

let clock = new Date();

function advance(ms: number) {
	clock = new Date(clock.getTime() + ms);
}

/** Better Auth's adapters hand booleans back in adapter-specific shapes. */
function isTrue(value: unknown): boolean {
	return value === true || value === 1 || value === "1";
}

/**
 * Deps for both hook pairs, over the instance's own adapter.
 *
 * `db` is filled in after `getTestInstance` resolves; nothing reads it before
 * the first request, so the late binding is safe and it is what lets the stores
 * see the same rows the endpoints do.
 */
function createStores() {
	const dbRef: { db: any } = { db: null };
	/** The step-up lockout columns, which the harness's schema does not carry. */
	const lockoutState = new Map<
		string,
		{ count: number; lockedUntil: Date | null; epoch: number }
	>();
	/** `session.twoFactorStepUpGrantedAt`, likewise. */
	const grants = new Map<string, Date>();
	let restoreGate: Promise<void> | null = null;
	let releaseRestoreGate: (() => void) | null = null;
	let restoreCalls = 0;
	let lastGranted: Date | null = null;

	async function readSession(sessionId: string) {
		return (await dbRef.db.findOne({
			model: "session",
			where: [{ field: "id", value: sessionId }],
		})) as { id: string; userId: string; expiresAt: Date } | null;
	}

	const lockoutStore: StepUpLockoutStore = {
		async findRowByUserId(userId) {
			const row = (await dbRef.db.findOne({
				model: "twoFactor",
				where: [{ field: "userId", value: userId }],
			})) as { id: string; verified: unknown } | null;
			if (!row) {
				return null;
			}
			const state = lockoutState.get(row.id) ?? {
				count: 0,
				lockedUntil: null,
				epoch: 0,
			};
			lockoutState.set(row.id, state);
			return {
				id: row.id,
				stepUpFailedCount: state.count,
				stepUpLockedUntil: state.lockedUntil,
				stepUpEpoch: state.epoch,
				// The real enrolment state, read before the endpoint can flip it —
				// which is the whole point of carrying it on this row.
				verified: isTrue(row.verified),
			};
		},
		async clearExpiredLock(rowId) {
			const state = lockoutState.get(rowId);
			if (state) {
				state.count = 0;
				state.lockedUntil = null;
				state.epoch += 1;
			}
		},
		async incrementFailure(rowId) {
			const state = lockoutState.get(rowId);
			if (!state) {
				return null;
			}
			state.count += 1;
			return { count: state.count, epoch: state.epoch };
		},
		async restoreReservation(rowId, epoch) {
			const state = lockoutState.get(rowId);
			if (state && state.epoch === epoch && state.count > 0) {
				state.count -= 1;
			}
		},
		async lockConditionally() {
			return false;
		},
		async resetOnSuccess(rowId) {
			const state = lockoutState.get(rowId);
			if (state) {
				state.count = 0;
				state.lockedUntil = null;
				state.epoch += 1;
			}
		},
	};

	const grantStore: StepUpGrantStore = {
		async isTwoFactorActive(userId) {
			const user = (await dbRef.db.findOne({
				model: "user",
				where: [{ field: "id", value: userId }],
			})) as { twoFactorEnabled?: unknown } | null;
			const row = (await dbRef.db.findOne({
				model: "twoFactor",
				where: [{ field: "userId", value: userId }],
			})) as { verified?: unknown } | null;
			return isTrue(user?.twoFactorEnabled) || isTrue(row?.verified);
		},
		async grant(sessionId, userId, grantedAt) {
			const session = await readSession(sessionId);
			if (
				!session ||
				session.userId !== userId ||
				new Date(session.expiresAt).getTime() <= grantedAt.getTime()
			) {
				return false;
			}
			grants.set(sessionId, grantedAt);
			lastGranted = grantedAt;
			return true;
		},
		async consume(sessionId, userId, grantedAt, now) {
			const session = await readSession(sessionId);
			if (
				!session ||
				session.userId !== userId ||
				new Date(session.expiresAt).getTime() <= now.getTime()
			) {
				return false;
			}
			const current = grants.get(sessionId);
			if (!current || current.getTime() !== grantedAt.getTime()) {
				return false;
			}
			grants.delete(sessionId);
			return true;
		},
		async restore(sessionId, grantedAt, now) {
			restoreCalls += 1;
			if (restoreGate) {
				await restoreGate;
			}
			const session = await readSession(sessionId);
			if (
				!session ||
				new Date(session.expiresAt).getTime() <= now.getTime()
			) {
				return false;
			}
			// The still-null guard the Prisma WHERE clause carries.
			if (grants.has(sessionId)) {
				return false;
			}
			grants.set(sessionId, grantedAt);
			return true;
		},
	};

	return {
		dbRef,
		lockoutStore,
		grantStore,
		grants,
		/** How many times the after hook actually asked for a restore. */
		restoreAttempts: () => restoreCalls,
		/** The most recently minted grant timestamp. */
		lastGrantedAt: () => lastGranted,
		/** Hold every restore until releaseRestores() is called. */
		pauseRestores() {
			restoreGate = new Promise<void>((resolve) => {
				releaseRestoreGate = resolve;
			});
		},
		releaseRestores() {
			releaseRestoreGate?.();
			restoreGate = null;
			releaseRestoreGate = null;
		},
	};
}

/**
 * A Better Auth instance with BOTH hook pairs mounted the way ../../auth.ts
 * mounts them, in the same order.
 */
async function setup(options?: { skipVerificationOnEnable?: boolean }) {
	const stores = createStores();
	const lockoutDeps = { store: stores.lockoutStore, now: () => clock };
	const grantDeps = { store: stores.grantStore, now: () => clock };

	const instance = await getTestInstance({
		plugins: [
			twoFactor({
				accountLockout: TWO_FACTOR_ACCOUNT_LOCKOUT,
				skipVerificationOnEnable:
					options?.skipVerificationOnEnable ?? true,
			}),
		],
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				await enforceStepUpLockout(ctx, lockoutDeps);
				await requireStepUpGrant(ctx as never, grantDeps);
			}),
			after: createAuthMiddleware(async (ctx) => {
				await recordStepUpVerificationOutcome(ctx, lockoutDeps);
				await recordStepUpGrantOutcome(ctx as never, grantDeps);
			}),
		},
	});
	stores.dbRef.db = instance.db;

	return { ...instance, stores };
}

type Instance = Awaited<ReturnType<typeof setup>>;

/** Enrol, authenticate, and resolve the live session's id. */
async function enrolled(instance: Instance) {
	const base = await enrollTwoFactorAndAuthenticate(instance);
	const session = await (instance.auth as TestAuth).api.getSession({
		headers: new Headers({ cookie: base.sessionCookie }),
	});
	return { ...base, sessionId: session.session.id as string };
}

/**
 * Perform a step-up TOTP verification and return the grant cookie it minted.
 *
 * `returnHeaders` is what makes this meaningful: an `auth.api.*` call does not
 * apply cookies anywhere, so the response headers are the only place the minted
 * cookie can be observed — the same way the shared enrolment helper reads the
 * rotated session cookie.
 */
async function stepUpWithTOTP(
	instance: Instance,
	userId: string,
	sessionCookie: string,
): Promise<string> {
	const auth = instance.auth as TestAuth;
	const res = await auth.api.verifyTOTP({
		body: { code: await currentTOTPFor(instance, userId) },
		headers: new Headers({ cookie: sessionCookie }),
		returnHeaders: true,
	});
	return extractCookie(res.headers, STEP_UP_COOKIE);
}

function withGrant(sessionCookie: string, stepUpCookie: string): Headers {
	return new Headers({ cookie: `${sessionCookie}; ${stepUpCookie}` });
}

/** Call one of the four management endpoints by its `auth.api` method name. */
function callApi(
	auth: TestAuth,
	method: string,
	body: Record<string, unknown>,
	headers: Headers,
) {
	return auth.api[method]({ body, headers }).catch((e: unknown) => e);
}

beforeEach(() => {
	clock = new Date();
});

describe("2FA management step-up — the gate", () => {
	it.each([
		["disableTwoFactor", "/two-factor/disable"],
		["enableTwoFactor", "/two-factor/enable"],
		["generateBackupCodes", "/two-factor/generate-backup-codes"],
		["getTOTPURI", "/two-factor/get-totp-uri"],
	])(
		"refuses %s with the password alone while a verified factor exists",
		async (method) => {
			const instance = await setup();
			const auth = instance.auth as TestAuth;
			const { sessionCookie } = await enrolled(instance);

			expectAPIErrorCode(
				await callApi(
					auth,
					method,
					{ password: instance.testUser.password },
					new Headers({ cookie: sessionCookie }),
				),
				"STEP_UP_REQUIRED",
			);

			// Nothing changed: the second factor is still on.
			const session = await auth.api.getSession({
				headers: new Headers({ cookie: sessionCookie }),
			});
			expect(session.user.twoFactorEnabled).toBe(true);
		},
	);

	it("stays closed in the half-state where the flag is set but the enrolment row is gone", async () => {
		// A disable that failed after flipping the flag, or the window inside
		// /two-factor/enable between its deleteMany and its create. A row-only
		// predicate would leave /two-factor/enable open here — and enable hands
		// back backup codes that verifyBackupCode accepts without checking
		// `verified`, so that is a full bypass rather than a cosmetic gap.
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, userId } = await enrolled(instance);

		await instance.db.delete({
			model: "twoFactor",
			where: [{ field: "userId", value: userId }],
		});

		expectAPIErrorCode(
			await auth.api
				.enableTwoFactor({
					body: { password: instance.testUser.password },
					headers: new Headers({ cookie: sessionCookie }),
				})
				.catch((e: unknown) => e),
			"STEP_UP_REQUIRED",
		);
	});

	it("stays closed in the mirror half-state where a verified row exists but the flag is unset", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, userId } = await enrolled(instance);

		await instance.db.update({
			model: "user",
			where: [{ field: "id", value: userId }],
			update: { twoFactorEnabled: false },
		});

		expectAPIErrorCode(
			await auth.api
				.getTOTPURI({
					body: { password: instance.testUser.password },
					headers: new Headers({ cookie: sessionCookie }),
				})
				.catch((e: unknown) => e),
			"STEP_UP_REQUIRED",
		);
	});

	it("does not gate an account with no second factor at all", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const signIn = await auth.api.signInEmail({
			body: {
				email: instance.testUser.email,
				password: instance.testUser.password,
			},
			returnHeaders: true,
		});
		const sessionCookie = extractCookie(signIn.headers, "session_token");

		// Better Auth's own "not enabled" rejection, not ours: the request
		// reached the endpoint.
		expectAPIErrorCode(
			await auth.api
				.generateBackupCodes({
					body: { password: instance.testUser.password },
					headers: new Headers({ cookie: sessionCookie }),
				})
				.catch((e: unknown) => e),
			"TWO_FACTOR_NOT_ENABLED",
		);
	});
});

describe("2FA management step-up — spending a grant", () => {
	it("admits disable after a TOTP verification", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, userId } = await enrolled(instance);

		const stepUpCookie = await stepUpWithTOTP(
			instance,
			userId,
			sessionCookie,
		);
		const disabled = await auth.api.disableTwoFactor({
			body: { password: instance.testUser.password },
			headers: withGrant(sessionCookie, stepUpCookie),
		});
		expect(disabled.status).toBe(true);

		const row = await instance.db.findOne({
			model: "user",
			where: [{ field: "id", value: userId }],
		});
		expect(
			isTrue((row as { twoFactorEnabled?: unknown }).twoFactorEnabled),
		).toBe(false);
	});

	it("spends the grant on the first management call, so a replayed cookie is refused", async () => {
		// Driven through generate-backup-codes rather than disable: disable and
		// enable both mint a REPLACEMENT session and delete the one that
		// authorized them, so a replay through those would be refused for the
		// wrong reason (a dead session cookie) and prove nothing about
		// single-use.
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, userId } = await enrolled(instance);

		const stepUpCookie = await stepUpWithTOTP(
			instance,
			userId,
			sessionCookie,
		);
		const first = await auth.api.generateBackupCodes({
			body: { password: instance.testUser.password },
			headers: withGrant(sessionCookie, stepUpCookie),
		});
		expect(first.status).toBe(true);

		expectAPIErrorCode(
			await auth.api
				.generateBackupCodes({
					body: { password: instance.testUser.password },
					headers: withGrant(sessionCookie, stepUpCookie),
				})
				.catch((e: unknown) => e),
			"STEP_UP_REQUIRED",
		);
	});

	it("admits generate-backup-codes and get-totp-uri after a verification", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, userId } = await enrolled(instance);

		const regenerated = await auth.api.generateBackupCodes({
			body: { password: instance.testUser.password },
			headers: withGrant(
				sessionCookie,
				await stepUpWithTOTP(instance, userId, sessionCookie),
			),
		});
		expect(regenerated.backupCodes).toHaveLength(10);

		const uri = await auth.api.getTOTPURI({
			body: { password: instance.testUser.password },
			headers: withGrant(
				sessionCookie,
				await stepUpWithTOTP(instance, userId, sessionCookie),
			),
		});
		expect(uri.totpURI).toContain("otpauth://");
	});

	it("mints the grant on the backup-code path too, including with disableSession", async () => {
		// The shape check the mint keys on has to hold for the branch
		// verifyBackupCode takes when the client asks it not to touch the
		// session (`backup-codes/index.mjs:207-210`) — which is exactly what the
		// web client sends when stepping up before a disable.
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, backupCodes } = await enrolled(instance);

		const verified = await auth.api.verifyBackupCode({
			body: { code: backupCodes[0], disableSession: true },
			headers: new Headers({ cookie: sessionCookie }),
			returnHeaders: true,
		});
		const stepUpCookie = extractCookie(verified.headers, STEP_UP_COOKIE);

		const disabled = await auth.api.disableTwoFactor({
			body: { password: instance.testUser.password },
			headers: withGrant(sessionCookie, stepUpCookie),
		});
		expect(disabled.status).toBe(true);
	});

	it("refuses a grant that has aged past its TTL", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, userId } = await enrolled(instance);

		const stepUpCookie = await stepUpWithTOTP(
			instance,
			userId,
			sessionCookie,
		);
		advance(STEP_UP_GRANT_TTL_MS + 1000);

		expectAPIErrorCode(
			await auth.api
				.disableTwoFactor({
					body: { password: instance.testUser.password },
					headers: withGrant(sessionCookie, stepUpCookie),
				})
				.catch((e: unknown) => e),
			"STEP_UP_REQUIRED",
		);
	});

	it("refuses a grant minted for a different session, and mints nothing for a sign-in verification", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, userId, startChallenge } =
			await enrolled(instance);

		const stepUpCookie = await stepUpWithTOTP(
			instance,
			userId,
			sessionCookie,
		);

		// A second live session for the same user, obtained the only way a 2FA
		// account can: a full sign-in challenge.
		const challengeCookie = await startChallenge();
		const signedIn = await auth.api.verifyTOTP({
			body: { code: await currentTOTPFor(instance, userId) },
			headers: new Headers({ cookie: challengeCookie }),
			returnHeaders: true,
		});
		const otherSessionCookie = extractCookie(
			signedIn.headers,
			"session_token",
		);
		// A SIGN-IN verification proves the factor for a login; it must not also
		// hand out a management grant, or every sign-in would silently arm one.
		expect(() => extractCookie(signedIn.headers, STEP_UP_COOKIE)).toThrow();

		expectAPIErrorCode(
			await auth.api
				.disableTwoFactor({
					body: { password: instance.testUser.password },
					headers: withGrant(otherSessionCookie, stepUpCookie),
				})
				.catch((e: unknown) => e),
			"STEP_UP_REQUIRED",
		);
	});

	it("cannot spend a grant whose session has been revoked", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, userId, sessionId } = await enrolled(instance);

		const stepUpCookie = await stepUpWithTOTP(
			instance,
			userId,
			sessionCookie,
		);
		await instance.db.delete({
			model: "session",
			where: [{ field: "id", value: sessionId }],
		});

		const error = await auth.api
			.disableTwoFactor({
				body: { password: instance.testUser.password },
				headers: withGrant(sessionCookie, stepUpCookie),
			})
			.catch((e: unknown) => e);

		// Refused — the exact code is Better Auth's UNAUTHORIZED rather than
		// ours, because a revoked session never reaches the gate's own checks.
		// What matters is that the grant did not survive the revocation.
		expect(error).toBeInstanceOf(Error);
		const row = await instance.db.findOne({
			model: "user",
			where: [{ field: "id", value: userId }],
		});
		expect(
			isTrue((row as { twoFactorEnabled?: unknown }).twoFactorEnabled),
		).toBe(true);
	});

	it("refuses without spending the grant when the request carries no password", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, userId } = await enrolled(instance);

		const stepUpCookie = await stepUpWithTOTP(
			instance,
			userId,
			sessionCookie,
		);

		expectAPIErrorCode(
			await auth.api
				.disableTwoFactor({
					body: {} as { password: string },
					headers: withGrant(sessionCookie, stepUpCookie),
				})
				.catch((e: unknown) => e),
			"STEP_UP_REQUIRED",
		);

		// The malformed request cost the user nothing: the same cookie still
		// works.
		const disabled = await auth.api.disableTwoFactor({
			body: { password: instance.testUser.password },
			headers: withGrant(sessionCookie, stepUpCookie),
		});
		expect(disabled.status).toBe(true);
	});
});

describe("2FA management step-up — enrolment stays open", () => {
	it("lets a fresh enrolment run end to end without any grant", async () => {
		const instance = await setup({ skipVerificationOnEnable: false });
		const auth = instance.auth as TestAuth;
		const signIn = await auth.api.signInEmail({
			body: {
				email: instance.testUser.email,
				password: instance.testUser.password,
			},
			returnHeaders: true,
		});
		const sessionCookie = extractCookie(signIn.headers, "session_token");
		const userId = signIn.response.user.id as string;

		const enabledResponse = await auth.api.enableTwoFactor({
			body: { password: instance.testUser.password },
			headers: new Headers({ cookie: sessionCookie }),
		});
		expect(enabledResponse.totpURI).toContain("otpauth://");

		// Resuming an abandoned enrolment is still ungated: the flag is unset
		// and the row is unverified, so neither half of the predicate matches.
		await auth.api.enableTwoFactor({
			body: { password: instance.testUser.password },
			headers: new Headers({ cookie: sessionCookie }),
		});
		const uri = await auth.api.getTOTPURI({
			body: { password: instance.testUser.password },
			headers: new Headers({ cookie: sessionCookie }),
		});
		expect(uri.totpURI).toContain("otpauth://");

		const completed = await auth.api.verifyTOTP({
			body: { code: await currentTOTPFor(instance, userId) },
			headers: new Headers({ cookie: sessionCookie }),
			returnHeaders: true,
		});
		expect(completed.response.token).toBeTruthy();

		// And the enrolment-completing verification mints NO grant: it proves a
		// factor that was not yet active, and it rotates the session, so a grant
		// keyed to the old session id would be dead on arrival anyway.
		expect(() =>
			extractCookie(completed.headers, STEP_UP_COOKIE),
		).toThrow();

		// The account is now protected.
		const rotatedCookie = extractCookie(completed.headers, "session_token");
		expectAPIErrorCode(
			await auth.api
				.disableTwoFactor({
					body: { password: instance.testUser.password },
					headers: new Headers({ cookie: rotatedCookie }),
				})
				.catch((e: unknown) => e),
			"STEP_UP_REQUIRED",
		);
	});
});

describe("2FA management step-up — restoring a grant", () => {
	it("gives the grant back after a wrong password, so a typo does not cost a verification", async () => {
		// Availability, not security: in the worst case the verification spent
		// the user's LAST backup code, and a typo'd password would strand them.
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, userId } = await enrolled(instance);

		const stepUpCookie = await stepUpWithTOTP(
			instance,
			userId,
			sessionCookie,
		);
		expectAPIErrorCode(
			await auth.api
				.disableTwoFactor({
					body: { password: "not-the-password" },
					headers: withGrant(sessionCookie, stepUpCookie),
				})
				.catch((e: unknown) => e),
			"INVALID_PASSWORD",
		);

		// The retry needs no second verification, and reuses the cookie the
		// browser still holds.
		const disabled = await auth.api.disableTwoFactor({
			body: { password: instance.testUser.password },
			headers: withGrant(sessionCookie, stepUpCookie),
		});
		expect(disabled.status).toBe(true);
	});

	it("does NOT restore for a rejection outside the pre-side-effect allowlist", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, userId } = await enrolled(instance);

		const stepUpCookie = await stepUpWithTOTP(
			instance,
			userId,
			sessionCookie,
		);
		// The flag keeps the gate closed while the row is gone, so the grant is
		// spent and the endpoint then rejects with TOTP_NOT_ENABLED — a code
		// that is deliberately not on the restore allowlist.
		await instance.db.delete({
			model: "twoFactor",
			where: [{ field: "userId", value: userId }],
		});
		expectAPIErrorCode(
			await auth.api
				.getTOTPURI({
					body: { password: instance.testUser.password },
					headers: withGrant(sessionCookie, stepUpCookie),
				})
				.catch((e: unknown) => e),
			"TOTP_NOT_ENABLED",
		);

		expectAPIErrorCode(
			await auth.api
				.getTOTPURI({
					body: { password: instance.testUser.password },
					headers: withGrant(sessionCookie, stepUpCookie),
				})
				.catch((e: unknown) => e),
			"STEP_UP_REQUIRED",
		);
	});

	it("never clobbers a newer grant with a restore that lands late", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, userId, sessionId } = await enrolled(instance);

		// (1) A wrong-password call spends grant #1 and is held just before it
		// would give it back.
		const firstCookie = await stepUpWithTOTP(
			instance,
			userId,
			sessionCookie,
		);
		instance.stores.pauseRestores();
		const inFlight = auth.api
			.disableTwoFactor({
				body: { password: "not-the-password" },
				headers: withGrant(sessionCookie, firstCookie),
			})
			.catch((e: unknown) => e);
		await waitFor(
			() => !instance.stores.grants.has(sessionId),
			"the in-flight call to spend the grant",
		);

		// (2) A fresh verification mints grant #2 on the same session. The clock
		// is advanced first so the two grants carry DIFFERENT timestamps —
		// without that they would be indistinguishable and a clobber would be
		// invisible to the assertions below.
		const first = instance.stores.lastGrantedAt();
		advance(1000);
		const secondCookie = await stepUpWithTOTP(
			instance,
			userId,
			sessionCookie,
		);
		const second = instance.stores.grants.get(sessionId);
		expect(second).toBeDefined();
		expect(second).not.toEqual(first);

		// (3) Only now does the held restore land. Without the still-null guard
		// it would overwrite grant #2 with grant #1, and the cookie the client
		// just received would then fail its exact match.
		instance.stores.releaseRestores();
		expectAPIErrorCode(await inFlight, "INVALID_PASSWORD");
		expect(instance.stores.restoreAttempts()).toBe(1);
		expect(instance.stores.grants.get(sessionId)).toEqual(second);

		const disabled = await auth.api.disableTwoFactor({
			body: { password: instance.testUser.password },
			headers: withGrant(sessionCookie, secondCookie),
		});
		expect(disabled.status).toBe(true);
	});
});

/**
 * Poll until `predicate` holds. Requests interleave, so waiting on the
 * observable state is what makes the concurrency scenario deterministic rather
 * than timing-dependent.
 */
async function waitFor(predicate: () => boolean, label: string) {
	for (let attempt = 0; attempt < 2000; attempt++) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error(`Timed out waiting for ${label}`);
}
