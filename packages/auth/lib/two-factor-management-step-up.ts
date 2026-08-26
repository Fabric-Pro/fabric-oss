/**
 * Server-enforced STEP-UP for the 2FA MANAGEMENT endpoints (issue #2827).
 *
 * Better Auth gates `/two-factor/{disable,enable,generate-backup-codes,
 * get-totp-uri}` on the account PASSWORD alone (`shouldRequirePassword` +
 * `validatePassword` / `checkPassword`, `plugins/two-factor/index.mjs:82-88,
 * 156-162`, `backup-codes/index.mjs:241-244`, `totp/index.mjs:94-97`). An
 * attacker holding a stolen session and a phished password can therefore strip
 * the second factor, rotate the TOTP secret to one they control, export the
 * existing secret, or mint themselves a fresh set of backup codes — without
 * ever producing a code. The web client already verified before disabling, but
 * that was client-side sequencing: nothing stopped a direct call to the
 * endpoint.
 *
 * This module makes the verification a server-side precondition. It is a pair
 * of hooks around a SINGLE-USE, SHORT-TTL grant:
 *
 *  - `recordStepUpGrantOutcome` mints a grant in `hooks.after` when a
 *    session-present verification succeeds on one of the verify endpoints;
 *  - `requireStepUpGrant` spends it in `hooks.before` on the four management
 *    endpoints, and refuses the call when there is none.
 *
 * BOTH HALVES OF THE GRANT ARE REQUIRED, and the reason is the threat model.
 *
 *  1. SERVER STATE — `session.twoFactorStepUpGrantedAt`, written on the exact
 *     session row that performed the verification. On its own this is not
 *     enough: the attacker holds the victim's session cookie, so "the session
 *     that verified" and "the attacker's session" are the SAME row. The moment
 *     the victim legitimately verifies, the attacker can spend the grant.
 *
 *  2. POSSESSION PROOF — a signed, HttpOnly, SameSite, Max-Age≈300 cookie
 *     carrying `{sessionId, grantedAt}`, set in the same after hook. It is
 *     delivered ONLY in the HTTP response to the request that proved the
 *     factor, so an attacker working from an earlier cookie snapshot never
 *     receives it. On its own this is not enough either: a cookie cannot be
 *     revoked, so it would outlive a server-side session revocation and could
 *     be replayed after the victim signed the attacker out.
 *
 * Requiring both, and consuming them together in one guarded write, is what
 * makes the grant single-use, bound to a live session, and un-replayable.
 *
 * ACCEPTED TRADE-OFFS, deliberately:
 *  - An attacker who is present in the browser at the moment the victim
 *    verifies still sees the cookie; nothing short of re-prompting per action
 *    changes that, and the endpoints already require the password too.
 *  - The grant is spent by the FIRST management call after a verification,
 *    whichever it is. A client that verifies and then makes two management
 *    calls must verify twice. Both callers in this repo do exactly one.
 *  - `/two-factor/view-backup-codes` is NOT gated: it is
 *    `createAuthEndpoint.serverOnly` in 1.6.22 (`backup-codes/index.mjs:267`),
 *    so it is never mounted on the HTTP router. The only reader in this repo is
 *    the server-side `getBackupCodesStatus` procedure, which returns counts.
 */

import { logger } from "@repo/logs";
import { APIError, isAPIError } from "better-auth/api";
import { expireCookie } from "better-auth/cookies";
import {
	isStepUpSuccessResponse,
	readStepUpFactorPreState,
	resolveSessionOrThrow,
	STEP_UP_GATED_PATHS,
	type StepUpResolvedSession,
} from "./two-factor-step-up-lockout";

/**
 * The 2FA management endpoints, i.e. every `/two-factor/*` route that CHANGES
 * enrolment state or hands back a secret, and that Better Auth gates on the
 * password alone. Pinned against the installed version by the drift suite.
 */
export const STEP_UP_MANAGED_PATHS = [
	"/two-factor/disable",
	"/two-factor/enable",
	"/two-factor/generate-backup-codes",
	"/two-factor/get-totp-uri",
] as const;

type StepUpManagedPath = (typeof STEP_UP_MANAGED_PATHS)[number];

/** How long a minted grant stays spendable. */
export const STEP_UP_GRANT_TTL_MS = 5 * 60 * 1000;

/**
 * Cookie name passed to `ctx.context.createAuthCookie`, which prefixes it with
 * the deployment's cookie prefix and applies the same HttpOnly / Secure /
 * SameSite / Path attributes every other auth cookie gets.
 */
export const STEP_UP_GRANT_COOKIE_NAME = "two_factor_step_up";

/** Separates the two payload fields. `!`, matching the plugin's own trusted-device cookie. */
const GRANT_COOKIE_SEPARATOR = "!";

const STEP_UP_REQUIRED_CODE = "STEP_UP_REQUIRED";

/**
 * Deliberately generic. It says a fresh verification is needed and nothing
 * about WHY the presented grant failed — a caller cannot distinguish "no grant"
 * from "expired" from "already spent" from "wrong session", so the response
 * carries no oracle about the victim's session state.
 */
const STEP_UP_REQUIRED_MESSAGE =
	"Verify your two-factor authentication code again before changing two-factor settings.";

/**
 * The error codes on the four gated endpoints that are positively known to be
 * raised BEFORE the endpoint mutates anything, and are therefore safe to give
 * the grant back for.
 *
 * An allowlist rather than "any 4xx": `/two-factor/enable` and
 * `/two-factor/disable` can fail PART-WAY (enable deletes the old enrolment row
 * before creating the new one; disable flips `twoFactorEnabled` before deleting
 * the row and rotating the session), and restoring a grant after a partial
 * mutation would let the next call operate on half-changed state with a
 * verification that no longer describes it.
 *
 *  - `INVALID_PASSWORD` is what all four throw for a missing or wrong password,
 *    via `APIError.from("BAD_REQUEST", BASE_ERROR_CODES.INVALID_PASSWORD)`, and
 *    in all four it is the FIRST thing that can fail after the session
 *    resolves.
 *  - `VALIDATION_ERROR` is better-call's body-schema rejection
 *    (`better-call/dist/error.mjs`'s `ValidationError`), raised in
 *    `createInternalContext` before the handler body runs at all. Our before
 *    hook runs ahead of that validation, so a malformed body can consume a
 *    grant that no handler ever saw.
 *
 * Pinned by the drift suite: a rename upstream would silently turn a typo'd
 * password into a spent grant.
 */
export const STEP_UP_RESTORABLE_FAILURE_CODES = [
	"INVALID_PASSWORD",
	"VALIDATION_ERROR",
] as const;

/**
 * Storage seam, mirroring `./two-factor-step-up-lockout.ts`. Production binds
 * `createPrismaStepUpGrantStore(db)`; the behavioral suite binds an
 * implementation over Better Auth's own test adapter, because that harness has
 * no Prisma client. The query shapes carry the atomicity contract and are
 * asserted separately.
 */
export interface StepUpGrantStore {
	/**
	 * Whether this account has an ACTIVE second factor, read fresh from the
	 * database rather than from the (cookie-cacheable) session user.
	 *
	 * True iff `user.twoFactorEnabled` is set OR a `two_factor` row exists for
	 * the user with `verified: true`. The OR is load-bearing in both directions,
	 * because either half alone leaves an exploitable corrupt state:
	 *
	 *  - flag TRUE with no verified row (a disable that failed after flipping
	 *    the flag, or the window inside `/two-factor/enable` between its
	 *    `deleteMany` and its `create`). A row-only predicate would leave
	 *    `/two-factor/enable` ungated there — and enable returns a fresh set of
	 *    backup codes that `verifyBackupCode` accepts without checking
	 *    `verified` (`backup-codes/index.mjs:163-191`), so that is a full
	 *    bypass, not a cosmetic gap.
	 *  - flag FALSE with a verified row (an enrolment whose user update was
	 *    lost). A flag-only predicate would leave a working factor unprotected.
	 *
	 * An EXISTENCE check, not a "read the row and inspect it" check, so it is
	 * correct even if duplicate rows exist for a user.
	 */
	isTwoFactorActive(userId: string): Promise<boolean>;
	/**
	 * Record a grant on a live session row. Returns false when the row is gone
	 * or already expired, in which case no cookie must be issued.
	 */
	grant(sessionId: string, userId: string, grantedAt: Date): Promise<boolean>;
	/**
	 * Atomically spend the grant. Returns true only when THIS call cleared it.
	 */
	consume(
		sessionId: string,
		userId: string,
		grantedAt: Date,
		now: Date,
	): Promise<boolean>;
	/**
	 * Put a consumed grant back after a rejection that changed nothing. Guarded
	 * so it can never overwrite a newer grant.
	 */
	restore(sessionId: string, grantedAt: Date, now: Date): Promise<boolean>;
}

export interface StepUpGrantDeps {
	store: StepUpGrantStore;
	/** Injected so tests can advance time without faking timers globally. */
	now?: () => Date;
	/**
	 * Injected only by tests, to drive the resolution-failure path. Production
	 * uses the lockout module's `resolveSessionOrThrow`.
	 */
	resolveSession?: (ctx: {
		context: { session?: unknown };
	}) => Promise<StepUpResolvedSession | null>;
}

/**
 * The Better Auth middleware context, typed structurally: the concrete generic
 * depends on the full plugin list in `../auth.ts`, and `@repo/web` re-checks
 * that file under its own config and resolves those generics differently.
 */
export interface StepUpGrantCtx {
	path?: string;
	body?: unknown;
	context: {
		session?: unknown;
		returned?: unknown;
		secret: string;
		createAuthCookie: (
			name: string,
			options?: { maxAge?: number },
		) => { name: string; attributes: Record<string, unknown> };
	};
	getSignedCookie: (
		name: string,
		secret: string,
	) => Promise<string | false | null>;
	setSignedCookie: (
		name: string,
		value: string,
		secret: string,
		attributes: Record<string, unknown>,
	) => Promise<unknown>;
	setCookie: (
		name: string,
		value: string,
		options?: Record<string, unknown>,
	) => unknown;
}

/** A session narrowed to the fields this module needs off the resolved result. */
interface ResolvedSessionWithId {
	session?: { id?: unknown } | null;
	user: { id: string };
}

/**
 * The grant this request spent, handed from the before hook to the after hook.
 *
 * Keyed on `ctx.context`, whose identity is stable from `runBeforeHooks`
 * through `runAfterHooks` (`dist/api/dispatch.mjs:191-242`) — the same carrier
 * the lockout module uses, for the same reason.
 */
interface ConsumedGrant {
	sessionId: string;
	grantedAt: Date;
}

const consumedGrants = new WeakMap<object, ConsumedGrant>();

function isManagedPath(path: unknown): path is StepUpManagedPath {
	return (
		typeof path === "string" &&
		(STEP_UP_MANAGED_PATHS as readonly string[]).includes(path)
	);
}

function isVerifyPath(path: unknown): boolean {
	return (
		typeof path === "string" &&
		(STEP_UP_GATED_PATHS as readonly string[]).includes(path)
	);
}

function grantCookieConfig(ctx: StepUpGrantCtx) {
	return ctx.context.createAuthCookie(STEP_UP_GRANT_COOKIE_NAME, {
		maxAge: Math.floor(STEP_UP_GRANT_TTL_MS / 1000),
	});
}

/**
 * Read and authenticate the grant cookie.
 *
 * `getSignedCookie` returns `null` when the cookie is absent and `false` when
 * the signature does not verify (`better-call/dist/context.mjs:39-49`), so a
 * forged or tampered value is indistinguishable here from no cookie at all —
 * both simply produce no grant.
 */
async function readGrantCookie(
	ctx: StepUpGrantCtx,
): Promise<{ sessionId: string; grantedAt: Date } | null> {
	const raw = await ctx.getSignedCookie(
		grantCookieConfig(ctx).name,
		ctx.context.secret,
	);
	if (typeof raw !== "string" || raw.length === 0) {
		return null;
	}
	const separator = raw.lastIndexOf(GRANT_COOKIE_SEPARATOR);
	if (separator < 1) {
		return null;
	}
	const sessionId = raw.slice(0, separator);
	const grantedAtMs = Number(raw.slice(separator + 1));
	if (!Number.isSafeInteger(grantedAtMs) || grantedAtMs <= 0) {
		return null;
	}
	return { sessionId, grantedAt: new Date(grantedAtMs) };
}

/**
 * `hooks.before` half: refuse a 2FA management call that carries no live
 * step-up grant, and spend the grant when it does.
 *
 * MUST NOT be wrapped in a try/catch by its caller, for the same reason as
 * `enforceStepUpLockout`: a store failure has to propagate so the endpoint
 * never runs. Swallowing it would restore exactly the password-only access this
 * module exists to remove.
 */
export async function requireStepUpGrant(
	ctx: StepUpGrantCtx,
	deps: StepUpGrantDeps,
): Promise<void> {
	const path = ctx.path;
	if (!isManagedPath(path)) {
		return;
	}

	const resolveSession = deps.resolveSession ?? resolveSessionOrThrow;
	// Fail-closed session resolution — see resolveSessionOrThrow. A transient
	// session-store failure must not read as "anonymous" here, because anonymous
	// is the ungated branch.
	const resolved = (await resolveSession(
		ctx,
	)) as ResolvedSessionWithId | null;
	const sessionId = resolved?.session?.id;
	if (typeof sessionId !== "string" || !resolved) {
		// No authenticated session. The endpoint's own `sessionMiddleware` /
		// `sensitiveSessionMiddleware` answers 401; gating here as well would
		// only replace that with a 403 that leaks whether 2FA is enabled.
		return;
	}
	const userId = resolved.user.id;

	if (!(await deps.store.isTwoFactorActive(userId))) {
		// Nothing to protect yet: first-time enrolment (`/two-factor/enable` with
		// the flag unset and no verified row), and resuming an abandoned one.
		// Gating these would make it impossible to turn 2FA on in the first place.
		return;
	}

	const now = deps.now?.() ?? new Date();
	const reject = (reason: string) => {
		// Logged here, not in a shared `hooks.after` observer: throwing from a
		// before hook skips `hooks.after` entirely (`dispatch.mjs:207`).
		logger.warn(
			{
				event: "auth.2fa.step_up_required",
				security: true,
				path,
				reason,
			},
			"2FA management call rejected: no valid step-up grant",
		);
		return new APIError("FORBIDDEN", {
			message: STEP_UP_REQUIRED_MESSAGE,
			code: STEP_UP_REQUIRED_CODE,
		});
	};

	// Cheap pre-checks BEFORE the grant is spent. All four endpoints take a
	// password, so a request without one cannot succeed anyway — burning the
	// grant on it would let a malformed request cost the user a verification.
	// Answering with the step-up rejection rather than the endpoint's own
	// INVALID_PASSWORD keeps the gate's responses uniform and is the fail-closed
	// direction; every caller in this repo always sends the password.
	const password = (ctx.body as { password?: unknown } | null | undefined)
		?.password;
	if (typeof password !== "string" || password.length === 0) {
		throw reject("missing_password");
	}

	const cookie = await readGrantCookie(ctx);
	if (!cookie) {
		throw reject("no_cookie");
	}
	if (cookie.sessionId !== sessionId) {
		// A cookie minted for another session — including one this browser used
		// before `/two-factor/enable` or `/two-factor/disable` rotated it.
		throw reject("session_mismatch");
	}
	if (cookie.grantedAt.getTime() + STEP_UP_GRANT_TTL_MS <= now.getTime()) {
		throw reject("expired");
	}

	// ONE guarded write decides admission. The `expiresAt` predicate means a
	// revoked or deleted session can never spend a grant even while the cookie
	// cache would still resolve it; the exact match on `grantedAt` means an old
	// cookie cannot ride a newer grant; and clearing the column in the same
	// statement is what makes the grant single-use under concurrency — two
	// simultaneous management calls cannot both match.
	const consumed = await deps.store.consume(
		sessionId,
		userId,
		cookie.grantedAt,
		now,
	);
	if (!consumed) {
		throw reject("not_granted");
	}

	consumedGrants.set(ctx.context, {
		sessionId,
		grantedAt: cookie.grantedAt,
	});
}

/**
 * `hooks.after` half. Two disjoint responsibilities, in one export so a caller
 * cannot wire half of the pair:
 *
 *  - on the VERIFY paths, mint a grant for a successful session-present
 *    verification against an active factor;
 *  - on the MANAGEMENT paths, settle the grant the before hook spent — give it
 *    back if the endpoint rejected before changing anything, and expire the
 *    cookie once the operation succeeded.
 *
 * Never throws. Its failure modes are inconvenience (a verification that has to
 * be repeated), while throwing here would turn an already-committed success —
 * a spent backup code, a rotated secret — into a 500 for the caller.
 */
export async function recordStepUpGrantOutcome(
	ctx: StepUpGrantCtx,
	deps: StepUpGrantDeps,
): Promise<void> {
	try {
		if (isVerifyPath(ctx.path)) {
			await mintGrant(ctx, deps);
			return;
		}
		if (isManagedPath(ctx.path)) {
			await settleConsumedGrant(ctx, deps);
		}
	} catch (error) {
		logger.error(
			{
				event: "auth.2fa.step_up_grant_failed",
				security: true,
				path: ctx.path,
				error,
			},
			"Failed to settle the 2FA step-up grant after the endpoint ran",
		);
	}
}

async function mintGrant(
	ctx: StepUpGrantCtx,
	deps: StepUpGrantDeps,
): Promise<void> {
	if (!isStepUpSuccessResponse(ctx.context.returned)) {
		return;
	}

	// The state of the enrolment row BEFORE the endpoint ran, stashed by the
	// lockout before hook. `undefined` means that hook never reached a row read
	// — an unauthenticated sign-in challenge, or an account with no enrolment
	// row — so there is nothing to mint against either way.
	const preState = readStepUpFactorPreState(ctx.context);
	if (preState?.verified !== true) {
		// An ENROLMENT-completing verification, not a step-up. Better Auth
		// rotates the session on that path (`totp/index.mjs:158-167`), so a grant
		// keyed to the pre-rotation session id would match zero rows anyway; this
		// skips it explicitly rather than relying on that.
		return;
	}

	const resolved = ctx.context.session as ResolvedSessionWithId | null;
	const sessionId = resolved?.session?.id;
	if (typeof sessionId !== "string" || !resolved) {
		return;
	}

	// Deliberately NOT folded into the lockout's `resetOnSuccess`: that write
	// carries an `OR: [{stepUpFailedCount:{gt:0}},{stepUpLockedUntil:{not:null}}]`
	// guard which only ever matches because a reservation is guaranteed to have
	// incremented the count first. A concurrent success that zeroed the row
	// first would make the combined write match nothing — and silently mint no
	// grant, which reads to the user as "verification did not work".
	const grantedAt = deps.now?.() ?? new Date();
	const written = await deps.store.grant(
		sessionId,
		resolved.user.id,
		grantedAt,
	);
	if (!written) {
		// The session was revoked or expired between the verification and this
		// write. No row holds the grant, so issuing the cookie would only produce
		// a rejection later.
		return;
	}

	const cookie = grantCookieConfig(ctx);
	await ctx.setSignedCookie(
		cookie.name,
		`${sessionId}${GRANT_COOKIE_SEPARATOR}${grantedAt.getTime()}`,
		ctx.context.secret,
		cookie.attributes,
	);

	logger.info(
		{
			event: "auth.2fa.step_up_granted",
			security: true,
			path: ctx.path,
		},
		"2FA step-up grant issued after a successful verification",
	);
}

async function settleConsumedGrant(
	ctx: StepUpGrantCtx,
	deps: StepUpGrantDeps,
): Promise<void> {
	const consumed = consumedGrants.get(ctx.context);
	if (!consumed) {
		// Either the path was ungated (no active factor) or the gate rejected,
		// and a before-hook throw skips this hook entirely.
		return;
	}

	const returned = ctx.context.returned;
	if (!isAPIError(returned)) {
		// Succeeded. Expire the cookie so a grant that is already gone from the
		// session row cannot linger in the browser and produce a confusing
		// rejection on the next management call.
		expireCookie(
			ctx as unknown as Parameters<typeof expireCookie>[0],
			grantCookieConfig(ctx) as unknown as Parameters<
				typeof expireCookie
			>[1],
		);
		return;
	}

	const code = (returned as { body?: { code?: unknown } }).body?.code;
	if (
		typeof code !== "string" ||
		!(STEP_UP_RESTORABLE_FAILURE_CODES as readonly string[]).includes(code)
	) {
		// Any other rejection may have mutated something; see
		// STEP_UP_RESTORABLE_FAILURE_CODES. The grant stays spent, and the cookie
		// stays put so the next attempt is refused by the guarded consume rather
		// than by a missing cookie.
		return;
	}

	// AVAILABILITY, not security: without this, a mistyped password after a
	// verification costs the user the verification too. In the worst case they
	// spent their LAST backup code on it, so the typo would strand them.
	//
	// The write is guarded on the column still being null, so a NEWER grant —
	// minted by a verification that raced this rejection — is never clobbered,
	// and on the session still being live. The TTL is checked here rather than
	// in the store because a grant that has already expired is not worth a
	// round trip; the cookie is left alone either way, so a restored grant is
	// immediately retryable with the cookie the browser already holds.
	const now = deps.now?.() ?? new Date();
	if (consumed.grantedAt.getTime() + STEP_UP_GRANT_TTL_MS <= now.getTime()) {
		return;
	}
	await deps.store.restore(consumed.sessionId, consumed.grantedAt, now);
}

/**
 * Minimal surface of the Prisma client this store needs, so the unit tests can
 * assert the emitted query shapes without a Postgres instance.
 */
export interface StepUpGrantPrismaClient {
	user: {
		findUnique(args: unknown): Promise<{
			twoFactorEnabled: boolean | null;
		} | null>;
	};
	twoFactor: {
		findFirst(args: unknown): Promise<{ id: string } | null>;
	};
	session: {
		updateMany(args: unknown): Promise<{ count: number }>;
	};
}

export function createPrismaStepUpGrantStore(
	client: StepUpGrantPrismaClient,
): StepUpGrantStore {
	return {
		async isTwoFactorActive(userId) {
			// Both halves read fresh from the database. The session user cannot be
			// trusted for this: `session.cookieCache` serves a snapshot up to five
			// minutes old (`../auth.ts`), so a user whose 2FA was enabled moments
			// ago would still look unenrolled — and unenrolled is the UNGATED
			// branch.
			const [user, verifiedRow] = await Promise.all([
				client.user.findUnique({
					where: { id: userId },
					select: { twoFactorEnabled: true },
				}),
				client.twoFactor.findFirst({
					where: { userId, verified: true },
					select: { id: true },
				}),
			]);
			return user?.twoFactorEnabled === true || verifiedRow !== null;
		},

		async grant(sessionId, userId, grantedAt) {
			// `updateMany` with the predicate in the WHERE clause, not a read then
			// an update: a session revoked between the two would otherwise have the
			// grant written onto a row that is on its way out.
			const { count } = await client.session.updateMany({
				where: {
					id: sessionId,
					userId,
					expiresAt: { gt: grantedAt },
				},
				data: { twoFactorStepUpGrantedAt: grantedAt },
			});
			return count > 0;
		},

		async consume(sessionId, userId, grantedAt, now) {
			// The whole admission decision, in one statement:
			//  - `id` + `userId` bind the grant to this caller's own session;
			//  - `expiresAt: { gt: now }` refuses a revoked or expired session even
			//    while the cookie cache would still resolve it;
			//  - the exact `twoFactorStepUpGrantedAt` match means a stale cookie
			//    cannot spend a grant minted later;
			//  - clearing the column here is what makes it single-use: two
			//    concurrent management calls contend on the same row and only one
			//    can match.
			const { count } = await client.session.updateMany({
				where: {
					id: sessionId,
					userId,
					expiresAt: { gt: now },
					twoFactorStepUpGrantedAt: grantedAt,
				},
				data: { twoFactorStepUpGrantedAt: null },
			});
			return count > 0;
		},

		async restore(sessionId, grantedAt, now) {
			// Guarded on still-null so a grant minted by a concurrent verification
			// is never overwritten with this older one, and on the session still
			// being live so a revoked session cannot be handed a grant back.
			const { count } = await client.session.updateMany({
				where: {
					id: sessionId,
					twoFactorStepUpGrantedAt: null,
					expiresAt: { gt: now },
				},
				data: { twoFactorStepUpGrantedAt: grantedAt },
			});
			return count > 0;
		},
	};
}
