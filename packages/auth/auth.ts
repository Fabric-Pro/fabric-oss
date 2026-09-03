import { seedDefaultMcpConfigsForTenant } from "@repo/agent-core/backend";
import { config } from "@repo/config";
import {
	db,
	getInvitationById,
	getPurchasesByOrganizationId,
	getPurchasesByUserId,
	getUserByEmail,
	recordAudit,
	recordAuditDurable,
} from "@repo/database";
import type { Locale } from "@repo/i18n";
import { logAuditEvent, logger } from "@repo/logs";
import { sendEmail } from "@repo/mail";
import { cancelSubscription } from "@repo/payments";
import { getTemporalClient } from "@repo/temporal";
import { encryptApiKey, getBaseUrl, isEncryptedApiKey } from "@repo/utils";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import {
	admin,
	magicLink,
	openAPI,
	organization,
	username,
} from "better-auth/plugins";
import { parse as parseCookies } from "cookie";
import { jwtVerify } from "jose";
import { emitAuthAuditEvent } from "./lib/audit-events";
import { validateAuthBootEnv } from "./lib/boot-validate";
import { checkLoginAllowed } from "./lib/brute-force";
import { getTrustedClientIpFromRequest } from "./lib/client-ip";
import { withEmailVerificationCallback as buildConfirmEmailUrl } from "./lib/email-verification-callback";
import {
	isEmailChangeRevoked,
	isEmailVerifyJWTBlocked,
} from "./lib/email-verify-blocklist";
import { ensureUserHasOrganization } from "./lib/ensure-user-organization";
import { buildInvitationToken } from "./lib/invitation-token";
import { runInviteReconciliationForUser } from "./lib/invite-reconciliation";
import {
	revokeDepartingMemberAccess,
	syncSeatsAfterDeparture,
} from "./lib/member-offboarding";
import { notifySignupAttempt } from "./lib/notify-signup-attempt";
import { updateSeatsInOrganizationSubscription } from "./lib/organization";
import {
	createPasskeyPlugin,
	patchPasskeyAuthOptionsUserVerification,
} from "./lib/passkey-policy";
import {
	assertPasswordStrength,
	PasswordTooWeakError,
} from "./lib/password-strength";
import { seedSessionOrganization } from "./lib/seed-session-organization";
import { socialProviders } from "./lib/social-providers";
import { buildTrustedOrigins } from "./lib/trusted-origins";
import { verifyTurnstileToken } from "./lib/turnstile";
import { createTwoFactorChallenge } from "./lib/two-factor-challenge";
import {
	isChallengeGatedMint,
	safeChallengeRedirectPath,
} from "./lib/two-factor-gate";
import {
	createPrismaStepUpGrantStore,
	recordStepUpGrantOutcome,
	requireStepUpGrant,
} from "./lib/two-factor-management-step-up";
import {
	createTwoFactorPlugin,
	isTwoFactorAccountLockedError,
} from "./lib/two-factor-policy";
import {
	createPrismaStepUpLockoutStore,
	enforceStepUpLockout,
	recordStepUpVerificationOutcome,
} from "./lib/two-factor-step-up-lockout";
import { invitationOnlyPlugin } from "./plugins/invitation-only";

validateAuthBootEnv();

/**
 * Backing store for the step-up 2FA lockout (issue #2819). Built once: it is
 * stateless and holds only the Prisma client the adapter already uses.
 */
const stepUpLockoutDeps = {
	store: createPrismaStepUpLockoutStore(db),
};

/**
 * Backing store for the server-enforced step-up on the 2FA MANAGEMENT
 * endpoints (issue #2827). Built once, for the same reason as above.
 */
const stepUpGrantDeps = {
	store: createPrismaStepUpGrantStore(db),
};

const getLocaleFromRequest = (request?: Request) => {
	const cookies = parseCookies(request?.headers.get("cookie") ?? "");
	return (
		(cookies[config.i18n.localeCookieName] as Locale) ??
		config.i18n.defaultLocale
	);
};

const appUrl = getBaseUrl();

// Rewrites Better Auth's `/verify-email` API links into links to the app's
// confirm-email page. The URL shapes live in ./lib/email-verification-callback
// so they can be unit-tested without booting Better Auth; this binds them to
// this deployment's origin and default landing path.
const withEmailVerificationCallback = (url: string) =>
	buildConfirmEmailUrl(url, {
		appUrl,
		defaultRedirect: config.auth.redirectAfterSignIn,
	});

const trustedOrigins = buildTrustedOrigins(process.env, appUrl);

/**
 * Fields removed from `ctx` before logging an auth API error. Prevents
 * plaintext passwords / verification tokens / CAPTCHA tokens from reaching
 * the log aggregator via the onAPIError logger.
 */
const SENSITIVE_CTX_BODY_FIELDS = [
	"password",
	"newPassword",
	"currentPassword",
	"confirmPassword",
	"token",
	"otp",
	"code",
	"backupCode",
	"captchaToken",
] as const;

function scrubAuthCtxForLogging(ctx: unknown): unknown {
	if (!ctx || typeof ctx !== "object") {
		return ctx;
	}

	const source = ctx as Record<string, unknown>;
	const body =
		source.body && typeof source.body === "object"
			? { ...(source.body as Record<string, unknown>) }
			: source.body;

	if (body && typeof body === "object") {
		for (const field of SENSITIVE_CTX_BODY_FIELDS) {
			if (field in (body as Record<string, unknown>)) {
				(body as Record<string, unknown>)[field] = "[REDACTED]";
			}
		}
	}

	return {
		path: source.path,
		method: source.method,
		body,
	};
}

/**
 * Extract the client IP from a request using only headers set by trusted
 * ingress proxies. See `./lib/client-ip.ts` for details on why reading the
 * first hop of `X-Forwarded-For` directly is unsafe.
 */
function getClientIp(request: Request): string {
	return getTrustedClientIpFromRequest(request);
}

// Audit-log emission helpers for `hooks.after` are
// implemented in `./lib/audit-events.ts` so the branching logic is
// unit-testable without booting Better Auth. The organizationHooks below
// emit `recordAudit` directly because they receive structured event
// objects rather than a raw ctx.

const authOptions = {
	baseURL: appUrl,
	trustedOrigins,
	appName: config.appName,
	database: prismaAdapter(db, {
		provider: "postgresql",
	}),
	advanced: {
		database: {
			generateId: false,
		},
		cookiePrefix: config.auth.cookiePrefix,
	},
	session: {
		expiresIn: config.auth.sessionCookieMaxAge,
		cookieCache: {
			enabled: true,
			maxAge: 5 * 60,
		},
		// Non-zero freshAge gates the endpoints that use Better Auth's
		// `freshSessionMiddleware` behind a recent authentication instead of
		// trusting any 30-day-old session. In 1.6.22 that is exactly one route,
		// `/delete-user` (`dist/api/routes/account.mjs:200`).
		//
		// It does NOT cover the 2FA management endpoints. Those use
		// `sensitiveSessionMiddleware`, which is a different control: it
		// re-reads the session from the server-side store with the cookie cache
		// bypassed (`dist/api/routes/session.mjs:307-313,328-335`) so a revoked
		// session cannot authorize the call, and never looks at session age.
		// Second-factor freshness on `/two-factor/*` comes from the step-up
		// grant in ./lib/two-factor-management-step-up.ts instead.
		freshAge: 60 * 10,
	},
	account: {
		// SOC 2 CC6.1/CC6.7 — encrypt OAuth access & refresh tokens at rest in
		// the Account table. Better Auth encrypts on write and passes pre-existing
		// plaintext rows through on read (isLikelyEncrypted heuristic), so this is
		// a zero-downtime in-place migration; Fabric only ever reads these columns
		// through Better Auth's own APIs. NOTE: this flag does not cover
		// Account.idToken (a signed JWT) — that column is encrypted by the
		// account databaseHooks below (register E10).
		encryptOAuthTokens: true,
		// Require the provider to return a verified email before linking to an
		// existing account. `trustedProviders` would short-circuit that check
		// and allow takeover via an unverified Google/GitHub secondary email.
		accountLinking: {
			enabled: true,
		},
	},
	databaseHooks: {
		account: {
			// SOC 2 CC6.1 (register E10): encrypt Account.idToken at rest. Better
			// Auth's `encryptOAuthTokens` covers access/refresh but stores the
			// OIDC ID token raw. Verified against the installed Better Auth source
			// and Fabric code that the STORED idToken is never read back
			// (`parseAccountOutput` strips it; only fresh provider-response tokens
			// are decoded), so encrypting the column is write-only-safe and needs
			// no decrypt path. Uses the shared rotation-aware primitive; the
			// isEncryptedApiKey guard makes the hook idempotent. Fails open (store
			// as received) so an encryption misconfiguration can never break
			// sign-in — every other encrypt site already fails loudly.
			create: {
				before: async (account) => {
					if (
						typeof account.idToken === "string" &&
						account.idToken.length > 0 &&
						!isEncryptedApiKey(account.idToken)
					) {
						try {
							return {
								data: {
									idToken: encryptApiKey(account.idToken),
								},
							};
						} catch (error) {
							logger.error(
								"[Auth] Failed to encrypt idToken on account create — storing as received:",
								error,
							);
						}
					}
					return undefined;
				},
			},
			update: {
				before: async (account) => {
					if (
						typeof account.idToken === "string" &&
						account.idToken.length > 0 &&
						!isEncryptedApiKey(account.idToken)
					) {
						try {
							return {
								data: {
									idToken: encryptApiKey(account.idToken),
								},
							};
						} catch (error) {
							logger.error(
								"[Auth] Failed to encrypt idToken on account update — storing as received:",
								error,
							);
						}
					}
					return undefined;
				},
			},
		},
		user: {
			create: {
				after: async (user) => {
					// Send welcome email for OAuth/magic-link signups where email
					// is already verified at creation time. Email+password signups
					// with verification required receive the welcome email via
					// afterEmailVerification instead.
					if (user.emailVerified) {
						try {
							const locale =
								(user.locale as Locale) ??
								config.i18n.defaultLocale;
							const docsUrl = `${appUrl.replace(/\/+$/, "")}/docs/getting-started/overview`;
							const sent = await sendEmail({
								to: user.email,
								templateId: "welcome",
								context: {
									name: user.name || user.email.split("@")[0],
									docsUrl,
								},
								locale,
							});
							if (sent) {
								// Only mark welcome email as sent after successful
								// delivery so afterEmailVerification won't send a
								// duplicate, but failures still allow retry.
								await db.user.update({
									where: { id: user.id },
									data: { welcomeEmailSentAt: new Date() },
								});
								logger.info(
									`[Auth] Welcome email sent to ${user.email} (pre-verified signup)`,
								);
							} else {
								logger.warn(
									`[Auth] Welcome email could not be sent to ${user.email}`,
								);
							}
						} catch (error) {
							logger.error(
								"[Auth] Failed to send welcome email for pre-verified signup:",
								error,
							);
						}
					}

					// Resolve pending org/project invitations matching this
					// email (magic-link/OAuth signups arrive pre-verified).
					// The wrapper gates on emailVerified internally and never
					// throws — email+password creates skip here and are
					// covered at verification time instead.
					await runInviteReconciliationForUser({
						userId: user.id,
						trigger: "user_create",
					});

					// AFTER reconciliation, never before: an invited user
					// already belongs somewhere by this point and must not be
					// handed a second, empty organization (FR1a). A password
					// signup's invitations are not resolved yet, which is why
					// the same call is made again on session creation — the
					// helper is idempotent and asks whether they belong
					// anywhere, not whether they were just created.
					const autoCreated = await ensureUserHasOrganization(
						user.id,
						seedDefaultMcpConfigsForTenant,
					);

					// Nothing is seeded personally, not even as a fallback.
					//
					// `ensureUserHasOrganization` seeds the organization it
					// creates, which is the normal path. When it could not make
					// one, this used to seed personally instead, reasoning that
					// a signup ending with neither tenant seeded was the worse
					// regression. That traded one bad state for the exact state
					// this epic exists to remove — a user with personal rows and
					// no organization is the personal environment, whatever it
					// is called.
					//
					// The trade is unnecessary, because the failure heals
					// itself: this same helper runs on every session create, so
					// the next sign-in makes the organization AND seeds it. What
					// the user loses in between is default MCP configs on a
					// signup whose organization creation already failed — and
					// they were about to hit that failure anyway.
					// Only the failure is worth a line. "Already had one" is the
					// normal shape for an invited user, and warning on it fired
					// on every invited signup with a message that was false in
					// both halves — they have an organization, and nothing will
					// seed on their next sign-in either.
					if (autoCreated.outcome === "failed") {
						logger.warn(
							"[Auth] No organization for new user; MCP defaults will seed on their next sign-in",
							{ userId: user.id, reason: autoCreated.reason },
						);
					}
				},
			},
		},
		session: {
			create: {
				after: async (session) => {
					// An admin impersonating a user must never trigger
					// membership grants, seat changes, or audit rows for the
					// impersonated user; skip reconciliation for impersonation
					// sessions (the user's own later sign-in heals them).
					if (session.impersonatedBy) {
						return;
					}
					// Sign-in self-heal: resolve pending invitations for the
					// user's (verified) email on every session creation —
					// covers pre-existing stuck users, CLI-created users, and
					// the project-invite inline-signup path. Idempotent, so
					// repeated fires (2FA session re-creation, admin
					// impersonation) are safe by design; never throws.
					await runInviteReconciliationForUser({
						userId: session.userId,
						trigger: "session_create",
					});

					// The same self-heal, for the same reason reconciliation
					// runs here: a password signup's invitations resolve at
					// this point, and an account created before organizations
					// were guaranteed has none at all. Both get one here, and
					// a user who already belongs somewhere is untouched.
					await ensureUserHasOrganization(
						session.userId,
						seedDefaultMcpConfigsForTenant,
					);

					// Give the session the organization it runs in. This field
					// was only ever written by an explicit organization switch,
					// so a user who signed in and never switched carried none —
					// and everything that falls back to it fell back to
					// nothing. Extracted so the rule is testable without
					// booting Better Auth, and so its reasoning lives beside
					// it.
					await seedSessionOrganization(session);
				},
			},
		},
	},
	hooks: {
		after: createAuthMiddleware(async (ctx) => {
			// Audit-log emission for auth events.
			// Delegated to `./lib/audit-events.emitAuthAuditEvent` so the
			// branching logic is unit-testable without booting Better Auth.
			// Fire-and-forget — the helper swallows its own errors.
			//
			// F-1102 coordination: emits `auth.mfa.enabled` /
			// `auth.mfa.disabled`. The closed audit-action taxonomy lives
			// in docs/audit-log/architecture.md.
			void emitAuthAuditEvent(
				ctx as unknown as Parameters<typeof emitAuthAuditEvent>[0],
				{ getUserByEmail: (email) => getUserByEmail(email) },
			);

			// Step-up 2FA lockout (issue #2819): score the verification this
			// request just performed. The failure branch deliberately has no
			// try/catch — see ./lib/two-factor-step-up-lockout.ts. Placed after
			// the audit emission above so a store failure cannot suppress the
			// audit record for the same request.
			await recordStepUpVerificationOutcome(ctx, stepUpLockoutDeps);

			// Step-up grant for the 2FA MANAGEMENT endpoints (issue #2827):
			// mint one when this request was a successful step-up
			// verification, or settle the one the before hook spent when it
			// was a management call. Runs AFTER the lockout scoring above,
			// which owns the row this reads its pre-state from. Never
			// throws — see ./lib/two-factor-management-step-up.ts.
			await recordStepUpGrantOutcome(
				ctx as unknown as Parameters<
					typeof recordStepUpGrantOutcome
				>[0],
				stepUpGrantDeps,
			);

			// Structured security log for the account-level 2FA lockout
			// (better-auth's `accountLockout`, packages/auth/lib/two-factor-policy.ts).
			// This can't live in `onAPIError.onError`: better-auth's dispatch
			// (`dist/api/dispatch.mjs`) catches an endpoint-thrown APIError,
			// serializes it straight into the HTTP response via `toResponse`,
			// and returns it — it never rethrows on the HTTP path, so the
			// router's catch (and therefore `onAPIError.onError`) never runs
			// for this error class over real requests. A direct server-side
			// `auth.api.*` call rethrows the APIError to its caller instead —
			// so neither path reaches `onAPIError`. `runAfterHooks` (this
			// hook) runs unconditionally after that capture, with
			// `ctx.context.returned` set to the endpoint's response —
			// including an APIError — so this is the point that actually
			// observes it on every real request. Try/catch guards it: a
			// logging bug here must never affect the auth response the
			// caller already has.
			try {
				if (
					(ctx.path === "/two-factor/verify-totp" ||
						ctx.path === "/two-factor/verify-otp" ||
						ctx.path === "/two-factor/verify-backup-code") &&
					isTwoFactorAccountLockedError(
						(ctx.context as unknown as { returned?: unknown })
							.returned,
					)
				) {
					logger.warn(
						{
							event: "auth.2fa.account_locked",
							security: true,
							path: ctx.path,
						},
						"2FA verification rejected: account temporarily locked",
					);
				}
			} catch (error) {
				logger.error(
					"[Auth] Failed to emit 2FA account-lockout log:",
					error,
				);
			}

			// Note: brute force lockout clearing after password reset is handled
			// at the Hono middleware level in packages/api/index.ts because
			// Better Auth's reset-password response ({status:true}) doesn't
			// include the user email, and the verification token is deleted
			// before the after hook runs. The Hono handler looks up the email
			// from the verification table before auth.handler processes the request.

			// Passkey sign-in options: rewrite the plugin's hardcoded
			// `userVerification: "preferred"` hint to "required" so browsers
			// prompt for PIN/biometric up front. UX companion to the
			// server-side enforcement in ./lib/passkey-policy.ts.
			if (ctx.path === "/passkey/generate-authenticate-options") {
				patchPasskeyAuthOptionsUserVerification(
					(ctx.context as unknown as { returned?: unknown }).returned,
				);
			}

			// 2FA enforcement, deny-by-default (issue #2825).
			//
			// Better Auth's built-in twoFactor() plugin challenges only
			// /sign-in/{email,username,phone-number}. Every OTHER endpoint that
			// mints a session hands a `twoFactorEnabled` user a fully
			// authenticated session with no second factor: magic link (email
			// compromise), an OAuth callback, an email-verification link
			// (issue #2805) — and whatever the next better-auth release adds.
			// This hook used to enumerate the paths to challenge, so each one
			// had to be discovered one incident at a time while every path
			// nobody had thought of failed open, silently.
			//
			// The gate therefore fires on EVERY path, and the paths allowed to
			// mint without a factor are enumerated instead — in
			// ./lib/two-factor-gate.ts, each with the reason it is safe. The
			// failure mode inverts with it: an endpoint nobody classified
			// over-challenges a 2FA user, who sees a code prompt and completes
			// it, rather than skipping their second factor invisibly.
			//
			// The challenge replicates the plugin's own: delete the just-created
			// session, stash the userId behind a signed cookie + verification
			// row, and send the caller to /auth/verify.
			const newSession = (ctx.context as any).newSession as
				| {
						session: { token: string };
						user: {
							id: string;
							twoFactorEnabled?: boolean | null;
						};
				  }
				| null
				| undefined;
			// The session the endpoint resolved from the request's own cookie
			// (`getSessionFromCtx` populates this, or sets an explicit null).
			// Comparing its token against the one just installed is what
			// separates a MINT from a refresh: `setSessionCookie` — and
			// therefore `setNewSession` — also fires when an endpoint merely
			// rewrites the cookie for a session the request already carried (a
			// /verify-email address change, an /organization/set-active switch,
			// a sliding-expiry bump), and challenging those would log
			// signed-in users out mid-flow.
			const activeSession = (ctx.context as any).session as
				| { session?: { token?: string } }
				| null
				| undefined;

			// `newSession &&` is here only to narrow the type for the branch
			// body; the predicate tests it too, so the two cannot disagree.
			if (
				newSession &&
				isChallengeGatedMint({
					path: ctx.path,
					newSession,
					activeSession,
				})
			) {
				// Compute the redirect target first, then `throw ctx.redirect(...)`
				// once below. Keeping the redirect outside the try/catch means
				// we don't have to pattern-match on `error.status === 302` to
				// tell control-flow redirects apart from real failures.
				let redirectTarget: string;
				// Set only once the challenge is fully in place (both
				// verification rows written, signed cookie set). The failure
				// path leaves it false and answers with containment instead.
				let challengeIssued = false;

				// Recover the original post-login target:
				//  - magic-link carries `callbackURL` in the query
				//  - OAuth /callback/* consumes the state row before this hook
				//    runs, so it's gone from query/body. But Better Auth's
				//    handler ended with `throw ctx.redirect(...)`, and the
				//    dispatcher assigns that response's headers to
				//    `ctx.context.responseHeaders` before it runs this hook
				//    (`dist/api/dispatch.mjs`), so the target is still readable.
				//
				// TOTAL by construction, and it has to be: this runs BEFORE the
				// containment block below, so anything that throws here escapes
				// with the session cookie still live and `newSession` still set
				// — the exact fail-open this gate exists to remove. Neither
				// `ctx.query` nor `ctx.body` is validated by better-auth for
				// endpoints that declare no schema, so `callbackURL` can be any
				// JSON value; a non-string is treated as absent rather than
				// being handed to a string method. The whole read is wrapped
				// because a future ctx could expose these as throwing getters.
				let rawNavigationTarget: string | undefined;
				try {
					const fromQuery = (
						ctx.query as { callbackURL?: unknown } | undefined
					)?.callbackURL;
					const fromBody = (
						ctx.body as { callbackURL?: unknown } | undefined
					)?.callbackURL;
					const fromLocation = (
						ctx.context as { responseHeaders?: Headers }
					).responseHeaders?.get("location");
					rawNavigationTarget =
						typeof fromQuery === "string"
							? fromQuery
							: typeof fromBody === "string"
								? fromBody
								: typeof fromLocation === "string"
									? fromLocation
									: undefined;
				} catch {
					rawNavigationTarget = undefined;
				}
				// Redirect-vs-JSON is a property of the REQUEST, not of the
				// path. A caller that supplied a navigation target — or an
				// endpoint that already answered with one — is a browser
				// following a link, and gets the 302. A caller that did
				// neither is an XHR, and `fetch` follows a 302 transparently:
				// redirecting one reaches the component as a failed request
				// and strands the user with a live challenge cookie and no OTP
				// form. Those get the JSON shape Better Auth's own two-factor
				// plugin returns from its /sign-in/email after-hook
				// (`dist/plugins/two-factor/index.mjs`), which our clients
				// already understand — `runAfterHooks` installs a
				// hook-returned response as the final response
				// (`dist/api/dispatch.mjs`), carrying the cookie changes made
				// below with it.
				//
				// Only the SHAPE is decided out here, from a value that cannot
				// throw. Sanitizing that target — the part with real parsing in
				// it — happens inside the containment block.
				const isNavigationRequest = rawNavigationTarget !== undefined;
				const authCtx = ctx.context as {
					internalAdapter: {
						createVerificationValue: (
							value: {
								value: string;
								identifier: string;
								expiresAt: Date;
							},
							ctx: unknown,
						) => Promise<unknown>;
						deleteSession: (token: string) => Promise<unknown>;
					};
					createAuthCookie: (
						name: string,
						opts?: { maxAge?: number },
					) => {
						name: string;
						attributes: Record<string, unknown>;
					};
					secret: string;
				};
				// `deleteSessionCookie` wants better-auth's
				// `GenericEndpointContext`. At runtime `ctx` IS that shape
				// — better-auth's own 2FA hook passes its middleware ctx
				// to this same helper — but the two differ structurally
				// once TypeScript instantiates the plugin-registry
				// generics, and they instantiate differently depending on
				// which package is doing the checking: `@repo/auth`'s own
				// type-check accepts the bare `ctx`, while `@repo/web`
				// re-checks this file under its own config and rejects it.
				// Narrowed here once, so both call sites below agree and
				// neither package's type-check depends on the other's
				// generic resolution.
				const cookieCtx = ctx as unknown as Parameters<
					typeof deleteSessionCookie
				>[0];
				const hookCtx = ctx as unknown as {
					setSignedCookie: (
						name: string,
						value: string,
						secret: string,
						attributes: Record<string, unknown>,
					) => Promise<void>;
				};

				try {
					const maxAgeSeconds = 3 * 60;

					// Revoke first, create challenge state second — so the
					// steps below that can reject (the session delete,
					// either verification-row write, the signed-cookie
					// write) fail CLOSED rather than open.
					// `deleteSessionCookie(ctx, true)` is Better Auth's own
					// helper (`better-auth/cookies`, a declared public
					// export — not a `dist/` deep-import): it expires
					// `session_token` and `session_data` (including any
					// chunked `session_data.N` cookies) and, critically,
					// first *removes* their still-valid `set-cookie`
					// entries from the response instead of merely appending
					// an expiring one alongside them — a raw-header
					// consumer (proxy, log pipeline, non-browser client)
					// that doesn't apply "last Set-Cookie for a name wins"
					// semantics would otherwise still see a replayable
					// session pair. `true` preserves the `dont_remember`
					// cookie, matching Better Auth's own 2FA challenge hook
					// (`dist/plugins/two-factor/index.mjs`) — the later
					// verification flow reads it to decide session
					// persistence, so clearing it here would silently
					// change "remember me" behavior.
					//
					// The happy path calls this once. Any exception from
					// the remaining statements in this `try` causes
					// `catch` to call it again.
					// The repeat is intentional and idempotent.
					deleteSessionCookie(cookieCtx, true);

					// Deliberately ordered BEFORE the awaited
					// `deleteSession()` below — this intentionally
					// differs from Better Auth's own challenge hook
					// (`dist/plugins/two-factor/index.mjs`), which does
					// deleteSessionCookie -> deleteSession ->
					// setNewSession(null), in that order. Upstream's
					// order is safe there because that hook isn't wrapped
					// in a try/catch: nothing downstream can observe
					// `newSession` between those two calls. Ours is — if
					// `deleteSession()` rejects, control jumps to `catch`
					// below, and Better Auth's dispatcher
					// (`dist/api/dispatch.mjs`'s `runAfterHooks`) converts
					// our thrown redirect into a hook result and keeps
					// running any later plugin `after` hooks, which could
					// still read `ctx.context.newSession` — so it must
					// already be null by the time `deleteSession()` can
					// fail. Called directly on `ctx.context`, not through
					// the `authCtx` cast: Better Auth's `AuthContext`
					// guarantees this method (see create-context.mjs), so
					// an optional call would only hide real API drift.
					ctx.context.setNewSession(null);

					await authCtx.internalAdapter.deleteSession(
						newSession.session.token,
					);

					// createTwoFactorChallenge() writes BOTH the challenge
					// row and its companion `2fa-attempts-<identifier>`
					// budget row. Better Auth 1.6.22's
					// `verifyTwoFactor().beginAttempt()` consumes that
					// attempts row to enforce the retry cap — but only
					// for an unauthenticated sign-in submission
					// (`dist/plugins/two-factor/totp/index.mjs`:
					// `isSignIn ? await beginAttempt(5) : null` — exactly
					// the case this challenge sets up); without the row,
					// it throws UNAUTHORIZED / INVALID_TWO_FACTOR_COOKIE
					// before the submitted code is ever compared. See
					// ./lib/two-factor-challenge.ts for the full
					// explanation and the better-auth source references.
					const { identifier } = await createTwoFactorChallenge({
						internalAdapter: authCtx.internalAdapter,
						userId: newSession.user.id,
						maxAgeSeconds,
						ctx,
					});

					const cookieConfig = authCtx.createAuthCookie(
						"two_factor",
						{
							maxAge: maxAgeSeconds,
						},
					);
					await hookCtx.setSignedCookie(
						cookieConfig.name,
						identifier,
						authCtx.secret,
						cookieConfig.attributes,
					);

					// Sanitized HERE, inside containment, and deliberately not
					// alongside the shape decision above: nothing validated
					// that target, and deny-by-default now reads it on paths
					// that carry no `originCheck` middleware of their own, so
					// an attacker-chosen `callbackURL` on any gated request
					// would otherwise ride through the challenge page and out
					// to their origin. The sanitizer is total over `unknown`
					// and documented never to throw — running it after the
					// revocation above means that even if that ever stopped
					// being true, the session is already gone.
					//
					// A rejected target still leaves a navigation a
					// navigation; it just loses the param.
					const redirectTo = safeChallengeRedirectPath(
						rawNavigationTarget,
						appUrl,
					);
					const verifyUrl = new URL("/auth/verify", appUrl);
					if (redirectTo) {
						verifyUrl.searchParams.set("redirectTo", redirectTo);
					}

					redirectTarget = verifyUrl.toString();
					challengeIssued = true;
				} catch (error) {
					// Belt and braces: re-run the same revoke here too,
					// in case this catch is ever reached by a future
					// change that reorders something above these two
					// calls in the try block. Re-expiring already
					// expired cookies, and re-nulling an already-null
					// `newSession`, are both harmless.
					//
					// The cookie scrub gets its own try/catch so that a
					// throw from it cannot skip `setNewSession(null)`.
					// Nulling the in-memory session is what stops a later
					// plugin `after` hook from reading `newSession` and
					// re-installing the credential, so it must not be
					// contingent on the cookie helper succeeding.
					try {
						deleteSessionCookie(cookieCtx, true);
					} catch (cookieError) {
						logger.error(
							"[Auth] Failed to re-expire session cookies while containing a 2FA challenge failure:",
							cookieError,
						);
					}
					ctx.context.setNewSession(null);

					logger.error(
						"[Auth] Failed to enforce 2FA on a fresh session mint:",
						error,
					);
					redirectTarget = new URL("/auth/login", appUrl).toString();
				}

				// Containment (cookies scrubbed, `newSession` nulled) has
				// already happened by here on both paths, so no live
				// credential escapes either way. What differs is how the
				// caller is told. An XHR caller must see a failed call, not a
				// login page behind a transparently-followed 302 that its
				// response parser would read as a successful verification.
				if (!challengeIssued && !isNavigationRequest) {
					throw new APIError("INTERNAL_SERVER_ERROR", {
						message: "Failed to issue two-factor challenge",
						code: "TWO_FACTOR_CHALLENGE_FAILED",
					});
				}

				if (challengeIssued && !isNavigationRequest) {
					return ctx.json({ twoFactorRedirect: true });
				}

				throw ctx.redirect(redirectTarget);
			}

			if (ctx.path.startsWith("/organization/accept-invitation")) {
				try {
					const { invitationId } = ctx.body;

					if (!invitationId) {
						return;
					}

					const invitation = await getInvitationById(invitationId);

					if (!invitation) {
						return;
					}

					await updateSeatsInOrganizationSubscription(
						invitation.organizationId,
					);
				} catch (error) {
					logger.error(
						"[Auth] Failed to update seats after accepting invitation:",
						error,
					);
				}
			} else if (ctx.path === "/change-password") {
				const session = (ctx.context as any).session as
					| {
							user: {
								id: string;
								mustChangePassword?: boolean | null;
							};
					  }
					| null
					| undefined;

				if (session?.user?.mustChangePassword) {
					try {
						await db.user.update({
							where: { id: session.user.id },
							data: { mustChangePassword: false },
						});
						logger.info(
							"[Auth] mustChangePassword flag cleared for user",
							{ userId: session.user.id },
						);
					} catch (error) {
						logger.error(
							"[Auth] Failed to clear mustChangePassword flag:",
							error,
						);
					}
				}
			} else if (ctx.path === "/organization/leave") {
				// A member leaving of their own accord.
				//
				// Handled here and not through `organizationHooks` because the
				// plugin has no hook for it: `/organization/leave` calls
				// `adapter.deleteMember` directly, and none of the fifteen
				// before/after pairs it does expose covers leaving. So until
				// better-auth grows one, matching the path is the only way to see
				// this event at all.
				//
				// The ids are safe to take from the request: the endpoint requires
				// `organizationId` in its body and resolves the member from the
				// SESSION user, so the person leaving is the caller. An after-hook
				// only runs on success, which means better-auth already found and
				// deleted that member row.
				// Read defensively, like the other body reads in this file. The
				// endpoint's schema makes `organizationId` required and an
				// after-hook only runs on success, so a parsed body is there today
				// — but a destructure of `undefined` throws, and a throw inside a
				// global after-hook turns a departure that already committed into a
				// 500, which is the one outcome this path exists to avoid.
				const organizationId = (
					ctx.body as { organizationId?: string } | undefined
				)?.organizationId;
				const leavingUserId = ctx.context.session?.session.userId;
				if (organizationId && leavingUserId) {
					// AFTER, not before, and it cannot refuse. A global
					// `hooks.before` would run ahead of better-auth's own
					// preconditions — the member row must exist, and the only
					// owner may not leave — so revoking there would strip a
					// sole owner's grants on an attempt that then fails.
					// Replicating those preconditions here would put a second
					// copy of better-auth's policy in this repo, which is the
					// class of defect this change exists to remove.
					await revokeDepartingMemberAccess({
						organizationId,
						userId: leavingUserId,
						trigger: "left",
					});
					await syncSeatsAfterDeparture(organizationId);
				}
			}
		}),
		before: createAuthMiddleware(async (ctx) => {
			// Step-up 2FA lockout (issue #2819): refuse a locked account before
			// Better Auth compares the submitted code. Runs first, and is
			// deliberately NOT wrapped in a try/catch — a store failure must
			// propagate so the comparison never happens. See
			// ./lib/two-factor-step-up-lockout.ts for why this cannot live in
			// `hooks.after` alongside the sign-in lockout's logger.
			await enforceStepUpLockout(ctx, stepUpLockoutDeps);

			// Server-enforced step-up for the 2FA MANAGEMENT endpoints
			// (issue #2827): disable / enable / generate-backup-codes /
			// get-totp-uri are gated by Better Auth on the account password
			// alone, so a stolen session plus a phished password could strip
			// or rotate the second factor without ever producing a code. This
			// requires a single-use grant minted by a recent verification.
			// Runs after the lockout enforcement above — they touch disjoint
			// paths, so the order is about readability, not correctness — and
			// is likewise NOT wrapped in a try/catch, so a store failure
			// refuses the call rather than admitting it.
			await requireStepUpGrant(
				ctx as unknown as Parameters<typeof requireStepUpGrant>[0],
				stepUpGrantDeps,
			);

			// Silent-notify on duplicate-email signup attempts. Lookup runs
			// here (not in onAPIError, where Better Auth passes the auth init
			// context with no path/body) so we can read the submitted email
			// and the request path. We don't throw — Better Auth's signup
			// handler does the real existing-user check and returns the
			// canonical 422, so the wire response stays identical for
			// existent vs non-existent emails.
			if (ctx.path === "/sign-up/email") {
				const signupEmail = (ctx.body as { email?: string } | undefined)
					?.email;
				if (signupEmail) {
					try {
						const existing = await getUserByEmail(signupEmail);
						if (existing) {
							void notifySignupAttempt(signupEmail);
						}
					} catch (err) {
						logger.warn({
							event: "duplicate_signup_notice.lookup_failed",
							err,
						});
					}
				}
			}

			// /verify-email — reject JWTs that were revoked via the
			// "this wasn't me" flow (revoke-email-change procedure).
			// Two checks: (1) exact-token blocklist — covers JWT 1
			// (change-email-confirmation) whose hash we captured at revoke
			// time; (2) tuple revocation — decode the JWT and match against
			// SHA-256(oldEmail|newEmail), which also catches JWT 2
			// (change-email-verification) since Better Auth 1.4.9 mints it
			// with the same {email, updateTo} payload as JWT 1.
			if (ctx.path === "/verify-email") {
				const verifyTokenStr = (
					ctx.query as { token?: unknown } | undefined
				)?.token;
				if (
					typeof verifyTokenStr === "string" &&
					verifyTokenStr.length > 0
				) {
					if (await isEmailVerifyJWTBlocked(verifyTokenStr)) {
						throw new APIError("BAD_REQUEST", {
							message: "This verification link has been revoked.",
						});
					}
					try {
						const secret = process.env.BETTER_AUTH_SECRET;
						if (secret) {
							const { payload } = await jwtVerify(
								verifyTokenStr,
								new TextEncoder().encode(secret),
								{ algorithms: ["HS256"] },
							);
							const email =
								typeof payload.email === "string"
									? payload.email
									: undefined;
							const updateTo =
								typeof payload.updateTo === "string"
									? payload.updateTo
									: undefined;
							if (
								email &&
								updateTo &&
								(await isEmailChangeRevoked(email, updateTo))
							) {
								throw new APIError("BAD_REQUEST", {
									message:
										"This verification link has been revoked.",
								});
							}
						}
					} catch (err) {
						// Re-throw our own block so it doesn't get swallowed.
						if (err instanceof APIError) {
							throw err;
						}
						// jose threw on a bad/expired JWT — let Better Auth's
						// own handler produce the canonical error response.
					}
				}
			}

			// Password strength enforcement for password-setting endpoints
			const passwordPaths = [
				"/sign-up/email",
				"/reset-password",
				"/change-password",
			];
			if (passwordPaths.some((p) => ctx.path === p)) {
				const password =
					(ctx.body?.password as string | undefined) ??
					(ctx.body?.newPassword as string | undefined);
				if (password) {
					try {
						assertPasswordStrength(password, {
							email: ctx.body?.email as string | undefined,
							name: ctx.body?.name as string | undefined,
						});
					} catch (e) {
						if (e instanceof PasswordTooWeakError) {
							throw new APIError("BAD_REQUEST", {
								message: e.warning,
								body: {
									code: "PASSWORD_TOO_WEAK",
									message: e.warning,
									suggestions: e.suggestions,
								},
							});
						}
						throw e;
					}
				}
			}

			// Turnstile CAPTCHA verification for protected auth endpoints
			const turnstileProtectedPaths = [
				"/sign-up/email",
				"/sign-in/email",
				"/sign-in/magic-link",
				"/request-password-reset",
			];

			if (turnstileProtectedPaths.some((p) => ctx.path === p)) {
				// Exempt only the in-app SetPassword flow: an authenticated
				// caller requesting a reset email for their *own* address.
				// A logged-in user requesting a reset for someone else's
				// address still goes through CAPTCHA so it can't be used to
				// blast reset emails at arbitrary inboxes.
				const sessionEmail =
					ctx.context.session?.user.email?.toLowerCase();
				const bodyEmail = (
					ctx.body?.email as string | undefined
				)?.toLowerCase();
				const isOwnAccountReset =
					ctx.path === "/request-password-reset" &&
					Boolean(sessionEmail) &&
					sessionEmail === bodyEmail;
				if (!isOwnAccountReset) {
					const captchaToken = ctx.body?.captchaToken as
						| string
						| undefined;
					const ip = ctx.request
						? getClientIp(ctx.request)
						: "unknown";
					const result = await verifyTurnstileToken(
						captchaToken ?? "",
						ip,
					);

					if (!result.success) {
						throw new APIError("BAD_REQUEST", {
							message: "CAPTCHA verification failed",
							body: {
								code: "CAPTCHA_FAILED",
								message:
									"Verification failed. Please try again.",
							},
						});
					}
				}
			}

			// Brute force protection: check if sign-in attempt is allowed
			if (ctx.path === "/sign-in/email") {
				try {
					const email = ctx.body?.email as string | undefined;
					const ip = ctx.request
						? getClientIp(ctx.request)
						: "unknown";

					if (email) {
						const result = await checkLoginAllowed(email, ip);

						if (!result.allowed) {
							throw new APIError("FORBIDDEN", {
								message:
									"Account temporarily locked. Try again later or reset your password.",
								body: {
									code: "ACCOUNT_LOCKED",
									message:
										"Account temporarily locked. Try again later or reset your password.",
									lockedUntil:
										result.lockedUntil.toISOString(),
									retryAfterSeconds: result.retryAfterSeconds,
								},
							});
						}
					}
				} catch (error) {
					// Re-throw APIErrors (our intentional brute force responses)
					if (error instanceof APIError) {
						throw error;
					}
					// Log and swallow unexpected errors — don't break login
					logger.error(
						{
							event: "auth.bruteforce.check.error",
							security: true,
							error:
								error instanceof Error
									? error.message
									: String(error),
						},
						"Brute force check failed, allowing login attempt",
					);
				}
			}

			if (
				ctx.path.startsWith("/delete-user") ||
				ctx.path.startsWith("/organization/delete")
			) {
				const userId = ctx.context.session?.session.userId;
				const { organizationId } = ctx.body;

				if (userId || organizationId) {
					const purchases = organizationId
						? await getPurchasesByOrganizationId(organizationId)
						: // biome-ignore lint/style/noNonNullAssertion: This is a valid case
							await getPurchasesByUserId(userId!);
					const subscriptions = purchases.filter(
						(purchase) =>
							purchase.type === "SUBSCRIPTION" &&
							purchase.subscriptionId !== null,
					);

					if (subscriptions.length > 0) {
						for (const subscription of subscriptions) {
							await cancelSubscription(
								// biome-ignore lint/style/noNonNullAssertion: This is a valid case
								subscription.subscriptionId!,
							);
						}
					}
				}

				// Cancel running Temporal workflows for the user (fire-and-forget)
				if (ctx.path.startsWith("/delete-user") && userId) {
					try {
						const temporalClient = await getTemporalClient();
						const workflows = temporalClient.workflow.list({
							query: 'ExecutionStatus="Running"',
						});
						for await (const workflow of workflows) {
							if (workflow.workflowId.includes(userId)) {
								try {
									const handle =
										temporalClient.workflow.getHandle(
											workflow.workflowId,
											workflow.runId,
										);
									await handle.cancel();
									logger.info(
										{
											workflowId: workflow.workflowId,
											userId,
										},
										"Cancelled Temporal workflow during account deletion",
									);
								} catch (cancelError) {
									logger.warn(
										{
											workflowId: workflow.workflowId,
											userId,
											error:
												cancelError instanceof Error
													? cancelError.message
													: String(cancelError),
										},
										"Failed to cancel Temporal workflow during account deletion",
									);
								}
							}
						}
					} catch (temporalError) {
						logger.warn(
							{
								userId,
								error:
									temporalError instanceof Error
										? temporalError.message
										: String(temporalError),
							},
							"Failed to connect to Temporal for workflow cancellation during account deletion",
						);
					}
				}
			}
		}),
	},
	user: {
		additionalFields: {
			onboardingComplete: {
				type: "boolean",
				required: false,
			},
			locale: {
				type: "string",
				required: false,
			},
			mustChangePassword: {
				type: "boolean",
				required: false,
			},
		},
		deleteUser: {
			enabled: true,
		},
		changeEmail: {
			enabled: true,
			sendChangeEmailConfirmation: async (
				{ user, newEmail, url, token },
				request,
			) => {
				const locale = getLocaleFromRequest(request);

				// Single email to the OLD address with both the approve link
				// (Better Auth's stateless JWT — the proof-of-control step)
				// and a revoke link (our HMAC-signed token — the "wasn't me"
				// path that also blocks the JWT and revokes sessions). The
				// approve URL must go to OLD; sending it to newEmail would
				// let an attacker with a stolen session redirect the account
				// to an inbox they control without OLD-side approval.
				const { signToken } = await import("./lib/signed-token");
				const revokeToken = signToken(
					{
						userId: user.id,
						oldEmail: user.email,
						newEmail,
						betterAuthToken: token,
						kind: "email-change-revoke" as const,
					},
					{ ttlSec: 86400 },
				);
				const revokeUrl = `${appUrl}/auth/revoke-email-change?token=${encodeURIComponent(revokeToken)}`;
				await sendEmail({
					to: user.email,
					templateId: "emailChangeRequest",
					context: {
						name: user.name,
						oldEmail: user.email,
						newEmail,
						approveUrl: withEmailVerificationCallback(url),
						revokeUrl,
						timestamp: new Date().toISOString(),
					},
					locale,
				});
			},
		},
	},
	emailAndPassword: {
		enabled: true,
		// All signups require email verification before sign-in, regardless of
		// invite-only mode (closes H5 — auto-sign-in without verification).
		autoSignIn: false,
		requireEmailVerification: true,
		resetPasswordTokenExpiresIn:
			config.auth.tokenExpiry.passwordResetSeconds,
		sendResetPassword: async ({ user, url }, request) => {
			const locale = getLocaleFromRequest(request);
			await sendEmail({
				to: user.email,
				templateId: "forgotPassword",
				context: {
					url,
					name: user.name,
				},
				locale,
			});
		},
	},
	emailVerification: {
		// Always send verification on signup. Required because both open and
		// invite-only modes now run with `autoSignIn: false` +
		// `requireEmailVerification: true`, so the user has no session and no
		// other way to prove email ownership.
		sendOnSignUp: true,
		// Sign the user in after they click the verify-email link. Clicking the
		// link is itself a proof-of-control step (same security level as a
		// magic-link sign-in); separating verification and first-sign-in into
		// two clicks adds friction without security benefit. Sensitive ops
		// (change-password, enable-2FA, add-passkey) still require the current
		// password or fresh auth via session.freshAge.
		autoSignInAfterVerification: true,
		expiresIn: config.auth.tokenExpiry.emailVerificationSeconds,
		sendVerificationEmail: async (
			{ user: { email, name }, url },
			request,
		) => {
			const locale = getLocaleFromRequest(request);
			await sendEmail({
				to: email,
				templateId: "emailVerification",
				context: {
					url: withEmailVerificationCallback(url),
					name,
				},
				locale,
			});
		},
		afterEmailVerification: async (user, request) => {
			try {
				// Atomic guard: only send welcome email once, even if the
				// verification link is opened in multiple browsers.
				// updateMany with a WHERE condition is a single SQL statement —
				// only the first concurrent request will match.
				const result = await db.user.updateMany({
					where: { id: user.id, welcomeEmailSentAt: null },
					data: { welcomeEmailSentAt: new Date() },
				});

				if (result.count === 0) {
					logger.info(
						`[Auth] Welcome email already sent to ${user.email}, skipping duplicate`,
					);
					return;
				}

				const locale = getLocaleFromRequest(request);
				const docsUrl = `${appUrl.replace(/\/+$/, "")}/docs/getting-started/overview`;
				const sent = await sendEmail({
					to: user.email,
					templateId: "welcome",
					context: {
						name: user.name || user.email.split("@")[0],
						docsUrl,
					},
					locale,
				});
				if (sent) {
					logger.info(`[Auth] Welcome email sent to ${user.email}`);
				} else {
					// Rollback the flag so a future retry can succeed.
					await db.user.update({
						where: { id: user.id },
						data: { welcomeEmailSentAt: null },
					});
					logger.warn(
						`[Auth] Welcome email could not be sent to ${user.email}, reset flag for retry`,
					);
				}
			} catch (error) {
				// Rollback the flag so a future retry can succeed.
				await db.user
					.update({
						where: { id: user.id },
						data: { welcomeEmailSentAt: null },
					})
					.catch(() => {});
				logger.error(
					"[Auth] Failed to send welcome email after verification:",
					error,
				);
			}

			// Resolve pending org/project invitations now that the email is
			// verified (email+password signups reach verified state here).
			// Never throws — must not break the verification flow. The
			// duplicate-click early-return above is covered by the
			// session-create trigger via autoSignInAfterVerification.
			await runInviteReconciliationForUser({
				userId: user.id,
				trigger: "email_verification",
			});
		},
	},
	socialProviders,
	plugins: [
		username(),
		admin(),
		// Configured wrapper, never the bare plugin default: enforces user
		// verification at registration and sign-in so a passkey is genuinely
		// two factors — the policy that justifies exempting
		// `/passkey/verify-authentication` from the 2FA challenge hook above.
		// See ./lib/passkey-policy.ts.
		createPasskeyPlugin(),
		magicLink({
			disableSignUp: false,
			sendMagicLink: async ({ email, url }, ctx) => {
				const locale = getLocaleFromRequest(ctx?.request);
				await sendEmail({
					to: email,
					templateId: "magicLink",
					context: {
						url,
					},
					locale,
				});
			},
		}),
		organization({
			sendInvitationEmail: async (
				{ email, id, organization },
				request,
			) => {
				const locale = getLocaleFromRequest(request);
				const existingUser = await getUserByEmail(email);

				const token = buildInvitationToken({ invitationId: id, email });
				const path = existingUser ? "/auth/login" : "/auth/signup";
				const url = `${getBaseUrl()}${path}/invite/${encodeURIComponent(token)}`;

				await sendEmail({
					to: email,
					templateId: "organizationInvitation",
					locale,
					context: {
						organizationName: organization.name,
						url,
					},
				});
			},
			// Org-context managed-default MCP configs. Better Auth v1.4.9 does
			// not expose `databaseHooks.member.create.after` (only `user`,
			// `session`, `account`, `verification` are supported on the core
			// `databaseHooks` type). The `organization()` plugin exposes
			// `organizationHooks` with three callbacks that cover every path
			// that produces a new `member` row:
			//   - afterCreateOrganization: fires when an org is created (the
			//     owner's member row is created in the same flow).
			//   - afterAcceptInvitation:    fires when an invited user accepts
			//     and a `member` row is created.
			//   - afterAddMember:           fires when an owner directly adds a
			//     member without an invite (admin path).
			// All three call the same `seedDefaultMcpConfigsForTenant` helper —
			// the helper is idempotent (per-tuple existence check), so the rare
			// case where two paths fire for the same tuple cannot duplicate.
			organizationHooks: {
				afterCreateOrganization: async ({
					organization: createdOrg,
					member,
					user: actingUser,
				}) => {
					try {
						await seedDefaultMcpConfigsForTenant({
							userId: member.userId,
							organizationId: member.organizationId,
						});
					} catch (error) {
						logger.error(
							"[Auth] Failed to seed default MCP configs for org owner",
							{
								userId: member.userId,
								organizationId: member.organizationId,
								error: String(error),
							},
						);
					}

					// Audit-log emission for `org.created`.
					// Better Auth's organizationHooks does not receive the
					// request directly, so IP/UA/requestId are unavailable —
					// the rest of the snapshot (actor email/name, org name)
					// is captured here.
					recordAudit({
						action: "org.created",
						category: "org",
						actor: {
							type: "user",
							userId: actingUser.id,
							emailSnapshot: actingUser.email ?? null,
							nameSnapshot: actingUser.name ?? null,
						},
						organizationId: createdOrg.id,
						resource: {
							type: "organization",
							id: createdOrg.id,
							name: createdOrg.name ?? null,
						},
						metadata: {
							slug: createdOrg.slug ?? null,
						},
					});
				},
				afterUpdateOrganization: async ({
					organization: updatedOrg,
					user: actingUser,
				}) => {
					if (!updatedOrg) {
						return;
					}
					recordAudit({
						action: "org.updated",
						category: "org",
						actor: {
							type: "user",
							userId: actingUser.id,
							emailSnapshot: actingUser.email ?? null,
							nameSnapshot: actingUser.name ?? null,
						},
						organizationId: updatedOrg.id,
						resource: {
							type: "organization",
							id: updatedOrg.id,
							name: updatedOrg.name ?? null,
						},
						metadata: {
							slug: updatedOrg.slug ?? null,
						},
					});
				},
				beforeDeleteOrganization: async ({
					organization: orgBeingDeleted,
					user: actingUser,
				}) => {
					// Persist a durable `org.deleted` audit row. `AuditLog`'s org
					// FK is now ON DELETE SET NULL (migration
					// 20260702130000_audit_log_worm_tamper_evidence), so this row
					// SURVIVES the deletion — organizationId is nulled and the
					// resource/metadata snapshots below preserve the org
					// identity. Uses `recordAuditDurable` (NOT fire-and-forget
					// `recordAudit`) so the insert genuinely COMMITS before the
					// org-delete cascade — otherwise the background write races
					// the cascade's FK teardown and can lose the row. Wrapped so
					// an audit hiccup can never abort the deletion. Previously
					// this cascade-wiped the row (Risk #2), so only the legacy
					// sink saw it; now both the audit table and the operator log
					// capture it.
					try {
						await recordAuditDurable({
							action: "org.deleted",
							category: "org",
							severity: "warning",
							actor: {
								type: "user",
								userId: actingUser.id,
								emailSnapshot: actingUser.email ?? null,
								nameSnapshot: actingUser.name ?? null,
							},
							organizationId: orgBeingDeleted.id,
							resource: {
								type: "organization",
								id: orgBeingDeleted.id,
								name: orgBeingDeleted.name ?? null,
							},
							metadata: {
								slug: orgBeingDeleted.slug ?? null,
							},
						});
					} catch (error) {
						logger.error("[Auth] org.deleted audit write failed", {
							organizationId: orgBeingDeleted.id,
							error: String(error),
						});
					}
					void logAuditEvent(
						"DATA_DELETE",
						`Organization deleted: ${orgBeingDeleted.name ?? orgBeingDeleted.id}`,
						"warning",
						{
							userId: actingUser.id,
							organizationId: orgBeingDeleted.id,
							resourceType: "organization",
							resourceId: orgBeingDeleted.id,
							action: "org.deleted",
							orgName: orgBeingDeleted.name ?? null,
							orgSlug: orgBeingDeleted.slug ?? null,
						},
					).catch(() => undefined);
				},
				afterAcceptInvitation: async ({
					member,
					user: invitedUser,
					organization: org,
				}) => {
					try {
						await seedDefaultMcpConfigsForTenant({
							userId: member.userId,
							organizationId: member.organizationId,
						});
					} catch (error) {
						logger.error(
							"[Auth] Failed to seed default MCP configs for invited member",
							{
								userId: member.userId,
								organizationId: member.organizationId,
								error: String(error),
							},
						);
					}

					// Audit-log emission for `org.member.invited`.
					// We emit on accept rather than create so the audit row
					// reflects an actual membership change — invitations that
					// are never accepted are not part of the v1 taxonomy.
					recordAudit({
						action: "org.member.invited",
						category: "org",
						actor: {
							type: "user",
							userId: invitedUser.id,
							emailSnapshot: invitedUser.email ?? null,
							nameSnapshot: invitedUser.name ?? null,
						},
						organizationId: org.id,
						resource: {
							type: "user",
							id: invitedUser.id,
							name: invitedUser.email ?? null,
						},
						metadata: {
							role: member.role,
							via: "invitation",
						},
					});
				},
				afterAddMember: async ({
					member,
					user: addedUser,
					organization: org,
				}) => {
					try {
						await seedDefaultMcpConfigsForTenant({
							userId: member.userId,
							organizationId: member.organizationId,
						});
					} catch (error) {
						logger.error(
							"[Auth] Failed to seed default MCP configs for added member",
							{
								userId: member.userId,
								organizationId: member.organizationId,
								error: String(error),
							},
						);
					}

					// Audit-log emission for `org.member.invited` via the
					// direct-add path (admin adds a member without going
					// through the invitation flow). Same action key — spec
					// taxonomy collapses both paths into one for v1.
					recordAudit({
						action: "org.member.invited",
						category: "org",
						actor: {
							type: "user",
							userId: addedUser.id,
							emailSnapshot: addedUser.email ?? null,
							nameSnapshot: addedUser.name ?? null,
						},
						organizationId: org.id,
						resource: {
							type: "user",
							id: addedUser.id,
							name: addedUser.email ?? null,
						},
						metadata: {
							role: member.role,
							via: "add_member",
						},
					});
				},
				afterUpdateMemberRole: async ({
					member,
					previousRole,
					user: actingUser,
					organization: org,
				}) => {
					// Resolve the affected user's email so the audit row
					// carries a stable `resourceName` snapshot even if the
					// user is later renamed or removed (D11).
					const targetUser = await db.user.findUnique({
						where: { id: member.userId },
						select: { email: true },
					});
					recordAudit({
						action: "org.member.role_changed",
						category: "org",
						actor: {
							type: "user",
							userId: actingUser.id,
							emailSnapshot: actingUser.email ?? null,
							nameSnapshot: actingUser.name ?? null,
						},
						organizationId: org.id,
						resource: {
							type: "user",
							id: member.userId,
							name: targetUser?.email ?? null,
						},
						metadata: {
							fromRole: previousRole ?? null,
							toRole: member.role,
						},
					});
				},
				// Revoke the ejected member's project and workspace access
				// BEFORE better-auth deletes the member row.
				//
				// `beforeRemoveMember` runs after every one of better-auth's own
				// checks — permission, member-belongs-to-org, organization
				// exists, user exists — and immediately before
				// `adapter.deleteMember`. That buys two things an after-hook
				// cannot. A failure REFUSES the removal, so there is no state
				// where somebody is out of the organization while their project
				// grants still authorize them; and no admin can re-add and
				// re-grant in the window, because there is nothing to re-add
				// yet.
				//
				// This is also where the old wiring could not work at all. It
				// lived in a global `hooks.after` branch and re-read the
				// `member` row to find the target user — a row better-auth had
				// already hard-deleted — so the lookup came back null on every
				// removal.
				beforeRemoveMember: async ({ member, organization: org }) => {
					await revokeDepartingMemberAccess({
						organizationId: org.id,
						userId: member.userId,
						trigger: "removed",
					});
				},
				afterRemoveMember: async ({
					member,
					user: actingUser,
					organization: org,
				}) => {
					const targetUser = await db.user.findUnique({
						where: { id: member.userId },
						select: { email: true },
					});
					recordAudit({
						action: "org.member.removed",
						category: "org",
						actor: {
							type: "user",
							userId: actingUser.id,
							emailSnapshot: actingUser.email ?? null,
							nameSnapshot: actingUser.name ?? null,
						},
						organizationId: org.id,
						resource: {
							type: "user",
							id: member.userId,
							name: targetUser?.email ?? null,
						},
						metadata: {
							previousRole: member.role,
						},
					});

					// Seats, and only seats: the access revocation already ran
					// in `beforeRemoveMember`. This has to be the AFTER hook
					// because it counts the organization's members, and
					// counting them before the deletion would keep paying for
					// somebody on their way out.
					await syncSeatsAfterDeparture(org.id);
				},
			},
		}),
		openAPI(),
		invitationOnlyPlugin(),
		createTwoFactorPlugin(),
	],
	onAPIError: {
		onError(error, ctx) {
			logger.error(error, { ctx: scrubAuthCtxForLogging(ctx) });
		},
	},
} satisfies BetterAuthOptions;

// better-auth 1.6.x's generic Options inference widens `Options["plugins"]`
// from a precise tuple to `BetterAuthPlugin[]`, which collapses both the
// `auth.$Infer.Session` user/session field inference (admin's `role`,
// organization's `activeOrganizationId`, custom additionalFields) AND the
// plugin endpoint inference on `auth.api` (so methods like
// `getFullOrganization`, `listOrganizations`, `listPasskeys`,
// `acceptInvitation`, `rejectInvitation` disappear from the type).
//
// All these methods exist at runtime — the issue is purely type-level.
// Until upstream fixes the inference, we cast `auth.api` to a permissive
// shape that re-admits the missing plugin methods. Specific return types
// are tightened via the explicit `Session`, `Organization`, etc. exports
// below; everything else is loosely typed but functional.
const authRaw = betterAuth(authOptions);
export const auth = authRaw as Omit<typeof authRaw, "api"> & {
	api: Omit<typeof authRaw.api, "getSession"> &
		Record<string, (args: any) => Promise<any>> & {
			getSession: (args: {
				headers: Headers;
				query?: { disableCookieCache?: boolean };
			}) => Promise<Session | null>;
		};
};

export * from "./lib/organization";

// Explicit Session shape (replaces auth.$Infer.Session, which now resolves
// to base user/session without plugin augmentations).
//
// Sources:
// - admin():        role, banned, banReason, banExpires (user); impersonatedBy (session)
// - organization(): activeOrganizationId (session)
// - username():     username, displayUsername (user)
// - twoFactor():    twoFactorEnabled (user)
// - additionalFields (this file): onboardingComplete, locale, mustChangePassword
export type Session = {
	session: {
		id: string;
		createdAt: Date;
		updatedAt: Date;
		userId: string;
		expiresAt: Date;
		token: string;
		ipAddress?: string | null;
		userAgent?: string | null;
		activeOrganizationId?: string | null;
		impersonatedBy?: string | null;
	};
	user: {
		id: string;
		createdAt: Date;
		updatedAt: Date;
		email: string;
		emailVerified: boolean;
		name: string;
		image?: string | null;
		// admin plugin
		role?: string | null;
		banned?: boolean | null;
		banReason?: string | null;
		banExpires?: Date | null;
		// username plugin
		username?: string | null;
		displayUsername?: string | null;
		// twoFactor plugin
		twoFactorEnabled?: boolean | null;
		// additionalFields (above)
		onboardingComplete?: boolean | null;
		locale?: string | null;
		mustChangePassword?: boolean | null;
	};
};

// Imported directly from the organization plugin because
// `auth.$Infer.Organization` / `auth.api.getFullOrganization` lost their
// types under 1.6.x widening (see note above the `auth` export).
import type {
	Invitation as BAInvitation,
	Member as BAMember,
	Organization as BAOrganization,
} from "better-auth/plugins";

export type Organization = BAOrganization;

export type ActiveOrganization = BAOrganization & {
	members: BAMember[];
	invitations: BAInvitation[];
};

export type OrganizationMemberRole = BAMember["role"];

export type OrganizationInvitationStatus = BAInvitation["status"];

export type OrganizationMetadata = Record<string, unknown> | undefined;
