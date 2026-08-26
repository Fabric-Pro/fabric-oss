/**
 * Audit-log emission for Better Auth hook events.
 *
 * Better Auth's `hooks.after` middleware runs outside the oRPC procedure
 * context, so we cannot reuse `@repo/api/lib/audit.recordAuditFromRequest`.
 * This module wraps the bare `recordAudit` helper from `@repo/database`
 * with two helpers tuned to the Better Auth ctx shape:
 *
 *  - `extractAuthRequestContext(ctx)` — pulls IP / UA / requestId from
 *    `ctx.request` when available.
 *  - `emitAuthAuditEvent(ctx, deps)` — branches on `ctx.path` and emits
 *    the v1 taxonomy auth events (`auth.login.success`,
 *    `auth.login.failure`, `auth.logout`, `auth.password.changed`,
 *    `auth.mfa.enabled`, `auth.mfa.disabled`,
 *    `auth.impersonation.started`, `auth.impersonation.ended`).
 *
 * All emissions are fire-and-forget per D9. The helper catches and logs
 * any unexpected error from the branching logic so a malformed ctx
 * shape never breaks the auth flow.
 *
 * Spec: docs/audit-log/README.md §7.3
 */

import { recordAudit } from "@repo/database";
import { logger } from "@repo/logs";
import { isAPIError } from "better-auth/api";
import { getTrustedClientIpFromRequest } from "./client-ip";
import { isChallengeGatedMint, isFreshSessionMint } from "./two-factor-gate";
import {
	isStepUpSuccessResponse,
	readStepUpFactorPreState,
} from "./two-factor-step-up-lockout";

export interface AuthRequestContext {
	ipAddress: string | null;
	userAgent: string | null;
	requestId: string | null;
}

/**
 * Resolve IP / UA / request-id from a Better Auth ctx. Returns nulls
 * across the board when no `ctx.request` is present (e.g. when the auth
 * server is invoked programmatically rather than via HTTP).
 */
export function extractAuthRequestContext(ctx: unknown): AuthRequestContext {
	const request = (ctx as { request?: Request } | null | undefined)?.request;
	if (!request) {
		return { ipAddress: null, userAgent: null, requestId: null };
	}
	const ip = getTrustedClientIpFromRequest(request);
	const ipAddress = ip && ip !== "unknown" ? ip : null;
	const userAgent = request.headers.get("user-agent") ?? null;
	const requestId =
		request.headers.get("x-request-id") ??
		request.headers.get("x-correlation-id") ??
		null;
	return { ipAddress, userAgent, requestId };
}

type UserLookupFn = (email: string) => Promise<{
	id: string;
	email: string | null;
	name: string | null;
} | null>;

interface SessionShape {
	// `token` is what the shared fresh-mint discriminator compares (both the
	// login-success branch and the /verify-email branch below); `id` is what
	// the audit rows themselves carry.
	session?: { id?: string; token?: string };
	user?: {
		id: string;
		email?: string | null;
		name?: string | null;
		twoFactorEnabled?: boolean | null;
	};
}

interface BetterAuthCtx {
	path: string;
	body?: Record<string, unknown> | undefined;
	context?: {
		session?: SessionShape | null;
		newSession?: SessionShape | null;
		/**
		 * The endpoint's outcome. Better Auth runs `hooks.after`
		 * unconditionally, including when the endpoint threw
		 * (`dist/api/dispatch.mjs:231-242`), so this is an `APIError` on every
		 * failed call — which is why the branches below that record a state
		 * change have to check it.
		 */
		returned?: unknown;
	} | null;
	request?: Request;
}

export interface EmitAuthAuditDeps {
	/** Look up a user by email — used to attach a real `userId` to
	 *  failed-login rows when the attempted email matches a known user.
	 *  Returning `null` keeps the failure row as `actor: { type: "system" }`. */
	getUserByEmail: UserLookupFn;
}

/**
 * Branch on `ctx.path` and emit one of the v1 auth-taxonomy audit rows.
 * Safe to call unconditionally inside the Better Auth `hooks.after`
 * middleware — non-auth paths are simply ignored. Never throws.
 */
export async function emitAuthAuditEvent(
	ctx: BetterAuthCtx,
	deps: EmitAuthAuditDeps,
): Promise<void> {
	try {
		const path = ctx.path;
		const reqCtx = extractAuthRequestContext(ctx);
		const sessionLike = ctx.context?.session ?? null;
		const sessionId = sessionLike?.session?.id ?? null;

		// Resolve the auth method from the request path. Defaults to
		// `password` for /sign-in/email (the historical Better Auth
		// flow). Future enhancement (item 7): branch on additional sign-in
		// endpoints once those are wired (`/sign-in/passkey`,
		// `/sign-in/magic-link`, OAuth callback paths).
		const authMethod = (() => {
			if (path?.startsWith("/sign-in/passkey")) {
				return "passkey";
			}
			// Magic link / OAuth SUCCESS lands on the verify/callback path, not
			// the /sign-in/* initiation path — map both so the emitted method is
			// correct regardless of which fires.
			if (
				path === "/magic-link/verify" ||
				path?.startsWith("/sign-in/magic-link")
			) {
				return "magic_link";
			}
			if (
				path?.startsWith("/sign-in/social") ||
				path?.startsWith("/callback/") ||
				path?.startsWith("/oauth2/callback/")
			) {
				return "oauth";
			}
			if (path === "/two-factor/verify-totp") {
				return "2fa_totp";
			}
			if (path === "/two-factor/verify-backup-code") {
				return "2fa_backup";
			}
			if (path === "/verify-email") {
				return "email_verification";
			}
			return "password";
		})();

		if (path === "/sign-in/email") {
			const newSession = ctx.context?.newSession ?? null;
			// Known gap, not fixed here: Better Auth's own `twoFactor()`
			// plugin gates this exact path via a plugin-level `hooks.after`
			// (`dist/plugins/two-factor/index.mjs`, matcher
			// "/sign-in/{email,username,phone-number}"). Our own
			// `hooks.after` (this function's caller) runs BEFORE plugin
			// after-hooks in Better Auth's dispatch order, so when
			// `twoFactorEnabled` is true this `newSession` is the same
			// pre-2FA session that plugin hook is about to delete — unless
			// the request carries a valid signed trust-device cookie, in
			// which case that plugin hook returns early and the session
			// (and this login) stands. We can't tell those two outcomes
			// apart without re-verifying that HMAC-signed cookie ourselves,
			// so unlike the magic-link/OAuth paths below (which have no
			// trust-device exception, so the hook there either completes
			// revoke-and-challenge or fails closed) this
			// path is left unsuppressed: it can still emit an
			// `auth.login.success` a moment before a 2FA challenge revokes
			// it. The reliable signal that a challenge was actually
			// completed remains `/two-factor/verify-totp` and
			// `/two-factor/verify-backup-code`.
			if (newSession?.user?.id) {
				recordAudit({
					action: "auth.login.success",
					category: "auth",
					actor: {
						type: "user",
						userId: newSession.user.id,
						emailSnapshot: newSession.user.email ?? null,
						nameSnapshot: newSession.user.name ?? null,
					},
					organizationId: null,
					resource: {
						type: "user",
						id: newSession.user.id,
						name: newSession.user.email ?? null,
					},
					outcome: "success",
					metadata: {
						method: authMethod,
						// Item 7 (v2): expose the same value under a clearer key.
						// `method` is preserved for backward compatibility.
						authMethod,
					},
					ipAddress: reqCtx.ipAddress,
					userAgent: reqCtx.userAgent,
					requestId: reqCtx.requestId,
					sessionId: newSession.session?.id ?? null,
				});
				return;
			}
			const attemptedEmail = ctx.body?.email as string | undefined;
			// Only attach `userId` when the email maps to a real user —
			// never invent one from an arbitrary attempt string.
			const existing = attemptedEmail
				? await deps.getUserByEmail(attemptedEmail).catch(() => null)
				: null;
			recordAudit({
				action: "auth.login.failure",
				category: "auth",
				actor: existing
					? {
							type: "user",
							userId: existing.id,
							emailSnapshot: existing.email,
							nameSnapshot: existing.name,
						}
					: { type: "system" },
				organizationId: null,
				resource: existing
					? {
							type: "user",
							id: existing.id,
							name: existing.email,
						}
					: {
							type: "user",
							id: null,
							name: attemptedEmail ?? null,
						},
				outcome: "failure",
				severity: "warning",
				metadata: {
					method: authMethod,
					authMethod,
					attemptedEmail: attemptedEmail ?? null,
				},
				ipAddress: reqCtx.ipAddress,
				userAgent: reqCtx.userAgent,
				requestId: reqCtx.requestId,
			});
			return;
		}

		// Login success for the non-password methods (SOC 2 CC7.2 — H6). Each
		// creates a new session on success; the primary /sign-in/email path is
		// handled above (with its failure branch). 2FA (/two-factor/verify-totp)
		// is handled in its own block below because it must be disambiguated
		// from MFA enrollment. Fire-and-forget: the outer try swallows errors,
		// so a missing/extra row can never affect the login itself.
		if (
			path === "/sign-in/passkey" ||
			path === "/magic-link/verify" ||
			path === "/two-factor/verify-backup-code" ||
			path?.startsWith("/callback/") ||
			path?.startsWith("/oauth2/callback/")
		) {
			// Admin impersonation creates its session via the dedicated
			// /admin/impersonate-user path (audited separately below), never via
			// these sign-in paths, so no impersonation guard is needed here.
			const newSession = ctx.context?.newSession ?? null;

			// This function's caller (auth.ts's `hooks.after`) runs — and this
			// call happens — BEFORE the 2FA-enforcement gate later in that
			// same hook body. A session that gate is about to challenge never
			// survives as an authenticated one: the hook either completes
			// revoke-and-challenge, or fails closed by stripping the browser
			// credential and nulling `newSession`. Either way this login did
			// not complete, so emitting `auth.login.success` here would record
			// a login that never happens; the real completion is recorded when
			// /two-factor/verify-totp or /two-factor/verify-backup-code
			// succeeds later.
			//
			// Predicting the gate's outcome is unavoidable given that
			// ordering, so it is predicted from the gate's OWN predicate
			// (./two-factor-gate.ts) rather than from a second, hand-copied
			// path list that would drift out of agreement with it — silently,
			// and in the direction of recording logins that were denied.
			// /two-factor/verify-backup-code falls through on its own — it IS
			// the 2FA completion step, so the gate exempts it and the
			// predicate reports it ungated. (/sign-in/passkey above is a dead
			// branch: the passkey plugin registers
			// /passkey/verify-authentication, so nothing ever reaches it.)
			if (
				isChallengeGatedMint({
					path,
					newSession,
					activeSession: ctx.context?.session ?? null,
				})
			) {
				return;
			}

			if (newSession?.user?.id) {
				recordAudit({
					action: "auth.login.success",
					category: "auth",
					actor: {
						type: "user",
						userId: newSession.user.id,
						emailSnapshot: newSession.user.email ?? null,
						nameSnapshot: newSession.user.name ?? null,
					},
					organizationId: null,
					resource: {
						type: "user",
						id: newSession.user.id,
						name: newSession.user.email ?? null,
					},
					outcome: "success",
					metadata: { method: authMethod, authMethod },
					ipAddress: reqCtx.ipAddress,
					userAgent: reqCtx.userAgent,
					requestId: reqCtx.requestId,
					sessionId: newSession.session?.id ?? null,
				});
			}
			return;
		}

		// /verify-email with `autoSignInAfterVerification: true` mints a real,
		// durable session for a non-2FA user, so it must produce a login row
		// (SOC 2 missing-event gap otherwise). Two suppressions keep it from
		// over-reporting, and both are asked of ./two-factor-gate.ts rather
		// than re-derived here, so this branch and the gate can never disagree
		// about the same request:
		//  - `isFreshSessionMint` — did a login actually happen? The same
		//    endpoint also runs for an already-signed-in user completing an
		//    email change, where Better Auth's setSessionCookie repopulates
		//    `newSession` with the *incoming* session (`ctx.context.session`
		//    is resolved by the endpoint itself on this path, unlike the
		//    sign-in paths above). Equal tokens mean no login happened.
		//  - `!isChallengeGatedMint` — will that login survive? A
		//    `twoFactorEnabled` user's fresh mint is revoked moments later by
		//    the deny-by-default gate, which runs after this call in the same
		//    `hooks.after` body; the completing event for that user is the
		//    later /two-factor/verify-* row.
		//
		// Together they read as "a session was really minted here, and the
		// gate is going to let it stand" — the same two questions the
		// login-success branch above asks, through the same predicate.
		if (path === "/verify-email") {
			const newSession = ctx.context?.newSession ?? null;
			if (
				newSession?.user?.id &&
				isFreshSessionMint(newSession, sessionLike) &&
				!isChallengeGatedMint({
					path,
					newSession,
					activeSession: sessionLike,
				})
			) {
				recordAudit({
					action: "auth.login.success",
					category: "auth",
					actor: {
						type: "user",
						userId: newSession.user.id,
						emailSnapshot: newSession.user.email ?? null,
						nameSnapshot: newSession.user.name ?? null,
					},
					organizationId: null,
					resource: {
						type: "user",
						id: newSession.user.id,
						name: newSession.user.email ?? null,
					},
					outcome: "success",
					metadata: { method: authMethod, authMethod },
					ipAddress: reqCtx.ipAddress,
					userAgent: reqCtx.userAgent,
					requestId: reqCtx.requestId,
					sessionId: newSession.session?.id ?? null,
				});
			}
			return;
		}

		if (path === "/sign-out" && sessionLike?.user?.id) {
			recordAudit({
				action: "auth.logout",
				category: "auth",
				actor: {
					type: "user",
					userId: sessionLike.user.id,
					emailSnapshot: sessionLike.user.email ?? null,
					nameSnapshot: sessionLike.user.name ?? null,
				},
				organizationId: null,
				resource: {
					type: "user",
					id: sessionLike.user.id,
					name: sessionLike.user.email ?? null,
				},
				ipAddress: reqCtx.ipAddress,
				userAgent: reqCtx.userAgent,
				requestId: reqCtx.requestId,
				sessionId,
			});
			return;
		}

		if (
			(path === "/change-password" || path === "/reset-password") &&
			sessionLike?.user?.id
		) {
			recordAudit({
				action: "auth.password.changed",
				category: "auth",
				actor: {
					type: "user",
					userId: sessionLike.user.id,
					emailSnapshot: sessionLike.user.email ?? null,
					nameSnapshot: sessionLike.user.name ?? null,
				},
				organizationId: null,
				resource: {
					type: "user",
					id: sessionLike.user.id,
					name: sessionLike.user.email ?? null,
				},
				metadata: {
					via: path === "/change-password" ? "in-app" : "reset",
				},
				ipAddress: reqCtx.ipAddress,
				userAgent: reqCtx.userAgent,
				requestId: reqCtx.requestId,
				sessionId,
			});
			return;
		}

		if (path === "/two-factor/verify-totp") {
			const newSession = ctx.context?.newSession ?? null;

			// ENROLMENT is identified by the state of the `two_factor` row
			// BEFORE this call, stashed on the ctx by the step-up lockout's
			// before hook (./two-factor-step-up-lockout.ts). Nothing observable
			// afterwards can tell the two apart: the endpoint flips the row to
			// verified on its way out (`totp/index.mjs:158-176`), so a read here
			// says "verified" for both, and it ALSO rotates the session on that
			// branch, so `newSession` is set for a genuine enrolment too.
			//
			// Getting this wrong is not cosmetic. Before this check, every
			// already-signed-in verification with no new session was recorded as
			// `auth.mfa.enabled` — which is exactly what a step-up verification
			// is, so with #2827 in place every disable, secret rotation and
			// backup-code regeneration would have logged an MFA ENROLMENT
			// immediately before it.
			const wasEnrolling =
				readStepUpFactorPreState((ctx.context ?? {}) as object)
					?.verified === false &&
				isStepUpSuccessResponse(ctx.context?.returned);

			if (wasEnrolling && sessionLike?.user?.id) {
				recordAudit({
					action: "auth.mfa.enabled",
					category: "auth",
					actor: {
						type: "user",
						userId: sessionLike.user.id,
						emailSnapshot: sessionLike.user.email ?? null,
						nameSnapshot: sessionLike.user.name ?? null,
					},
					organizationId: null,
					resource: {
						type: "user",
						id: sessionLike.user.id,
						name: sessionLike.user.email ?? null,
					},
					metadata: { method: "totp" },
					ipAddress: reqCtx.ipAddress,
					userAgent: reqCtx.userAgent,
					requestId: reqCtx.requestId,
					sessionId,
				});
				return;
			}

			if (newSession?.user?.id) {
				// A new session at verify-totp means a 2FA-GATED LOGIN just
				// completed. This is the reliable login-success signal for
				// TOTP users on the magic-link/OAuth paths (the premature row
				// on those paths is suppressed above) and, usually, for
				// /sign-in/email — except when a valid trust-device cookie
				// lets /sign-in/email's own Better Auth hook skip the
				// challenge entirely, in which case that path's row already
				// fired and this one never will (see the /sign-in/email
				// branch above for why that case isn't suppressed). Previously
				// miscoded as `auth.mfa.enabled`, which mislabeled every 2FA
				// login as an enrollment (SOC 2 CC7.2 — H6).
				recordAudit({
					action: "auth.login.success",
					category: "auth",
					actor: {
						type: "user",
						userId: newSession.user.id,
						emailSnapshot: newSession.user.email ?? null,
						nameSnapshot: newSession.user.name ?? null,
					},
					organizationId: null,
					resource: {
						type: "user",
						id: newSession.user.id,
						name: newSession.user.email ?? null,
					},
					outcome: "success",
					metadata: { method: "2fa_totp", authMethod: "2fa_totp" },
					ipAddress: reqCtx.ipAddress,
					userAgent: reqCtx.userAgent,
					requestId: reqCtx.requestId,
					sessionId: newSession.session?.id ?? null,
				});
			}
			// Anything else on this path is a STEP-UP verification: an already
			// signed-in user re-proving their factor before a sensitive action.
			// It changes no state of its own, so it gets no row here — the
			// action it authorizes records its own.
			return;
		}

		if (
			path === "/two-factor/disable" &&
			sessionLike?.user?.id &&
			// Better Auth runs `hooks.after` even when the endpoint threw, so a
			// path check alone recorded `auth.mfa.disabled` for calls that
			// disabled nothing — a wrong password, a stale session, and (since
			// #2827) a missing step-up grant all produced a phantom row saying
			// the user's second factor had been removed.
			!isAPIError(ctx.context?.returned)
		) {
			recordAudit({
				action: "auth.mfa.disabled",
				category: "auth",
				actor: {
					type: "user",
					userId: sessionLike.user.id,
					emailSnapshot: sessionLike.user.email ?? null,
					nameSnapshot: sessionLike.user.name ?? null,
				},
				organizationId: null,
				resource: {
					type: "user",
					id: sessionLike.user.id,
					name: sessionLike.user.email ?? null,
				},
				metadata: { method: "totp" },
				ipAddress: reqCtx.ipAddress,
				userAgent: reqCtx.userAgent,
				requestId: reqCtx.requestId,
				sessionId,
			});
			return;
		}

		if (path === "/admin/impersonate-user" && sessionLike?.user?.id) {
			const targetUserId = ctx.body?.userId as string | undefined;
			recordAudit({
				action: "auth.impersonation.started",
				category: "auth",
				actor: {
					type: "user",
					userId: sessionLike.user.id,
					emailSnapshot: sessionLike.user.email ?? null,
					nameSnapshot: sessionLike.user.name ?? null,
					impersonatedById: sessionLike.user.id,
				},
				organizationId: null,
				resource: {
					type: "user",
					id: targetUserId ?? null,
					name: null,
				},
				metadata: { targetUserId: targetUserId ?? null },
				severity: "warning",
				ipAddress: reqCtx.ipAddress,
				userAgent: reqCtx.userAgent,
				requestId: reqCtx.requestId,
				sessionId,
			});
			return;
		}

		if (path === "/admin/stop-impersonating" && sessionLike?.user?.id) {
			recordAudit({
				action: "auth.impersonation.ended",
				category: "auth",
				actor: {
					type: "user",
					userId: sessionLike.user.id,
					emailSnapshot: sessionLike.user.email ?? null,
					nameSnapshot: sessionLike.user.name ?? null,
				},
				organizationId: null,
				resource: {
					type: "user",
					id: sessionLike.user.id,
					name: sessionLike.user.email ?? null,
				},
				ipAddress: reqCtx.ipAddress,
				userAgent: reqCtx.userAgent,
				requestId: reqCtx.requestId,
				sessionId,
			});
			return;
		}
	} catch (err) {
		// Audit emission must never break the auth flow (D9). Log and
		// continue — the helper itself is also fire-and-forget, but the
		// path branching above could throw on unexpected ctx shapes.
		logger.warn("[Auth] audit-log emission failed; continuing", {
			path: (ctx as { path?: string }).path,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
