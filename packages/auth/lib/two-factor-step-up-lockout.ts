/**
 * Per-account attempt cap for STEP-UP 2FA verification (issue #2819).
 *
 * Better Auth caps consecutive failed factor comparisons per account, but
 * every call site is gated on `isSignIn = !session.session`
 * (`better-auth/dist/plugins/two-factor/totp/index.mjs:127,137,154,157`,
 * `backup-codes/index.mjs:166,175,189,205`, `otp/index.mjs:161,164-174,183,205`).
 * A caller who already holds a session — verify-before-disable, and
 * verify-during-enrollment — therefore has NO per-account budget at all, and
 * the per-challenge `beginAttempt(5)` budget is a no-op stub on that branch
 * (`verify-two-factor.mjs:103-106`).
 *
 * Three other limiters do apply, and none of them is a per-account cap on
 * consecutive failures across requests, which is what this module adds:
 *  - the repo's per-IP bucket over `/two-factor/*`, 20 per minute
 *    (`packages/api/lib/auth-rate-limit.ts:45-49`) — per IP, so distributed
 *    guessing walks around it;
 *  - Better Auth's own request limiter over `/two-factor/*`, 3 per 10s
 *    (`two-factor/index.mjs:284-290`) — also per IP, enabled only in
 *    production, and backed by in-process memory unless `secondaryStorage` is
 *    configured (`create-context.mjs:169-174`), which this deployment does not
 *    set, so it does not hold across instances;
 *  - the OTP record's own attempt counter, 5 per issued code
 *    (`otp/index.mjs:178-180`) — the one that does apply while authenticated,
 *    but it is scoped to a single OTP and resets whenever a new one is sent,
 *    and it covers no other factor.
 *
 * STATE IS DELIBERATELY SEPARATE from the sign-in lockout's
 * `failedVerificationCount`/`lockedUntil` columns, which Better Auth owns.
 * Sharing them would hand an attacker who holds only a stolen session (no
 * password) the ability to lock the victim out of the 2FA sign-in they need
 * in order to revoke that session — an availability attack on incident
 * response that no attacker can mount today, since reaching Better Auth's
 * counter requires first passing password sign-in. Sharing would also race
 * Better Auth's own unguarded two-phase writes to those columns
 * (`verify-two-factor.mjs:151-169`).
 *
 * The numbers are shared even though the state is not: the same 10
 * consecutive failures / 15-minute lock from `./two-factor-policy.ts`.
 *
 * Wired from `../auth.ts` as a pair of hooks, because the comparison itself
 * happens inside a Better Auth endpoint this repo does not wrap.
 *
 * The budget is spent by RESERVATION, not by scoring after the fact: the before
 * hook atomically increments the counter and decides admission from the value
 * that increment returns, and the after hook either keeps the reservation (a
 * genuine wrong code) or gives it back (any outcome that never reached a
 * comparison). The same shape as upstream's per-challenge `beginAttempt`, at
 * account level. Scoring afterwards instead leaves two holes, both of which
 * this ordering closes:
 *  - a BURST bypass: N concurrent requests all read a count below the
 *    threshold and are all compared before any increment lands, so one stolen
 *    session buys far more than the budget. An atomic increment prevents lost
 *    updates but not over-admission;
 *  - a fail-open ORACLE: when reads succeed but writes fail, the comparison has
 *    already happened, so a wrong guess errors after the fact while a correct
 *    one still succeeds — guessing continues with no budget ever spent.
 *
 * The resulting semantics are "ten attempts without an intervening success or
 * restore" rather than "ten completed comparisons". Under heavy concurrent
 * mixed traffic an in-flight reservation can transiently hold the count above
 * where the durable outcomes will settle it, so the account can lock slightly
 * early. That is the safe direction, and it is deliberate.
 */

import { logger } from "@repo/logs";
import { APIError, getSession, isAPIError } from "better-auth/api";
import { TWO_FACTOR_ACCOUNT_LOCKOUT } from "./two-factor-policy";

/**
 * The complete set of endpoints that compare a submitted 2FA code. Every
 * other `/two-factor/*` route either mints a code or gates on the password,
 * not on a factor: `/two-factor/send-otp` only issues one
 * (`otp/index.mjs:53-91`), and enable/disable/generate-backup-codes/
 * get-totp-uri gate on `shouldRequirePassword`.
 */
export const STEP_UP_GATED_PATHS = [
	"/two-factor/verify-totp",
	"/two-factor/verify-backup-code",
	"/two-factor/verify-otp",
] as const;

export type StepUpGatedPath = (typeof STEP_UP_GATED_PATHS)[number];

/**
 * The one error code per endpoint that means "the submitted code was wrong",
 * as opposed to any other rejection. Counting anything else would let a
 * session holder burn the victim's budget with malformed requests, so this is
 * an allowlist: `OTP_HAS_EXPIRED`, `TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE`,
 * `TOTP_NOT_ENABLED`, `BACKUP_CODES_NOT_ENABLED`, body-validation failures,
 * and the code-less CONFLICT from backup-code redemption
 * (`backup-codes/index.mjs:204`) all fall through it deliberately.
 *
 * Pinned by the drift-guard suite: an upstream rename silently stops the
 * counting, so the strings are asserted against the installed version.
 */
export const STEP_UP_FAILURE_CODES: Record<StepUpGatedPath, string> = {
	"/two-factor/verify-totp": "INVALID_CODE",
	"/two-factor/verify-backup-code": "INVALID_BACKUP_CODE",
	"/two-factor/verify-otp": "INVALID_CODE",
};

/**
 * Mirrors `TWO_FACTOR_ERROR_CODES.ACCOUNT_TEMPORARILY_LOCKED`'s message so a
 * step-up rejection is indistinguishable from a sign-in one on the wire. The
 * client maps the response by `code`
 * (`apps/web/modules/saas/auth/hooks/errors-messages.ts:59`), and
 * `isTwoFactorAccountLockedError()` classifies both.
 */
export const ACCOUNT_TEMPORARILY_LOCKED_MESSAGE =
	"Too many failed verification attempts. Your account is temporarily locked. Please try again later.";

/**
 * The policy numbers, resolved to concrete values. `TWO_FACTOR_ACCOUNT_LOCKOUT`
 * is typed against Better Auth's option shape, where both fields are optional;
 * the fallbacks here are the ones Better Auth itself resolves when they are
 * omitted (`verify-two-factor.mjs:109-116`), so the step-up budget can never
 * silently diverge from the sign-in one. The repo sets both explicitly, and
 * `two-factor-lockout-policy.test.ts` pins those values.
 */
export const STEP_UP_MAX_FAILED_ATTEMPTS =
	TWO_FACTOR_ACCOUNT_LOCKOUT.maxFailedAttempts ?? 10;
export const STEP_UP_LOCK_DURATION_MS =
	(TWO_FACTOR_ACCOUNT_LOCKOUT.durationSeconds ?? 900) * 1000;

export interface StepUpLockoutRow {
	id: string;
	stepUpFailedCount: number;
	stepUpLockedUntil: Date | null;
	stepUpEpoch: number;
	/**
	 * Whether the enrolment this request is about to challenge was already
	 * ACTIVE when the before hook read it. Not used by the lockout itself — it
	 * rides along because this hook is the only place that reads the row before
	 * the endpoint can change it, and two other consumers need exactly that
	 * pre-state:
	 *  - the management step-up grant (./two-factor-management-step-up.ts) mints
	 *    only for a verification against an active factor;
	 *  - the audit emitter (./audit-events.ts) tells an ENROLMENT completion
	 *    apart from a step-up verification by it.
	 * Both would read `true` if they looked afterwards, because
	 * `/two-factor/verify-totp` flips the row to verified on the way out
	 * (`totp/index.mjs:158-176`).
	 */
	verified: boolean;
}

/** What a reservation observed at the moment it was taken. */
interface StepUpReservationResult {
	count: number;
	epoch: number;
}

/**
 * Storage seam. Production binds `createPrismaStepUpLockoutStore(db)`; the
 * behavioral suite binds an in-memory implementation, because Better Auth's
 * `getTestInstance` harness runs SQLite through its own adapter and has no
 * Prisma client to reach. The query shapes in the Prisma implementation carry
 * the atomicity contract and are asserted separately.
 */
export interface StepUpLockoutStore {
	findRowByUserId(userId: string): Promise<StepUpLockoutRow | null>;
	/**
	 * Clear an elapsed lock, guarded so a lock re-armed meanwhile survives.
	 * Bumps the epoch: clearing the budget is a reset boundary like any other.
	 */
	clearExpiredLock(rowId: string, now: Date): Promise<void>;
	/**
	 * Reserve one attempt. Returns the post-increment count together with the
	 * epoch it was taken under, or null when the row is gone.
	 */
	incrementFailure(rowId: string): Promise<StepUpReservationResult | null>;
	/**
	 * Give a reservation back, for an outcome that never reached a code
	 * comparison. Guarded on the reserving epoch so a restore that arrives
	 * after a reset is discarded, and on a positive count so it can never drive
	 * the counter below zero.
	 */
	restoreReservation(rowId: string, epoch: number): Promise<void>;
	/** Returns true only when this call actually wrote the lock. */
	lockConditionally(
		rowId: string,
		threshold: number,
		lockedUntil: Date,
	): Promise<boolean>;
	resetOnSuccess(rowId: string): Promise<void>;
}

export interface StepUpResolvedSession {
	session: unknown;
	user: { id: string };
}

export interface StepUpLockoutDeps {
	store: StepUpLockoutStore;
	/** Injected so tests can advance time without faking timers globally. */
	now?: () => Date;
	/**
	 * Injected only by tests, to drive the resolution-failure path. Production
	 * uses {@link resolveSessionOrThrow}.
	 */
	resolveSession?: (ctx: {
		context: { session?: unknown };
	}) => Promise<StepUpResolvedSession | null>;
}

/**
 * Resolve the caller's session, distinguishing "no authenticated session" from
 * "the session could not be resolved" — and propagating the latter.
 *
 * Better Auth's own `getSessionFromCtx` cannot be used here: it wraps the
 * lookup in `.catch(() => null)` (`session.mjs:286-288`), so a transient store
 * failure is indistinguishable from an anonymous caller. This hook would then
 * read that as a sign-in challenge, skip both the lock check and the row mark,
 * and let the endpoint's own later resolution succeed — an attempt that is
 * neither gated nor counted. Fail closed instead: the `/get-session` endpoint
 * already normalizes internal failures into an APIError
 * (`session.mjs:255-258`) and returns null only when there genuinely is no
 * session (`session.mjs` early `return null` / `ctx.json(null)`), so calling it
 * without the catch gives exactly the distinction that is needed.
 *
 * Everything else mirrors `getSessionFromCtx`: response headers are merged so a
 * session refresh's Set-Cookie is not dropped, and the result is memoized onto
 * `ctx.context.session` so the endpoint's own `verifyTwoFactor` call
 * (`verify-two-factor.mjs:14`) reuses this exact result and cannot disagree
 * with it about whether the request is a sign-in.
 */
export async function resolveSessionOrThrow(ctx: {
	context: { session?: unknown };
}): Promise<StepUpResolvedSession | null> {
	const authCtx = ctx.context as {
		session?: StepUpResolvedSession | null;
		responseHeaders?: Headers;
	};
	if (authCtx.session) {
		return authCtx.session;
	}

	const endpointCtx = ctx as unknown as {
		headers?: Headers;
		query?: Record<string, unknown>;
	};
	const result = (await getSession()({
		...ctx,
		method: "GET",
		asResponse: false,
		headers: endpointCtx.headers,
		returnHeaders: true,
		returnStatus: false,
		query: {
			...endpointCtx.query,
			disableCookieCache: endpointCtx.query?.disableCookieCache,
			disableRefresh: endpointCtx.query?.disableRefresh,
		},
		// Deliberately no `.catch` — see above.
	} as never)) as {
		headers?: Headers | null;
		response?: StepUpResolvedSession | null;
	} | null;

	if (!result) {
		authCtx.session = null;
		return null;
	}
	if (result.headers) {
		result.headers.forEach((value, key) => {
			if (!authCtx.responseHeaders) {
				authCtx.responseHeaders = new Headers({ [key]: value });
			} else if (key.toLowerCase() === "set-cookie") {
				authCtx.responseHeaders.append(key, value);
			} else {
				authCtx.responseHeaders.set(key, value);
			}
		});
	}
	authCtx.session = result.response ?? null;
	return result.response ?? null;
}

/**
 * Per-request handoff from the before hook to the after hook, carrying the
 * row id the before hook actually read. The after hook must not re-resolve
 * the row: between the two, `/two-factor/disable` + re-enable can replace it
 * (`two-factor/index.mjs:113-128,164-170`), and counting a failure against a
 * freshly created row would move the budget of a factor that was never
 * challenged.
 *
 * Keyed on `ctx.context`, whose identity is stable from `runBeforeHooks`
 * through `runAfterHooks`: `dispatch.mjs:193-198` builds it once per dispatch,
 * and the `defu` merge at `dispatch.mjs:217` copies the key by reference.
 * A WeakMap rather than a property so nothing is added to a Better Auth
 * object that a future version might serialize.
 */
interface StepUpReservation {
	rowId: string;
	/** The post-increment count this request holds. */
	reservedCount: number;
	/** The epoch the reservation was taken under. */
	reservedEpoch: number;
	/** {@link StepUpLockoutRow.verified}, as it stood before the endpoint ran. */
	verified: boolean;
}

const stepUpRowMarks = new WeakMap<object, StepUpReservation>();

function markStepUpRow(
	context: object,
	rowId: string,
	reservedCount: number,
	reservedEpoch: number,
	verified: boolean,
): void {
	stepUpRowMarks.set(context, {
		rowId,
		reservedCount,
		reservedEpoch,
		verified,
	});
}

function readStepUpRowMark(context: object): StepUpReservation | undefined {
	return stepUpRowMarks.get(context);
}

/** What the before hook observed about the factor this request challenged. */
export interface StepUpFactorPreState {
	/** True iff the enrolment was already active before the endpoint ran. */
	verified: boolean;
}

/**
 * The pre-endpoint state of the `two_factor` row {@link enforceStepUpLockout}
 * read, for an `hooks.after` consumer on the same request.
 *
 * `undefined` means this request never reached the row read — an
 * unauthenticated sign-in challenge, an account with no enrolment row, or a row
 * replaced mid-request. Consumers must treat that as "unknown" and fail toward
 * doing nothing, never as `verified: false`.
 */
export function readStepUpFactorPreState(
	context: object,
): StepUpFactorPreState | undefined {
	const mark = stepUpRowMarks.get(context);
	return mark ? { verified: mark.verified } : undefined;
}

function isGatedPath(path: unknown): path is StepUpGatedPath {
	return (
		typeof path === "string" &&
		(STEP_UP_GATED_PATHS as readonly string[]).includes(path)
	);
}

/**
 * True only for a shape all three endpoints return on success: `{ token, user }`
 * — `verify-two-factor.mjs:94-99` for the shared `valid()` path,
 * `backup-codes/index.mjs:207-210` for `disableSession`, and
 * `otp/index.mjs:193-196` for the enrollment branch.
 *
 * A positive shape check, not `!isAPIError(returned)`: a future endpoint
 * outcome that is neither a success nor a recognized failure would otherwise
 * be scored as a success and would clear the attacker's counter.
 */
export function isStepUpSuccessResponse(returned: unknown): boolean {
	if (typeof returned !== "object" || returned === null) {
		return false;
	}
	if (isAPIError(returned)) {
		return false;
	}
	const { token, user } = returned as { token?: unknown; user?: unknown };
	return (
		typeof token === "string" &&
		typeof user === "object" &&
		user !== null &&
		typeof (user as { id?: unknown }).id === "string"
	);
}

/**
 * True only for the one "wrong code" rejection this path can produce. Uses
 * Better Auth's exported `isAPIError` rather than `instanceof`, which is
 * unreliable when more than one copy of the constructor is resolvable.
 */
function isCountableStepUpFailure(
	path: StepUpGatedPath,
	returned: unknown,
): boolean {
	if (!isAPIError(returned)) {
		return false;
	}
	const code = (returned as { body?: { code?: unknown } }).body?.code;
	return code === STEP_UP_FAILURE_CODES[path];
}

/**
 * `hooks.before` half: refuse a locked account before the code comparison.
 *
 * MUST NOT be wrapped in a try/catch by its caller. A store failure has to
 * propagate — Better Auth re-throws out of `runBeforeHooks`
 * (`dispatch.mjs:86-89,207`), the router turns it into a 500, and the
 * comparison never happens. Swallowing it would silently restore the
 * unlimited-guessing behavior this module exists to remove.
 */
export async function enforceStepUpLockout(
	// The Better Auth middleware context; typed structurally because the
	// concrete generic depends on the full plugin list in ../auth.ts.
	ctx: {
		path?: string;
		context: { session?: unknown };
	},
	deps: StepUpLockoutDeps,
): Promise<void> {
	const path = ctx.path;
	if (!isGatedPath(path)) {
		return;
	}

	const resolveSession = deps.resolveSession ?? resolveSessionOrThrow;
	const session = await resolveSession(ctx);
	if (!session?.session) {
		// Sign-in challenge. Better Auth's own lockout owns this branch; a
		// second counter here would double-count the same failure.
		return;
	}

	const userId = session.user.id;
	const row = await deps.store.findRowByUserId(userId);
	if (!row) {
		// No enrolment row to hold a budget — `/two-factor/verify-otp` does not
		// require one on the authenticated branch (`otp/index.mjs:163-174`).
		return;
	}

	const now = deps.now?.() ?? new Date();
	const reject = () => {
		// Logged here, not in the shared `hooks.after` observer: throwing from a
		// before hook skips `hooks.after` entirely (`dispatch.mjs:207`), so the
		// sign-in lockout's logger would never see this rejection.
		logger.warn(
			{
				event: "auth.2fa.account_locked",
				security: true,
				path,
				phase: "step_up",
			},
			"Step-up 2FA verification rejected: account temporarily locked",
		);
		return new APIError("TOO_MANY_REQUESTS", {
			message: ACCOUNT_TEMPORARILY_LOCKED_MESSAGE,
			code: "ACCOUNT_TEMPORARILY_LOCKED",
		});
	};

	const lockFrom = (observedCount: number, repaired: boolean) =>
		deps.store
			.lockConditionally(
				row.id,
				STEP_UP_MAX_FAILED_ATTEMPTS,
				new Date(now.getTime() + STEP_UP_LOCK_DURATION_MS),
			)
			.then((written) => {
				if (written) {
					logger.warn(
						{
							event: "auth.2fa.step_up_locked",
							security: true,
							path,
							failedAttempts: observedCount,
							repaired,
						},
						repaired
							? "Step-up 2FA lock completed on a stranded threshold transition"
							: "Step-up 2FA verification locked: consecutive failure budget spent",
					);
				}
				return written;
			});

	if (row.stepUpLockedUntil) {
		if (row.stepUpLockedUntil.getTime() > now.getTime()) {
			// Rejected before the reservation below, so a locked account's counter
			// does not keep climbing while it is shut.
			throw reject();
		}
		// Elapsed lock: clear the count with it. Leaving the count at the
		// threshold would make the first attempt after expiry re-lock instantly.
		await deps.store.clearExpiredLock(row.id, now);
		row.stepUpFailedCount = 0;
	}

	if (row.stepUpFailedCount > STEP_UP_MAX_FAILED_ATTEMPTS) {
		// An INCOMPLETE THRESHOLD TRANSITION: a count ABOVE the threshold with no
		// lock standing means a lock write was lost. Strictly above, not at — a
		// count sitting exactly at the threshold is the normal state of a
		// reservation whose request is still in flight, and rejecting that would
		// refuse the very attempt the budget still allows.
		if (await lockFrom(row.stepUpFailedCount, true)) {
			throw reject();
		}
		// The guarded write matched nothing, which is ambiguous: either a lock is
		// already standing, or a successful verification reset the count between
		// the read above and this write. Re-read to tell them apart — a success
		// must win, so a cleared row is admitted rather than locked on stale state.
		const current = await deps.store.findRowByUserId(userId);
		if (
			current?.stepUpLockedUntil &&
			current.stepUpLockedUntil.getTime() > now.getTime()
		) {
			throw reject();
		}
	}

	// RESERVE the attempt before Better Auth compares anything.
	//
	// This ordering is the whole point. Scoring the attempt afterwards leaves two
	// holes: a burst of concurrent requests all read a count below the threshold
	// and are all compared before any of their increments land, so one stolen
	// session buys far more than the budget; and when reads succeed but writes
	// fail, the comparison has already happened, so a wrong guess errors while a
	// correct one still succeeds — a working oracle that never spends budget.
	// Reserving first closes both: admission is decided by the value the atomic
	// increment returns, and a write failure propagates BEFORE any comparison.
	const reserved = await deps.store.incrementFailure(row.id);
	if (reserved === null) {
		// The row was replaced between the read and the reservation (disable +
		// re-enable). There is no budget left to hold and nothing to restore.
		return;
	}
	const { count: reservedCount, epoch: reservedEpoch } = reserved;

	if (reservedCount > STEP_UP_MAX_FAILED_ATTEMPTS) {
		// Over budget. The reservation is deliberately NOT restored: the lock now
		// stands, and its expiry clears the count along with it.
		//
		// ACCEPTED CONSEQUENCE: eleven or more concurrent requests that all turn
		// out to be non-comparison outcomes can establish this lock without a
		// single failed comparison — their restores decrement afterwards but
		// never clear a lock. Both alternatives are worse. Not writing the lock
		// here leaves a count stranded above the threshold with no expiry, and
		// nothing can clear it: every later request is rejected before reaching a
		// comparison, so the success that would reset the budget can never
		// happen — a permanent wedge. Clearing the lock on restore instead hands
		// an attacker a refund primitive: park a restorable request in flight,
		// spend the whole budget on guesses, then let the stale restore unlock.
		// A spurious lock needs a pathological same-account burst and self-heals
		// at expiry, which the suite pins.
		if (!(await lockFrom(reservedCount, false))) {
			const current = await deps.store.findRowByUserId(userId);
			if (
				!current?.stepUpLockedUntil ||
				current.stepUpLockedUntil.getTime() <= now.getTime()
			) {
				// A success reset the budget while this reservation was in flight.
				markStepUpRow(
					ctx.context,
					row.id,
					reservedCount,
					reservedEpoch,
					row.verified,
				);
				return;
			}
		}
		throw reject();
	}

	markStepUpRow(
		ctx.context,
		row.id,
		reservedCount,
		reservedEpoch,
		row.verified,
	);
}

/**
 * `hooks.after` half: score the outcome the endpoint produced.
 *
 * Runs only for requests the before hook admitted, so an unauthenticated
 * sign-in verify can never reach the step-up counter.
 */
export async function recordStepUpVerificationOutcome(
	ctx: {
		path?: string;
		context: { returned?: unknown };
	},
	deps: StepUpLockoutDeps,
): Promise<void> {
	const reservation = readStepUpRowMark(ctx.context);
	if (!reservation) {
		return;
	}
	const { rowId, reservedCount, reservedEpoch } = reservation;
	const path = ctx.path;
	if (!isGatedPath(path)) {
		return;
	}

	const returned = ctx.context.returned;

	if (isCountableStepUpFailure(path, returned)) {
		// The budget was already spent by the reservation in the before hook, so
		// there is nothing to add here — a genuine wrong code simply keeps it.
		if (reservedCount < STEP_UP_MAX_FAILED_ATTEMPTS) {
			return;
		}
		// This attempt spent the last of the budget. Write the lock now rather
		// than leaving the next request to infer it, so the account is shut from
		// the moment it runs out. Deliberately NOT caught: a 500 in place of the
		// pending 401 fails closed, and the next request repairs the transition.
		const now = deps.now?.() ?? new Date();
		const locked = await deps.store.lockConditionally(
			rowId,
			STEP_UP_MAX_FAILED_ATTEMPTS,
			new Date(now.getTime() + STEP_UP_LOCK_DURATION_MS),
		);
		if (locked) {
			logger.warn(
				{
					event: "auth.2fa.step_up_locked",
					security: true,
					path,
					failedAttempts: reservedCount,
				},
				"Step-up 2FA verification locked: consecutive failure budget spent",
			);
		}
		return;
	}

	if (isStepUpSuccessResponse(returned)) {
		try {
			await deps.store.resetOnSuccess(rowId);
		} catch (error) {
			// Swallowed, unlike the failure path. The endpoint's side effects are
			// already committed — a backup code is spent, an enrolment is marked
			// verified — and the response is a success the caller will act on.
			// The residual risk is a stale count locking a later attempt early,
			// which errs toward refusing rather than admitting.
			logger.error(
				{
					event: "auth.2fa.step_up_reset_failed",
					security: true,
					path,
					error,
				},
				"Failed to reset the step-up 2FA failure count after a success",
			);
		}
		return;
	}

	// Anything else — an expired OTP, a spent per-code budget, an unenrolled
	// factor, the code-less CONFLICT, a body that failed validation inside the
	// endpoint — never reached a code comparison, so the reservation is given
	// back. This is what keeps #2791's request-counting defect dead: only a
	// genuine wrong code spends budget durably.
	try {
		await deps.store.restoreReservation(rowId, reservedEpoch);
	} catch (error) {
		// Swallowed. A failed restore leaves the budget one short, which locks
		// the account marginally early — the safe direction. Rethrowing would
		// instead turn a harmless non-comparison outcome into a 500 for a
		// legitimate user, buying no security.
		logger.error(
			{
				event: "auth.2fa.step_up_restore_failed",
				security: true,
				path,
				error,
			},
			"Failed to restore a step-up 2FA reservation after a non-comparison outcome",
		);
	}
}

/** Narrow Prisma's "record to update not found" without importing its error class. */
function isRecordNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "P2025"
	);
}

/**
 * Minimal surface of the Prisma client this store needs, so the unit tests can
 * assert the emitted query shapes without a Postgres instance.
 */
export interface StepUpLockoutPrismaClient {
	twoFactor: {
		findFirst(args: unknown): Promise<StepUpLockoutRow | null>;
		update(args: unknown): Promise<{
			stepUpFailedCount: number;
			stepUpEpoch: number;
		}>;
		updateMany(args: unknown): Promise<{ count: number }>;
	};
}

export function createPrismaStepUpLockoutStore(
	client: StepUpLockoutPrismaClient,
): StepUpLockoutStore {
	return {
		findRowByUserId(userId) {
			// `findFirst`, not `findUnique`, even though `two_factor.userId` now
			// carries a unique constraint (migration
			// 20260816140000_add_two_factor_step_up_grant): this keeps reading the
			// row exactly the way Better Auth does (`adapter.findOne` with the same
			// predicate and no ordering), so the two can never disagree about which
			// row they are looking at if that constraint is ever relaxed.
			return client.twoFactor.findFirst({
				where: { userId },
				select: {
					id: true,
					stepUpFailedCount: true,
					stepUpLockedUntil: true,
					stepUpEpoch: true,
					// Not part of the lockout's own state — carried for the after-hook
					// consumers documented on StepUpLockoutRow.verified.
					verified: true,
				},
			});
		},

		async clearExpiredLock(rowId, now) {
			await client.twoFactor.updateMany({
				where: { id: rowId, stepUpLockedUntil: { lte: now } },
				data: {
					stepUpFailedCount: 0,
					stepUpLockedUntil: null,
					// A reset boundary: reservations taken before the lock elapsed
					// must not refund against the budget that starts here.
					stepUpEpoch: { increment: 1 },
				},
			});
		},

		async incrementFailure(rowId) {
			try {
				// One statement — Postgres evaluates `col = col + 1` under the row
				// lock and returns the result, so concurrent failures cannot both
				// read the same value and write the same successor.
				const updated = await client.twoFactor.update({
					where: { id: rowId },
					data: { stepUpFailedCount: { increment: 1 } },
					select: { stepUpFailedCount: true, stepUpEpoch: true },
				});
				return {
					count: updated.stepUpFailedCount,
					epoch: updated.stepUpEpoch,
				};
			} catch (error) {
				if (isRecordNotFoundError(error)) {
					return null;
				}
				throw error;
			}
		},

		async restoreReservation(rowId, epoch) {
			// Guarded on the reserving EPOCH, not just on the row: without it a
			// restore that lands after a reset would refund an attempt the reset
			// already cleared, erasing a genuine failure counted since. Guarded on
			// a positive count too, so a double restore cannot go negative.
			await client.twoFactor.updateMany({
				where: {
					id: rowId,
					stepUpEpoch: epoch,
					stepUpFailedCount: { gt: 0 },
				},
				data: { stepUpFailedCount: { decrement: 1 } },
			});
		},

		async lockConditionally(rowId, threshold, lockedUntil) {
			// Guarded on the count the caller observed and on no lock already
			// standing, so a success that committed between the increment and this
			// write wins: without the guard a stale count would re-lock an account
			// that had just been reset.
			const { count } = await client.twoFactor.updateMany({
				where: {
					id: rowId,
					stepUpFailedCount: { gte: threshold },
					stepUpLockedUntil: null,
				},
				data: { stepUpLockedUntil: lockedUntil },
			});
			return count > 0;
		},

		async resetOnSuccess(rowId) {
			await client.twoFactor.updateMany({
				where: {
					id: rowId,
					OR: [
						{ stepUpFailedCount: { gt: 0 } },
						{ stepUpLockedUntil: { not: null } },
					],
				},
				data: {
					stepUpFailedCount: 0,
					stepUpLockedUntil: null,
					// A reset boundary: in-flight reservations taken before this
					// success must not refund against the budget that starts here.
					stepUpEpoch: { increment: 1 },
				},
			});
		},
	};
}
