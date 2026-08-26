/**
 * Deny-by-default 2FA enforcement gate (GitHub issue #2825).
 *
 * `auth.ts`'s `hooks.after` revokes-and-challenges whenever a request MINTS a
 * session for a `twoFactorEnabled` user. The set of paths that may do so
 * without a second factor is enumerated here; everything else is challenged.
 *
 * The inverse arrangement — an allowlist of paths TO challenge — fails open by
 * construction: every session-minting endpoint better-auth or a plugin grows,
 * and every one already present that nobody enumerated, hands out a full
 * session to a 2FA user until someone notices. That is how magic-link, OAuth
 * and `/verify-email` each had to be found and added one at a time (issues
 * #2802, #2805). Deny-by-default inverts the failure mode: an un-enumerated
 * minting path over-challenges (a 2FA user is asked for their code), which is
 * visible and recoverable, instead of under-challenging silently.
 *
 * ## Why equal session tokens are safe to skip
 *
 * The discriminator treats "the endpoint set a session whose token equals the
 * one it resolved from the request" as a refresh, not a mint — a cookie
 * rewrite, an `activeOrganizationId` update, a sliding-expiry bump. That is
 * only sound because every populator of `ctx.context.session` in the enabled
 * surface derives it from the request's OWN signed session cookie
 * (`dist/api/routes/session.mjs`'s `getSession` / `getSessionFromCtx`, which
 * `sessionMiddleware` and `sensitiveSessionMiddleware` both go through). So an
 * equal token means the session already existed and its own creation was
 * itself gated or exempted here.
 *
 * Two better-auth plugins break that derivation by assigning
 * `ctx.context.session` from a non-cookie source — `dist/plugins/mcp/
 * index.mjs:180` (an OAuth access token) and `dist/plugins/oidc-provider/
 * index.mjs:231`. Neither is enabled in `auth.ts`. `multiSession` is the third
 * case: `/multi-session/set-active` switches the caller onto a DIFFERENT
 * pre-existing session token, which this gate would read as a fresh mint;
 * it is not enabled either. Enabling any of the three requires re-deriving
 * this invariant and, for multiSession, its own exemption decision.
 *
 * ## Enforcement boundaries
 *
 * (a) An endpoint handler that returns a raw `Response` short-circuits the
 *     whole after-hook pipeline (`dist/api/dispatch.mjs:239`), so this gate
 *     never sees it. No enabled minting endpoint does that today; re-check on
 *     every better-auth upgrade.
 * (b) `runAfterHooks` is not terminal: config `hooks.after` runs FIRST
 *     (`dist/api/dispatch.mjs:147-164`) and later plugin after-hooks can still
 *     replace the response or mint again. Only the built-in `twoFactor()`
 *     plugin's after-hook does either, and only on the `/sign-in/*` paths
 *     exempted below — which is precisely why those must stay exempt.
 *
 * ## The 2FA MANAGEMENT endpoints need no entries
 *
 * `/two-factor/{disable,enable,generate-backup-codes,get-totp-uri}` are behind
 * their own step-up grant (issue #2827, ./two-factor-management-step-up.ts), so
 * it would be tempting to exempt them on the grounds that a call reaching the
 * handler is already factor-proven. None of them needs it, and adding an
 * exemption that no mint requires only widens the bypass surface:
 *
 *  - `/two-factor/disable` DOES rekey the session
 *    (`dist/plugins/two-factor/index.mjs:163-178` — new token, old one
 *    deleted), but the user it mints for has `twoFactorEnabled: false` by then
 *    (`:163`), so the predicate does not apply to it in the first place.
 *  - `/two-factor/enable` mints only under `skipVerificationOnEnable`
 *    (`dist/plugins/two-factor/index.mjs:95-104`), which is unset here — see
 *    the DELIBERATELY ABSENT note below. First-time enrolment, resuming an
 *    abandoned one, and re-enrolling an active factor all take the same
 *    no-mint path; enrolment completes at `/two-factor/verify-totp` instead.
 *  - `/two-factor/generate-backup-codes` and `/two-factor/get-totp-uri` never
 *    touch the session at all.
 *
 * The step-up module itself mints nothing: it writes one session-row column
 * and one signed cookie, so it cannot produce a `newSession` for the
 * discriminator to classify. Its after-hook half also runs BEFORE this gate in
 * `auth.ts`'s `hooks.after`, so a grant is always written before this gate can
 * short-circuit a response.
 */

/** The session `setSessionCookie` installed on this request, if any. */
export interface GateNewSession {
	session?: { token?: string } | null;
	user?: { twoFactorEnabled?: boolean | null } | null;
}

/** The session the endpoint resolved from the request's own cookie, if any. */
export interface GateActiveSession {
	session?: { token?: string } | null;
}

export interface ChallengeGatedMintInput {
	path: string;
	newSession: GateNewSession | null | undefined;
	activeSession: GateActiveSession | null | undefined;
}

/**
 * Paths that may mint a session for a `twoFactorEnabled` user without this
 * gate raising a challenge. Matched EXACTLY — a prefix match would exempt
 * `/admin/stop-impersonating/anything` along with the real endpoint.
 *
 * Every entry is a deliberate security decision; the reason each one is safe
 * is recorded inline, because the cost of a wrong entry is a 2FA bypass.
 */
export const TWO_FACTOR_GATE_EXEMPT_PATHS: ReadonlySet<string> = new Set([
	// Challenge completion: `verifyTwoFactor().valid()` mints the real session
	// once the submitted TOTP code matches (`dist/plugins/two-factor/
	// verify-two-factor.mjs`). Challenging it would loop forever.
	//
	// The SAME path also mints on first-time enrollment: an authenticated user
	// confirming their new TOTP secret gets `twoFactorEnabled: true` and a
	// rekeyed session (`dist/plugins/two-factor/totp/index.mjs:158-167`).
	// Narrowing this exemption to "only when a two_factor challenge cookie is
	// present" would therefore break enrollment — the enrolling request has no
	// such cookie, and its mint is exactly the shape this gate challenges.
	"/two-factor/verify-totp",
	// Challenge completion via a recovery code — same `verifyTwoFactor()
	// .valid()` mint (`dist/plugins/two-factor/backup-codes/index.mjs`).
	"/two-factor/verify-backup-code",
	// Challenge completion via emailed/SMS OTP, plus its own enrollment mint
	// (`dist/plugins/two-factor/otp/index.mjs:184-196`). Unreachable today —
	// no `sendOTP` is configured, so `/two-factor/send-otp` rejects before a
	// code is ever issued (`otp/index.mjs:68`) — but omitting it would turn
	// the day someone configures `sendOTP` into an unbreakable challenge loop.
	"/two-factor/verify-otp",
	// better-auth's own `twoFactor()` plugin owns these three: its after-hook
	// matcher claims exactly `/sign-in/{email,username,phone-number}`
	// (`dist/plugins/two-factor/index.mjs:191-193`) and runs the challenge
	// itself, including the trust-device exception this gate has no notion of.
	//
	// LOAD-BEARING, not merely redundant: config `hooks.after` runs BEFORE
	// plugin after-hooks (`dist/api/dispatch.mjs:147-164`), so firing here
	// would delete the session and null `newSession` before the plugin hook
	// could read it — silently disabling trust-device, which returns the
	// session as-is when the signed trust cookie validates.
	//
	// `/sign-in/phone-number` has no plugin registered in `auth.ts` today, but
	// the built-in matcher claims it unconditionally, so it is listed for the
	// day one is.
	"/sign-in/email",
	"/sign-in/username",
	"/sign-in/phone-number",
	// Policy #2802: a user-verified passkey is already two factors (possession
	// of the authenticator plus the PIN/biometric that unlocks it), so passkey
	// sign-in satisfies 2FA rather than being challenged by it. That holds only
	// because user verification is enforced SERVER-SIDE, in ./passkey-policy.ts's
	// `authentication.afterVerification`, which `@better-auth/passkey` invokes
	// before it creates the session (dist/index.mjs:432,445) inside a
	// failure-converting try/catch — so a possession-only assertion never
	// reaches a mint at all.
	"/passkey/verify-authentication",
	// A deliberate, blunt bypass of the TARGET user's 2FA: an admin
	// impersonating a user with 2FA enabled cannot produce that user's second
	// factor, and the flow would be unusable if challenged. What stands in for
	// the factor is the admin's own authorization — `adminMiddleware` does an
	// authoritative session read and a permission check before the mint
	// (`dist/plugins/admin/routes.mjs`), and the action is audited
	// (`auth.impersonation.started`, ./audit-events.ts).
	"/admin/impersonate-user",
	// Restores the admin's ORIGINAL session — the one that already passed 2FA
	// when the admin signed in (`dist/plugins/admin/routes.mjs:619-641` reads
	// it back from the signed `admin_session` cookie). It looks like a fresh
	// mint to the discriminator only because `ctx.context.session` holds the
	// IMPERSONATED user's session, so the two tokens necessarily differ.
	"/admin/stop-impersonating",
	// The `revokeOtherSessions` branch rekeys the caller's session
	// (`dist/api/routes/update-user.mjs:170-178`) behind
	// `sensitiveSessionMiddleware` plus proof of the current password — the
	// user demonstrably still holds the account. Challenging it would (a)
	// strand XHR callers behind a 302 issued after the password had already
	// changed and every other session was revoked, and (b) skip the
	// `mustChangePassword` clearing later in the same hook body, deadlocking
	// any user under a forced password change.
	"/change-password",
	// DELIBERATELY ABSENT: /two-factor/enable. In this configuration it never
	// mints — `skipVerificationOnEnable` is unset, so the mint at
	// `dist/plugins/two-factor/index.mjs:95-104` is dead code and enrollment
	// completes at /two-factor/verify-totp instead. If that option is ever
	// turned on, the endpoint starts handing out `twoFactorEnabled` sessions
	// with no factor proof, which is exactly what this gate exists to
	// challenge. Turning it on is a change that must come back through
	// security review, not one that an exemption here should pre-approve.
]);

/**
 * True when `newSession` is a session the request just MINTED rather than one
 * it merely refreshed.
 *
 * Fails CLOSED on anything it cannot classify: a missing or non-string active
 * token means "no pre-existing session was proven", which counts as a mint. A
 * scoped `newSession?.session?.token !== activeSession?.session?.token`
 * comparison would instead call `undefined !== undefined` a refresh and wave
 * the request through.
 */
export function isFreshSessionMint(
	newSession: GateNewSession | null | undefined,
	activeSession: GateActiveSession | null | undefined,
): boolean {
	if (!newSession) {
		return false;
	}
	const activeToken = activeSession?.session?.token;
	return (
		typeof activeToken !== "string" ||
		newSession.session?.token !== activeToken
	);
}

/**
 * True when this request must be stopped and sent through a 2FA challenge: a
 * `twoFactorEnabled` user's session was freshly minted on a path that is not
 * exempt above.
 *
 * Pure, so both the gate in `auth.ts` and the audit-event suppression in
 * ./audit-events.ts decide from one source of truth. The audit emission runs
 * BEFORE the gate in the same hook body, so it has to PREDICT the gate's
 * outcome to avoid recording an `auth.login.success` for a login that the very
 * next statement revokes; a second, hand-copied path list is exactly the kind
 * of prediction that drifts.
 */
export function isChallengeGatedMint({
	path,
	newSession,
	activeSession,
}: ChallengeGatedMintInput): boolean {
	if (!newSession?.user?.twoFactorEnabled) {
		return false;
	}
	if (TWO_FACTOR_GATE_EXEMPT_PATHS.has(path)) {
		return false;
	}
	return isFreshSessionMint(newSession, activeSession);
}

/**
 * Reduce a recovered post-login navigation target to something safe to hand
 * back to the browser as `/auth/verify?redirectTo=…`.
 *
 * The raw value comes from `ctx.query.callbackURL`, `ctx.body.callbackURL` or
 * the `location` header the endpoint set — none of which this hook validates,
 * and which under a deny-by-default gate are now read on paths that carry no
 * `originCheck` middleware of their own. Unsanitized, an attacker-chosen
 * `callbackURL` on any gated request would ride through the challenge page and
 * out to their own origin.
 *
 * Accepts a relative path, or an absolute URL on the same origin as `appUrl` —
 * absolute is required because magic-link and OAuth hand this hook fully
 * qualified same-origin targets (`dist/plugins/magic-link/index.mjs:115`,
 * `dist/api/routes/callback.mjs:166-172`), so a relative-only rule would drop
 * every legitimate redirect on the two paths that most need one. Accepted
 * absolute URLs are normalized to path + query + hash, so the emitted param is
 * always relative and survives the client's own `safeRelativePath` check
 * (`apps/web/modules/saas/auth/lib/safe-redirect.ts`) unchanged.
 *
 * EVERY candidate — relative ones included — is resolved against `appUrl` and
 * accepted only if it still lands on that origin. Prefix inspection alone is
 * not sufficient and never was: WHATWG URL parsing STRIPS ASCII tab, newline
 * and carriage return before interpreting a URL, so `"/\t/evil.example"`
 * resolves exactly as `"//evil.example"` does — to another host — while
 * passing any "starts with a single slash" test, because the second character
 * genuinely is a tab. Resolution is what the browser will do with the value,
 * so it is the only check that cannot be out-argued by a parsing quirk.
 * Control characters are additionally rejected outright, so a value that
 * depends on them never reaches the parser in the first place.
 *
 * Everything else — cross-origin, protocol-relative (`//evil.example`),
 * backslash variants, unparseable junk — returns null, and the caller drops
 * the param entirely.
 *
 * TOTAL over `unknown` by contract: a non-string (a future plugin's typed
 * body, a malformed query object) returns null rather than throwing. The
 * caller runs inside the fail-closed containment region, where a throw would
 * skip revocation — so this function must never be the thing that throws.
 */
export function safeChallengeRedirectPath(
	raw: unknown,
	appUrl: string,
): string | null {
	if (typeof raw !== "string" || raw.length === 0) {
		return null;
	}
	if (hasControlCharacter(raw)) {
		return null;
	}

	let resolved: URL;
	let base: URL;
	try {
		base = new URL(appUrl);
		// Resolving relative values against the base too — not just absolute
		// ones — is the point: it is the step that catches anything whose
		// leading characters lie about where it goes.
		resolved = new URL(raw, base);
	} catch {
		return null;
	}
	// `origin` is the literal string "null" for opaque origins (a `file:` or
	// otherwise non-tuple `appUrl`), which would otherwise compare equal to
	// itself and admit everything.
	if (resolved.origin === "null" || resolved.origin !== base.origin) {
		return null;
	}

	// `pathname` always starts with "/", but it can still start with "//"
	// (`https://app.example.com//evil.example` resolves same-origin yet has
	// pathname `//evil.example`), which reads as protocol-relative once it is
	// re-emitted as a bare path — so the normalized form goes through the
	// same shape check as a raw relative input.
	const normalized = `${resolved.pathname}${resolved.search}${resolved.hash}`;
	return isSafeRelativePath(normalized) ? normalized : null;
}

/**
 * True when `value` contains an ASCII C0 control character or DEL.
 *
 * Tab (09), LF (0A) and CR (0D) are the three the URL parser removes outright;
 * the rest are rejected alongside them rather than reasoned about
 * individually. Written as a code-point scan rather than a regex because a
 * character class of literal control characters is itself a lint hazard, and
 * the intent reads more plainly this way.
 */
function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code === 0x7f) {
			return true;
		}
	}
	return false;
}

/**
 * A single leading `/` followed by something that is neither `/` nor `\` —
 * the same shape rule the web app applies at every redirect hop
 * (`apps/web/modules/saas/auth/lib/safe-redirect.ts`). Both slash variants are
 * excluded because browsers resolve `//host` and `/\host` as absolute URLs.
 * Applied to the PARSER'S output, so it is a check on what will actually be
 * emitted rather than on what was submitted.
 */
function isSafeRelativePath(value: string): boolean {
	return (
		value.startsWith("/") &&
		!value.startsWith("//") &&
		!value.startsWith("/\\")
	);
}
