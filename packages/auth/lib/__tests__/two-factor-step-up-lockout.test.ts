/**
 * Behavioral (black-box) suite for the STEP-UP 2FA lockout
 * (../two-factor-step-up-lockout.ts, issue #2819), driven against Better
 * Auth's own public test harness (`better-auth/test`'s `getTestInstance`, an
 * in-memory `node:sqlite` instance running a real request/response cycle
 * in-process) — never `better-auth/dist/**`.
 *
 * The hooks under test are mounted exactly as `../../auth.ts` mounts them, so
 * these exercise the real dispatch semantics the design depends on: that a
 * before-hook throw skips `hooks.after`, and that `ctx.context.returned`
 * carries the endpoint's APIError. The store is the in-memory implementation
 * below rather than Prisma — the harness has no Prisma client — so the
 * PRISMA QUERY SHAPES that carry the atomicity contract are asserted
 * separately in two-factor-step-up-lockout-store.test.ts.
 *
 * KEY DISTINCTION from two-factor-lockout-behavior.test.ts, which covers the
 * SIGN-IN lockout: that budget is Better Auth's own and lives on
 * `failedVerificationCount`/`lockedUntil`. This one is the repo's, lives on
 * `stepUpFailedCount`/`stepUpLockedUntil`, and applies only when the caller
 * already holds a session. The two are asserted here to be independent.
 *
 * Run with: pnpm --filter @repo/auth test lib/__tests__/two-factor-step-up-lockout.test.ts
 */

import type { BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { beforeEach, describe, expect, it } from "vitest";
import { TWO_FACTOR_ACCOUNT_LOCKOUT } from "../two-factor-policy";
import {
	enforceStepUpLockout,
	recordStepUpVerificationOutcome,
	STEP_UP_LOCK_DURATION_MS,
	STEP_UP_MAX_FAILED_ATTEMPTS,
	type StepUpLockoutRow,
	type StepUpLockoutStore,
} from "../two-factor-step-up-lockout";
import {
	currentTOTPFor,
	enrollTwoFactorAndAuthenticate,
	expectAPIErrorCode,
	WRONG_TOTP_CODE,
	wrongOTPCode,
} from "./two-factor-test-helpers";

// The instance type varies with the plugin list passed to getTestInstance;
// narrowing it fully isn't worth it here, so the `auth.api.*` calls this file
// makes are typed loosely via this alias.
type TestAuth = any;

const THRESHOLD = STEP_UP_MAX_FAILED_ATTEMPTS;
const LOCK_MS = STEP_UP_LOCK_DURATION_MS;

interface MemoryRow extends StepUpLockoutRow {
	userId: string;
}

/**
 * In-memory store with the same guard semantics as the Prisma one: the
 * conditional clear, the conditional lock, and the conditional reset all
 * re-check their predicate at write time, so a test that interleaves them
 * observes the same outcomes production would.
 */
function createMemoryStore() {
	const rows = new Map<string, MemoryRow>();
	let failOn:
		| "increment"
		| "reset"
		| "lock"
		| "restore"
		| "all-writes"
		| null = null;
	const writesFail = () => failOn === "all-writes";
	let replaceAfterRead: string | null = null;
	let resetAfterRead: string | null = null;
	let restoreGate: Promise<void> | null = null;
	let releaseRestoreGate: (() => void) | null = null;

	let nextRowSeq = 0;
	function insertRow(userId: string): MemoryRow {
		nextRowSeq += 1;
		const row: MemoryRow = {
			id: `step-up-${userId}-${nextRowSeq}`,
			userId,
			stepUpFailedCount: 0,
			stepUpLockedUntil: null,
			stepUpEpoch: 0,
			// Inert here: the lockout hooks only pass this through to the
			// after-hook consumers documented on StepUpLockoutRow, none of which
			// this suite mounts. The management step-up suite exercises it
			// against the real enrolment row instead.
			verified: true,
		};
		rows.set(row.id, row);
		return row;
	}

	const store: StepUpLockoutStore = {
		async findRowByUserId(userId) {
			for (const row of rows.values()) {
				if (row.userId === userId) {
					const snapshot = { ...row };
					if (replaceAfterRead === row.id) {
						replaceAfterRead = null;
						rows.delete(row.id);
						insertRow(userId);
					}
					if (resetAfterRead === row.id) {
						resetAfterRead = null;
						row.stepUpFailedCount = 0;
						row.stepUpLockedUntil = null;
						row.stepUpEpoch += 1;
					}
					return snapshot;
				}
			}
			return null;
		},
		async clearExpiredLock(rowId, now) {
			const row = rows.get(rowId);
			if (
				row?.stepUpLockedUntil &&
				row.stepUpLockedUntil.getTime() <= now.getTime()
			) {
				row.stepUpFailedCount = 0;
				row.stepUpLockedUntil = null;
				row.stepUpEpoch += 1;
			}
		},
		async incrementFailure(rowId) {
			if (failOn === "increment" || writesFail()) {
				throw new Error("store unavailable");
			}
			const row = rows.get(rowId);
			if (!row) {
				return null;
			}
			row.stepUpFailedCount += 1;
			return { count: row.stepUpFailedCount, epoch: row.stepUpEpoch };
		},
		async restoreReservation(rowId, epoch) {
			if (restoreGate) {
				await restoreGate;
			}
			if (failOn === "restore" || writesFail()) {
				throw new Error("store unavailable");
			}
			const row = rows.get(rowId);
			if (row && row.stepUpEpoch === epoch && row.stepUpFailedCount > 0) {
				row.stepUpFailedCount -= 1;
			}
		},
		async lockConditionally(rowId, threshold, lockedUntil) {
			if (failOn === "lock" || writesFail()) {
				throw new Error("store unavailable");
			}
			const row = rows.get(rowId);
			if (
				!row ||
				row.stepUpFailedCount < threshold ||
				row.stepUpLockedUntil !== null
			) {
				return false;
			}
			row.stepUpLockedUntil = lockedUntil;
			return true;
		},
		async resetOnSuccess(rowId) {
			if (failOn === "reset" || writesFail()) {
				throw new Error("store unavailable");
			}
			const row = rows.get(rowId);
			if (row && (row.stepUpFailedCount > 0 || row.stepUpLockedUntil)) {
				row.stepUpFailedCount = 0;
				row.stepUpLockedUntil = null;
				row.stepUpEpoch += 1;
			}
		},
	};

	return {
		store,
		seedRow: insertRow,
		dropRow(rowId: string) {
			rows.delete(rowId);
		},
		/** Swap the row for a fresh one the moment the before hook reads it. */
		replaceRowAfterNextRead(rowId: string) {
			replaceAfterRead = rowId;
		},
		/**
		 * Clear the row's budget the moment the before hook reads it, so the read
		 * returns a stale over-threshold snapshot while the guarded lock write
		 * that follows matches nothing — the concurrent-success race.
		 */
		resetRowAfterNextRead(rowId: string) {
			resetAfterRead = rowId;
		},
		read(rowId: string): MemoryRow {
			const row = rows.get(rowId);
			if (!row) {
				throw new Error(`No step-up row ${rowId}`);
			}
			return row;
		},
		findByUserId(userId: string): MemoryRow {
			for (const row of rows.values()) {
				if (row.userId === userId) {
					return row;
				}
			}
			throw new Error(`No step-up row for user ${userId}`);
		},
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
		failNext(
			mode:
				| "increment"
				| "reset"
				| "lock"
				| "restore"
				| "all-writes"
				| null,
		) {
			failOn = mode;
		},
	};
}

/**
 * A database whose SESSION READS can be made to fail on demand, so the
 * fail-closed path can be exercised through the REAL session resolution rather
 * than through an injected stub. Better Auth's test harness spreads caller
 * options after its own defaults, so passing `database` replaces its SQLite.
 */
function createFaultableDatabase() {
	// The memory adapter resolves a model by looking its key up directly, so
	// every table this instance touches has to exist before the first query.
	const data: Record<string, Record<string, unknown>[]> = {
		user: [],
		session: [],
		account: [],
		verification: [],
		twoFactor: [],
		rateLimit: [],
	};
	const base = memoryAdapter(data);
	let failSessionReads = false;

	const database = (options: BetterAuthOptions) => {
		const adapter = base(options);
		return new Proxy(adapter, {
			get(target, prop, receiver) {
				const value = Reflect.get(target, prop, receiver);
				if (typeof value !== "function") {
					return value;
				}
				return (...args: unknown[]) => {
					const model = (args[0] as { model?: string } | undefined)
						?.model;
					if (
						failSessionReads &&
						model === "session" &&
						(prop === "findOne" || prop === "findMany")
					) {
						throw new Error("session store unavailable");
					}
					return (value as (...a: unknown[]) => unknown).apply(
						target,
						args,
					);
				};
			},
		});
	};

	return {
		database,
		setFailSessionReads(fail: boolean) {
			failSessionReads = fail;
		},
	};
}

/**
 * Poll until `predicate` holds. Requests interleave inside `Promise.all`, so an
 * earlier one can finish — and give its reservation back — before a later one
 * has even reserved; waiting on the observable state is what makes the
 * concurrency scenarios deterministic rather than timing-dependent.
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

let clock = new Date("2026-08-16T12:00:00.000Z");

function advance(ms: number) {
	clock = new Date(clock.getTime() + ms);
}

/**
 * Build a Better Auth instance with the step-up hooks mounted the way
 * ../../auth.ts mounts them. `skipVerificationOnEnable` and `sendOTP` are
 * test-only conveniences: they let a test enable 2FA and drive the OTP factor
 * without an authenticator app or an email channel.
 */
async function setup(options?: {
	skipVerificationOnEnable?: boolean;
	resolveSession?: () => Promise<never>;
	database?: ReturnType<typeof createFaultableDatabase>["database"];
}) {
	const memory = createMemoryStore();
	const otpSent: { code?: string } = {};
	const deps = {
		store: memory.store,
		now: () => clock,
		...(options?.resolveSession
			? { resolveSession: options.resolveSession }
			: {}),
	};

	const instance = await getTestInstance({
		...(options?.database ? { database: options.database } : {}),
		plugins: [
			twoFactor({
				accountLockout: TWO_FACTOR_ACCOUNT_LOCKOUT,
				skipVerificationOnEnable:
					options?.skipVerificationOnEnable ?? true,
				otpOptions: {
					sendOTP: async ({ otp }: { otp: string }) => {
						otpSent.code = otp;
					},
				},
			}),
		],
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				await enforceStepUpLockout(ctx, deps);
			}),
			after: createAuthMiddleware(async (ctx) => {
				await recordStepUpVerificationOutcome(ctx, deps);
			}),
		},
	});

	return { ...instance, memory, otpSent };
}

/**
 * Shared enrolment (see ./two-factor-test-helpers), plus the step-up row this
 * suite's in-memory store holds the budget on.
 */
async function enrollAndAuthenticate(
	instance: Awaited<ReturnType<typeof setup>>,
) {
	const enrolled = await enrollTwoFactorAndAuthenticate(instance);
	return { ...enrolled, row: instance.memory.seedRow(enrolled.userId) };
}

/** Drive verify-totp over the real HTTP path, to assert on status codes. */
function postVerifyTOTP(auth: TestAuth, cookie: string, code: string) {
	return auth.handler(
		new Request("http://localhost:3000/api/auth/two-factor/verify-totp", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:3000",
				cookie,
			},
			body: JSON.stringify({ code }),
		}),
	) as Promise<Response>;
}

function stepUpTOTPWrong(auth: TestAuth, cookie: string) {
	return auth.api
		.verifyTOTP({
			body: { code: WRONG_TOTP_CODE },
			headers: new Headers({ cookie }),
		})
		.catch((e: unknown) => e);
}

function stepUpBackupCode(auth: TestAuth, cookie: string, code: string) {
	return auth.api
		.verifyBackupCode({
			body: { code },
			headers: new Headers({ cookie }),
		})
		.catch((e: unknown) => e);
}

beforeEach(() => {
	clock = new Date("2026-08-16T12:00:00.000Z");
});

describe("step-up 2FA lockout — behavioral", () => {
	it("counts consecutive failed step-up TOTP verifies and locks on the threshold, then refuses further verifies on every factor", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, backupCodes, row } =
			await enrollAndAuthenticate(instance);

		for (let attempt = 1; attempt < THRESHOLD; attempt++) {
			const error = await stepUpTOTPWrong(auth, sessionCookie);
			expectAPIErrorCode(error, "INVALID_CODE");
			expect(instance.memory.read(row.id).stepUpFailedCount).toBe(
				attempt,
			);
			expect(instance.memory.read(row.id).stepUpLockedUntil).toBeNull();
		}

		// The threshold failure still reports the wrong code — the lock it
		// writes takes effect on the NEXT request, not this one.
		expectAPIErrorCode(
			await stepUpTOTPWrong(auth, sessionCookie),
			"INVALID_CODE",
		);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(THRESHOLD);
		expect(instance.memory.read(row.id).stepUpLockedUntil).toEqual(
			new Date(clock.getTime() + LOCK_MS),
		);

		// Locked: refused before the comparison, on every verifying endpoint —
		// including with a genuinely valid backup code.
		expectAPIErrorCode(
			await stepUpTOTPWrong(auth, sessionCookie),
			"ACCOUNT_TEMPORARILY_LOCKED",
		);
		expectAPIErrorCode(
			await stepUpBackupCode(auth, sessionCookie, backupCodes[0]),
			"ACCOUNT_TEMPORARILY_LOCKED",
		);
		expectAPIErrorCode(
			await auth.api
				.verifyTwoFactorOTP({
					body: { code: wrongOTPCode(instance.otpSent.code) },
					headers: new Headers({ cookie: sessionCookie }),
				})
				.catch((e: unknown) => e),
			"ACCOUNT_TEMPORARILY_LOCKED",
		);

		// Refused before the comparison means the budget did not move either.
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(THRESHOLD);
	});

	it("resets the count on a successful step-up verification, so failures must be consecutive to lock", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, backupCodes, row } =
			await enrollAndAuthenticate(instance);

		for (let attempt = 0; attempt < THRESHOLD - 1; attempt++) {
			await stepUpTOTPWrong(auth, sessionCookie);
		}
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(
			THRESHOLD - 1,
		);

		const success = await stepUpBackupCode(
			auth,
			sessionCookie,
			backupCodes[0],
		);
		expect(success).not.toBeInstanceOf(Error);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(0);

		// The budget genuinely restarted: another full run short of the
		// threshold still does not lock.
		for (let attempt = 0; attempt < THRESHOLD - 1; attempt++) {
			await stepUpTOTPWrong(auth, sessionCookie);
		}
		expect(instance.memory.read(row.id).stepUpLockedUntil).toBeNull();
	});

	it("counts a successful OTP step-up as a success and resets the budget", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, row } = await enrollAndAuthenticate(instance);

		await stepUpTOTPWrong(auth, sessionCookie);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(1);

		await auth.api.sendTwoFactorOTP({
			body: {},
			headers: new Headers({ cookie: sessionCookie }),
		});
		const sent = instance.otpSent.code as string;
		expect(sent).toBeTruthy();

		const success = await auth.api.verifyTwoFactorOTP({
			body: { code: sent },
			headers: new Headers({ cookie: sessionCookie }),
		});
		expect(success).toBeTruthy();
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(0);
	});

	it("allows verification again once the lock elapses, and restarts the count from that attempt rather than re-locking instantly", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, row } = await enrollAndAuthenticate(instance);

		for (let attempt = 0; attempt < THRESHOLD; attempt++) {
			await stepUpTOTPWrong(auth, sessionCookie);
		}
		expect(instance.memory.read(row.id).stepUpLockedUntil).not.toBeNull();

		advance(LOCK_MS + 1000);

		// Admitted (reaches the comparison, so the code is what is rejected)…
		expectAPIErrorCode(
			await stepUpTOTPWrong(auth, sessionCookie),
			"INVALID_CODE",
		);
		// …and the elapsed lock was cleared WITH the count, so this failure is
		// the first of a fresh budget rather than the threshold-th of the old.
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(1);
		expect(instance.memory.read(row.id).stepUpLockedUntil).toBeNull();
	});

	it("leaves the sign-in challenge budget alone, and is not touched by it", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { userId, row, startChallenge } =
			await enrollAndAuthenticate(instance);

		// A sign-in challenge failure: no session, so Better Auth's own counter
		// owns it and the step-up counter must not move.
		const twoFactorCookie = await startChallenge();
		await auth.api
			.verifyTOTP({
				body: { code: WRONG_TOTP_CODE },
				headers: new Headers({ cookie: twoFactorCookie }),
			})
			.catch(() => undefined);

		const betterAuthRow = await instance.db.findOne<{
			failedVerificationCount: number;
		}>({
			model: "twoFactor",
			where: [{ field: "userId", value: userId }],
		});
		expect(betterAuthRow?.failedVerificationCount).toBe(1);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(0);
	});

	it("ignores rejections that are not a wrong code, and never treats them as a success", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, row } = await enrollAndAuthenticate(instance);

		await stepUpTOTPWrong(auth, sessionCookie);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(1);

		// No OTP was ever sent for this session, so the endpoint rejects before
		// any comparison. Neither counted nor treated as a success.
		expectAPIErrorCode(
			await auth.api
				.verifyTwoFactorOTP({
					body: { code: wrongOTPCode(instance.otpSent.code) },
					headers: new Headers({ cookie: sessionCookie }),
				})
				.catch((e: unknown) => e),
			"OTP_HAS_EXPIRED",
		);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(1);

		// A body that fails validation is rejected before the handler runs.
		await auth.api
			.verifyTOTP({
				body: {} as { code: string },
				headers: new Headers({ cookie: sessionCookie }),
			})
			.catch(() => undefined);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(1);
	});

	it("counts failures during enrolment, when the row exists but is not yet verified", async () => {
		// Production shape: Better Auth marks the row verified only after the
		// first successful verify, so enrolment runs against verified=false.
		const instance = await setup({ skipVerificationOnEnable: false });
		const auth = instance.auth as TestAuth;
		const { sessionCookie, row } = await enrollAndAuthenticate(instance);

		expectAPIErrorCode(
			await stepUpTOTPWrong(auth, sessionCookie),
			"INVALID_CODE",
		);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(1);
	});

	it("does nothing when the account has no step-up row", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, row } = await enrollAndAuthenticate(instance);

		instance.memory.dropRow(row.id);

		// Still reaches the comparison and fails on the code, with no counter to
		// move and no crash.
		expectAPIErrorCode(
			await stepUpTOTPWrong(auth, sessionCookie),
			"INVALID_CODE",
		);
	});

	it("stops counting rather than charging a replacement row when the row is replaced mid-request", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, row, userId } =
			await enrollAndAuthenticate(instance);

		// Simulates disable + re-enable landing between the before hook (which
		// read the old row) and the after hook (which scores the outcome).
		instance.memory.replaceRowAfterNextRead(row.id);

		expectAPIErrorCode(
			await stepUpTOTPWrong(auth, sessionCookie),
			"INVALID_CODE",
		);

		// The failure is dropped rather than charged to the new row: that row
		// belongs to a factor this request never challenged.
		const replacement = instance.memory.findByUserId(userId);
		expect(replacement.id).not.toBe(row.id);
		expect(replacement.stepUpFailedCount).toBe(0);
	});

	it("fails closed when the reservation cannot be written, before any comparison", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, row } = await enrollAndAuthenticate(instance);

		instance.memory.failNext("increment");
		const res = await postVerifyTOTP(auth, sessionCookie, WRONG_TOTP_CODE);
		instance.memory.failNext(null);

		// Pinned to the store failure specifically: asserting merely "an Error"
		// would also be satisfied by the ordinary INVALID_CODE rejection, which
		// is the outcome this test exists to rule out.
		expect(res.status).toBe(500);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(0);
	});

	it("still returns the success to the caller when the store cannot record the reset", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, backupCodes } =
			await enrollAndAuthenticate(instance);

		instance.memory.failNext("reset");
		// The backup code is already spent by the time the reset runs, so the
		// success must stand.
		const result = await stepUpBackupCode(
			auth,
			sessionCookie,
			backupCodes[0],
		);
		expect(result).not.toBeInstanceOf(Error);
		instance.memory.failNext(null);
	});

	it("enforces the lock over the real HTTP path, not just direct auth.api calls", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, row } = await enrollAndAuthenticate(instance);

		const post = (code: string) =>
			postVerifyTOTP(auth, sessionCookie, code);

		for (let attempt = 0; attempt < THRESHOLD; attempt++) {
			const res = await post(WRONG_TOTP_CODE);
			expect(res.status).toBe(401);
		}
		expect(instance.memory.read(row.id).stepUpLockedUntil).not.toBeNull();

		const locked = await post(WRONG_TOTP_CODE);
		expect(locked.status).toBe(429);
		expect((await locked.json()).code).toBe("ACCOUNT_TEMPORARILY_LOCKED");
	});

	it("fails closed when the session cannot be resolved, rather than treating the caller as anonymous", async () => {
		// Better Auth's own getSessionFromCtx turns a resolution failure into
		// null, which would read here as "sign-in challenge" — the gate and the
		// counter would both be skipped while the endpoint's own resolution still
		// succeeded, yielding an attempt that is neither limited nor recorded.
		const instance = await setup({
			resolveSession: async () => {
				throw new Error("session store unavailable");
			},
		});
		const auth = instance.auth as TestAuth;
		const { sessionCookie, row } = await enrollAndAuthenticate(instance);

		const res = await auth.handler(
			new Request(
				"http://localhost:3000/api/auth/two-factor/verify-totp",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "http://localhost:3000",
						cookie: sessionCookie,
					},
					body: JSON.stringify({ code: WRONG_TOTP_CODE }),
				},
			),
		);

		// 500, not the endpoint's own 401: the request never reached the
		// comparison, so no guess was spent and none was silently admitted.
		expect(res.status).toBe(500);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(0);
	});

	it("fails closed on a real session-lookup failure, using the production resolver", async () => {
		// The sibling test above injects a throwing resolver, which pins the seam
		// but would still pass if `.catch(() => null)` were reintroduced INSIDE
		// resolveSessionOrThrow. This one uses DEFAULT deps and faults the actual
		// session read, so it fails if the production resolver ever swallows.
		const faultable = createFaultableDatabase();
		const instance = await setup({ database: faultable.database });
		const auth = instance.auth as TestAuth;
		const { sessionCookie, row } = await enrollAndAuthenticate(instance);

		faultable.setFailSessionReads(true);
		const res = await auth.handler(
			new Request(
				"http://localhost:3000/api/auth/two-factor/verify-totp",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "http://localhost:3000",
						cookie: sessionCookie,
					},
					body: JSON.stringify({ code: WRONG_TOTP_CODE }),
				},
			),
		);
		faultable.setFailSessionReads(false);

		// 500, not the endpoint's 401: the request never reached the comparison.
		expect(res.status).toBe(500);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(0);

		// And the same request succeeds once the store recovers, proving the 500
		// came from the fault rather than from a broken setup.
		expectAPIErrorCode(
			await stepUpTOTPWrong(auth, sessionCookie),
			"INVALID_CODE",
		);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(1);
	});

	it("resets enrolment-time failures when a real TOTP completes enrolment", async () => {
		// Complements the OTP-driven enrolment test: only /two-factor/verify-totp
		// takes the `verified !== true` branch that flips the row to verified and
		// rotates the session (`totp/index.mjs:158-176`).
		const instance = await setup({ skipVerificationOnEnable: false });
		const auth = instance.auth as TestAuth;
		const { userId, sessionCookie, row } =
			await enrollAndAuthenticate(instance);

		for (let attempt = 0; attempt < 3; attempt++) {
			expectAPIErrorCode(
				await stepUpTOTPWrong(auth, sessionCookie),
				"INVALID_CODE",
			);
		}
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(3);

		const completed = await auth.api.verifyTOTP({
			body: { code: await currentTOTPFor(instance, userId) },
			headers: new Headers({ cookie: sessionCookie }),
		});
		expect(completed).toBeTruthy();
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(0);

		// The enrolment transition really did happen on this path.
		const verified = await instance.db.findOne<{ verified: boolean }>({
			model: "twoFactor",
			where: [{ field: "userId", value: userId }],
		});
		expect(verified?.verified).toBe(true);
	});

	it("rejects the next attempt after a threshold transition was stranded by a failed lock write", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, row } = await enrollAndAuthenticate(instance);

		for (let attempt = 0; attempt < THRESHOLD - 1; attempt++) {
			await stepUpTOTPWrong(auth, sessionCookie);
		}

		// The threshold attempt reserves the last of the budget, then the after
		// hook's lock write fails: the row is stranded AT the threshold with no
		// lock standing, and the request 500s.
		instance.memory.failNext("lock");
		const stranded = await postVerifyTOTP(
			auth,
			sessionCookie,
			WRONG_TOTP_CODE,
		);
		instance.memory.failNext(null);
		expect(stranded.status).toBe(500);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(THRESHOLD);
		expect(instance.memory.read(row.id).stepUpLockedUntil).toBeNull();

		// The next request must still be refused. Its reservation takes the count
		// past the threshold, which both establishes the lock and rejects.
		expectAPIErrorCode(
			await stepUpTOTPWrong(auth, sessionCookie),
			"ACCOUNT_TEMPORARILY_LOCKED",
		);
		expect(instance.memory.read(row.id).stepUpLockedUntil).not.toBeNull();
	});

	it("lets a concurrent success win over a stranded threshold rather than locking on stale state", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, backupCodes, row } =
			await enrollAndAuthenticate(instance);

		// Stranded ABOVE the threshold with no lock, which is what the repair
		// branch keys on — a count sitting exactly AT it is just a reservation
		// still in flight.
		instance.memory.read(row.id).stepUpFailedCount = THRESHOLD + 1;

		// A success commits between the before hook's read and its repair write:
		// the read still shows the stranded count, but the guarded write then
		// matches nothing. The re-read must settle it in favour of the success.
		instance.memory.resetRowAfterNextRead(row.id);

		const success = await stepUpBackupCode(
			auth,
			sessionCookie,
			backupCodes[0],
		);
		expect(success).not.toBeInstanceOf(Error);
		expect(instance.memory.read(row.id).stepUpLockedUntil).toBeNull();
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(0);
	});

	it("reaches the threshold on backup codes alone", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, backupCodes, row } =
			await enrollAndAuthenticate(instance);

		for (let attempt = 0; attempt < THRESHOLD; attempt++) {
			expectAPIErrorCode(
				await stepUpBackupCode(auth, sessionCookie, "aaaaa-bbbbb"),
				"INVALID_BACKUP_CODE",
			);
		}
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(THRESHOLD);

		expectAPIErrorCode(
			await stepUpBackupCode(auth, sessionCookie, backupCodes[0]),
			"ACCOUNT_TEMPORARILY_LOCKED",
		);
	});

	it("counts OTP failures into the same account budget, and refuses OTP once that budget is spent", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, row } = await enrollAndAuthenticate(instance);
		const headers = () => new Headers({ cookie: sessionCookie });

		await auth.api.sendTwoFactorOTP({ body: {}, headers: headers() });
		const wrong = wrongOTPCode(instance.otpSent.code);
		const verifyOTPWrong = () =>
			auth.api
				.verifyTwoFactorOTP({
					body: { code: wrong },
					headers: headers(),
				})
				.catch((e: unknown) => e);

		// Four, not ten: the OTP record's own budget is 5 per issued code, and
		// re-sending to get past it does NOT replace the previous record — it
		// appends another under the same identifier (`otp/index.mjs:78-82`), so
		// which one a later verify consumes is unspecified. That the account
		// budget cannot be driven through one code is the point: the per-code
		// counter is not an account-level cap.
		for (let attempt = 1; attempt <= 4; attempt++) {
			expectAPIErrorCode(await verifyOTPWrong(), "INVALID_CODE");
			expect(instance.memory.read(row.id).stepUpFailedCount).toBe(
				attempt,
			);
		}

		// The remainder of the shared budget is spent on another factor.
		for (let attempt = 0; attempt < THRESHOLD - 4; attempt++) {
			await stepUpTOTPWrong(auth, sessionCookie);
		}
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(THRESHOLD);

		// A freshly delivered, genuinely valid OTP is now refused before any
		// comparison: the cap is per account, not per factor or per code.
		await auth.api.sendTwoFactorOTP({ body: {}, headers: headers() });
		expectAPIErrorCode(
			await auth.api
				.verifyTwoFactorOTP({
					body: { code: instance.otpSent.code as string },
					headers: headers(),
				})
				.catch((e: unknown) => e),
			"ACCOUNT_TEMPORARILY_LOCKED",
		);
	});

	it("does not count an exhausted OTP budget or a missing enrolment as failures", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { userId, sessionCookie, row } =
			await enrollAndAuthenticate(instance);

		await auth.api.sendTwoFactorOTP({
			body: {},
			headers: new Headers({ cookie: sessionCookie }),
		});
		const wrong = wrongOTPCode(instance.otpSent.code);
		for (let attempt = 0; attempt < 5; attempt++) {
			await auth.api
				.verifyTwoFactorOTP({
					body: { code: wrong },
					headers: new Headers({ cookie: sessionCookie }),
				})
				.catch(() => undefined);
		}
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(5);

		// The 6th spends the OTP record's own budget instead of comparing.
		expectAPIErrorCode(
			await auth.api
				.verifyTwoFactorOTP({
					body: { code: wrong },
					headers: new Headers({ cookie: sessionCookie }),
				})
				.catch((e: unknown) => e),
			"TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
		);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(5);

		// TOTP_NOT_ENABLED likewise rejects before any comparison.
		await instance.db.delete({
			model: "twoFactor",
			where: [{ field: "userId", value: userId }],
		});
		expectAPIErrorCode(
			await stepUpTOTPWrong(auth, sessionCookie),
			"TOTP_NOT_ENABLED",
		);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(5);
	});

	it("resets enrolment-time failures when the enrolment verification finally succeeds", async () => {
		const instance = await setup({ skipVerificationOnEnable: false });
		const auth = instance.auth as TestAuth;
		const { sessionCookie, row } = await enrollAndAuthenticate(instance);

		for (let attempt = 0; attempt < 3; attempt++) {
			await stepUpTOTPWrong(auth, sessionCookie);
		}
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(3);

		await auth.api.sendTwoFactorOTP({
			body: {},
			headers: new Headers({ cookie: sessionCookie }),
		});
		// Completes enrolment: the endpoint flips twoFactorEnabled and returns the
		// success shape, so the budget must clear.
		const completed = await auth.api.verifyTwoFactorOTP({
			body: { code: instance.otpSent.code as string },
			headers: new Headers({ cookie: sessionCookie }),
		});
		expect(completed).toBeTruthy();
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(0);
	});

	it("admits no more than the budget under a concurrent burst", async () => {
		// The bypass the reservation ordering exists to close: with the increment
		// landing after the comparison, every request in a burst reads a count
		// below the threshold and every one of them gets compared.
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, row } = await enrollAndAuthenticate(instance);

		const BURST = 30;
		const responses = await Promise.all(
			Array.from({ length: BURST }, () =>
				postVerifyTOTP(auth, sessionCookie, WRONG_TOTP_CODE),
			),
		);
		const statuses = responses.map((res) => res.status);
		const compared = statuses.filter((status) => status === 401).length;
		const refused = statuses.filter((status) => status === 429).length;

		// Deterministic even on a burst: admission is decided by the value the
		// atomic increment returns, not by a read that others can race.
		expect(compared).toBe(THRESHOLD);
		expect(refused).toBe(BURST - THRESHOLD);
		expect(instance.memory.read(row.id).stepUpLockedUntil).not.toBeNull();
	});

	it("gives no oracle when the store can be read but not written", async () => {
		// Reads succeeding while writes fail is the shape that would otherwise
		// leave a working oracle: the comparison happens, so a wrong guess errors
		// after the fact while a correct one still succeeds, and no budget is ever
		// spent. The reservation write precedes the comparison, so both 500.
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, backupCodes, row } =
			await enrollAndAuthenticate(instance);

		instance.memory.failNext("all-writes");

		expect(
			(await postVerifyTOTP(auth, sessionCookie, WRONG_TOTP_CODE)).status,
		).toBe(500);

		// The same 500 for a CORRECT code — no signal separates the two.
		const correct = await stepUpBackupCode(
			auth,
			sessionCookie,
			backupCodes[0],
		);
		expect(correct).toBeInstanceOf(Error);
		expect(correct).not.toHaveProperty("body.code", "INVALID_BACKUP_CODE");

		instance.memory.failNext(null);

		// Proof no comparison happened: the backup code was never consumed, so it
		// still works now that the store is healthy.
		const later = await stepUpBackupCode(
			auth,
			sessionCookie,
			backupCodes[0],
		);
		expect(later).not.toBeInstanceOf(Error);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(0);
	});

	it("gives the reservation back for outcomes that never reached a comparison", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, row } = await enrollAndAuthenticate(instance);

		// One genuine wrong code, so the durable count is a known non-zero value.
		await stepUpTOTPWrong(auth, sessionCookie);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(1);

		// No OTP was issued, so this rejects before comparing: reserve, restore.
		expectAPIErrorCode(
			await auth.api
				.verifyTwoFactorOTP({
					body: { code: wrongOTPCode() },
					headers: new Headers({ cookie: sessionCookie }),
				})
				.catch((e: unknown) => e),
			"OTP_HAS_EXPIRED",
		);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(1);

		// A body that fails validation inside the endpoint still passes THROUGH
		// the before hook, so it too reserves and must be given back.
		await auth.api
			.verifyTOTP({
				body: {} as { code: string },
				headers: new Headers({ cookie: sessionCookie }),
			})
			.catch(() => undefined);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(1);

		// Net zero over many non-comparison outcomes: the budget is untouched, so
		// the account is still nine genuine wrong codes away from locking.
		for (let attempt = 0; attempt < 5; attempt++) {
			await auth.api
				.verifyTOTP({
					body: {} as { code: string },
					headers: new Headers({ cookie: sessionCookie }),
				})
				.catch(() => undefined);
		}
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(1);
		expect(instance.memory.read(row.id).stepUpLockedUntil).toBeNull();
	});

	it("discards a restore that arrives after a reset, instead of refunding a failure counted since", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, backupCodes, row } =
			await enrollAndAuthenticate(instance);

		// (1) A restorable request reserves (0 -> 1) and is held in flight, just
		// before it would give the reservation back.
		instance.memory.pauseRestores();
		const inFlight = auth.api
			.verifyTwoFactorOTP({
				body: { code: wrongOTPCode() },
				headers: new Headers({ cookie: sessionCookie }),
			})
			.catch((e: unknown) => e);
		await waitFor(
			() => instance.memory.read(row.id).stepUpFailedCount === 1,
			"the in-flight request to reserve",
		);

		// (2) A successful verification resets the budget — a reset boundary.
		const success = await stepUpBackupCode(
			auth,
			sessionCookie,
			backupCodes[0],
		);
		expect(success).not.toBeInstanceOf(Error);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(0);

		// (3) A GENUINE wrong code reserves against the fresh budget. This one
		// must stand.
		expectAPIErrorCode(
			await stepUpTOTPWrong(auth, sessionCookie),
			"INVALID_CODE",
		);
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(1);

		// (4) Only now does the held restore land. Without the epoch guard it
		// would decrement 1 -> 0 and erase the genuine failure from step 3.
		instance.memory.releaseRestores();
		expectAPIErrorCode(await inFlight, "OTP_HAS_EXPIRED");

		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(1);
	});

	it("self-heals a lock established by a burst of non-comparison requests", async () => {
		// The accepted consequence of writing the lock before the comparison:
		// enough concurrent restorable requests can establish it without a single
		// failed comparison. It must not be permanent.
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, row } = await enrollAndAuthenticate(instance);

		// Restores are held so all of the burst is genuinely in flight at once —
		// otherwise an early request gives its reservation back before a later one
		// reserves, and the count never reaches the threshold at all.
		const BURST = THRESHOLD + 5;
		instance.memory.pauseRestores();
		const burst = Promise.all(
			Array.from({ length: BURST }, () =>
				auth.api
					.verifyTwoFactorOTP({
						body: { code: wrongOTPCode() },
						headers: new Headers({ cookie: sessionCookie }),
					})
					.catch((e: unknown) => e),
			),
		);
		await waitFor(
			() => instance.memory.read(row.id).stepUpLockedUntil !== null,
			"the burst to establish a lock",
		);
		instance.memory.releaseRestores();
		await burst;

		// The admitted requests each gave their reservation back; only the ones
		// rejected over budget kept theirs, which is what established the lock.
		// The exact residue is not pinned: once the lock lands, every later
		// request is refused BEFORE reserving, so how many got that far depends on
		// scheduling. What is invariant is that some over-budget reservations
		// stand, and never more than the burst could produce.
		const residue = instance.memory.read(row.id).stepUpFailedCount;
		expect(residue).toBeGreaterThanOrEqual(1);
		expect(residue).toBeLessThanOrEqual(BURST - THRESHOLD);
		expect(instance.memory.read(row.id).stepUpLockedUntil).not.toBeNull();
		expectAPIErrorCode(
			await stepUpTOTPWrong(auth, sessionCookie),
			"ACCOUNT_TEMPORARILY_LOCKED",
		);

		advance(LOCK_MS + 1000);

		// After expiry the clear resets everything and normal verification
		// proceeds: this attempt reaches the comparison and starts a fresh budget.
		expectAPIErrorCode(
			await stepUpTOTPWrong(auth, sessionCookie),
			"INVALID_CODE",
		);
		expect(instance.memory.read(row.id).stepUpLockedUntil).toBeNull();
		expect(instance.memory.read(row.id).stepUpFailedCount).toBe(1);
	});

	it("keeps the step-up lock and the sign-in lock from blocking each other", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, startChallenge, row } =
			await enrollAndAuthenticate(instance);

		// Lock step-up.
		for (let attempt = 0; attempt < THRESHOLD; attempt++) {
			await stepUpTOTPWrong(auth, sessionCookie);
		}
		expect(instance.memory.read(row.id).stepUpLockedUntil).not.toBeNull();

		// A sign-in challenge still reaches the comparison: separate columns, so
		// a stolen session cannot deny the victim the sign-in that revokes it.
		expectAPIErrorCode(
			await auth.api
				.verifyTOTP({
					body: { code: WRONG_TOTP_CODE },
					headers: new Headers({ cookie: await startChallenge() }),
				})
				.catch((e: unknown) => e),
			"INVALID_CODE",
		);

		// And the converse: drive Better Auth's own counter to its threshold, then
		// confirm step-up is judged only by its own state.
		const fresh = await setup();
		const freshAuth = fresh.auth as TestAuth;
		const freshEnrolled = await enrollAndAuthenticate(fresh);
		let signInLocked = false;
		for (let round = 0; round < 4 && !signInLocked; round++) {
			const cookie = await freshEnrolled.startChallenge();
			for (let attempt = 0; attempt < 5; attempt++) {
				const error = await freshAuth.api
					.verifyTOTP({
						body: { code: WRONG_TOTP_CODE },
						headers: new Headers({ cookie }),
					})
					.catch((e: unknown) => e);
				if (
					(error as { body?: { code?: string } })?.body?.code ===
					"ACCOUNT_TEMPORARILY_LOCKED"
				) {
					signInLocked = true;
					break;
				}
			}
		}
		expect(signInLocked).toBe(true);
		expectAPIErrorCode(
			await stepUpTOTPWrong(freshAuth, freshEnrolled.sessionCookie),
			"INVALID_CODE",
		);
	});
});
