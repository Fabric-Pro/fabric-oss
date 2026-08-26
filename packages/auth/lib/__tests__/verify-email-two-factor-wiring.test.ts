/**
 * Wiring tests for the deny-by-default 2FA gate (GitHub issue #2825, and the
 * `/verify-email` finding it grew out of — issue #2805, finding 3).
 *
 * `verify-email-two-factor-behavior.test.ts` locks the behaviour end-to-end
 * against a real better-auth pipeline, but it drives a PORT of the branch:
 * `auth.ts` builds the Better Auth instance at module-load time with dozens of
 * side-effecting dependencies, so — as in `passkey-policy-wiring.test.ts` and
 * `invite-reconciliation-wiring.test.ts` — it is verified statically instead of
 * booted inside a Vitest worker. This file is what stops the port and
 * production from drifting apart.
 *
 * The decision content itself — which paths are exempt, what counts as a fresh
 * mint, what survives redirect sanitization — is not re-pinned by regex here:
 * it lives in `../two-factor-gate.ts` and is tested directly in
 * `two-factor-gate.test.ts`. What this file asserts is that production
 * CONSUMES that module rather than re-deciding, and that the parts of the gate
 * which cannot move into a pure function (the revoke ordering, the response
 * shape, the sanitized-value plumbing) are still wired the way the security
 * argument assumes.
 *
 * Run with: pnpm --filter @repo/auth test lib/__tests__/verify-email-two-factor-wiring.test.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { TWO_FACTOR_GATE_EXEMPT_PATHS } from "../two-factor-gate";
import { STEP_UP_MANAGED_PATHS } from "../two-factor-management-step-up";
import { STEP_UP_GATED_PATHS } from "../two-factor-step-up-lockout";

let AUTH_SOURCE = "";
let AUDIT_SOURCE = "";
let POLICY_SOURCE = "";

beforeAll(() => {
	// `auth.ts` lives at packages/auth/auth.ts — two levels up from this
	// file in packages/auth/lib/__tests__/.
	const here = dirname(fileURLToPath(import.meta.url));
	AUTH_SOURCE = readFileSync(join(here, "..", "..", "auth.ts"), "utf8");
	AUDIT_SOURCE = readFileSync(join(here, "..", "audit-events.ts"), "utf8");
	POLICY_SOURCE = readFileSync(
		join(here, "..", "two-factor-policy.ts"),
		"utf8",
	);
});

/** The gate branch, from the predicate call to its terminal redirect. */
function sliceGate(): string {
	const start = AUTH_SOURCE.indexOf("isChallengeGatedMint({");
	expect(
		start,
		'expected auth.ts to gate on "isChallengeGatedMint({"',
	).toBeGreaterThanOrEqual(0);
	const end = AUTH_SOURCE.indexOf(
		"throw ctx.redirect(redirectTarget);",
		start,
	);
	expect(
		end,
		'expected "throw ctx.redirect(redirectTarget);" to terminate the gate branch',
	).toBeGreaterThan(start);
	return AUTH_SOURCE.slice(start, end);
}

describe("auth.ts wiring — deny-by-default 2FA gate", () => {
	it("decides from the shared gate module rather than its own path list", () => {
		expect(AUTH_SOURCE).toMatch(
			/import\s+\{[^}]*isChallengeGatedMint[^}]*\}\s+from\s+["']\.\/lib\/two-factor-gate["']/,
		);
		expect(AUTH_SOURCE).toMatch(
			/import\s+\{[^}]*safeChallengeRedirectPath[^}]*\}\s+from\s+["']\.\/lib\/two-factor-gate["']/,
		);
		// The allowlist this gate replaced. Its return would silently restore
		// fail-open behaviour for every path nobody enumerated.
		expect(AUTH_SOURCE).not.toContain("isPostSignInPath");
	});

	it("applies the predicate to every path, with the request's own path", () => {
		const gate = sliceGate();
		expect(gate).toMatch(/path:\s*ctx\.path,/);
		expect(gate).toMatch(/newSession,/);
		expect(gate).toMatch(/activeSession,/);
		// The resolved session must come from `ctx.context.session`, which is
		// what `getSessionFromCtx` populates — the discriminator is meaningless
		// against anything else.
		expect(AUTH_SOURCE).toMatch(
			/const activeSession = \(ctx\.context as any\)\.session as/,
		);
		expect(AUTH_SOURCE).toMatch(
			/const newSession = \(ctx\.context as any\)\.newSession as/,
		);
	});

	it("makes the shared predicate the SOLE gate condition", () => {
		// The behaviour suite drives a PORT of this hook, so an extra
		// disjunct or a short-circuit added to production's `if` — `||
		// ctx.path === "/x"`, `&& !someFlag` — would bypass the gate while
		// every behavioural test kept passing. The condition is therefore
		// pinned literally: the predicate call, plus only the `newSession &&`
		// that narrows its type for the branch body.
		const start = AUTH_SOURCE.indexOf("\t\t\tif (\n\t\t\t\tnewSession &&");
		expect(
			start,
			"expected the gate's `if (` to start with the newSession narrowing",
		).toBeGreaterThanOrEqual(0);
		const end = AUTH_SOURCE.indexOf("\n\t\t\t) {", start);
		expect(end).toBeGreaterThan(start);
		const condition = AUTH_SOURCE.slice(start, end)
			.replace(/^\t{3}if \(/, "")
			.replace(/\s+/g, " ")
			.trim();
		expect(condition).toBe(
			"newSession && isChallengeGatedMint({ path: ctx.path, newSession, activeSession, })",
		);
	});

	it("still runs the revoke-then-challenge machinery, in that order", () => {
		const gate = sliceGate();

		// Revoke first, challenge second — the ordering that makes every
		// later failure fail closed.
		const revokeCookie = gate.indexOf(
			"deleteSessionCookie(cookieCtx, true)",
		);
		const clearNewSession = gate.indexOf("ctx.context.setNewSession(null)");
		const deleteSession = gate.indexOf(
			"authCtx.internalAdapter.deleteSession(",
		);
		const createChallenge = gate.indexOf("createTwoFactorChallenge({");
		expect(revokeCookie).toBeGreaterThanOrEqual(0);
		expect(clearNewSession).toBeGreaterThan(revokeCookie);
		expect(deleteSession).toBeGreaterThan(clearNewSession);
		expect(createChallenge).toBeGreaterThan(deleteSession);
		expect(gate).toMatch(/authCtx\.createAuthCookie\(\s*"two_factor",/);
		expect(gate).toMatch(/setSignedCookie\(/);
	});

	it("nulls newSession in the catch independently of the cookie re-scrub", () => {
		// Containment of the in-memory session is what stops a later plugin
		// `after` hook from reading `newSession` and re-installing the
		// credential. A throw from `deleteSessionCookie` must not be able to
		// skip it, so the re-scrub carries its own try/catch.
		expect(AUTH_SOURCE).toMatch(
			/\} catch \(error\) \{[\s\S]{0,900}?try \{\s*deleteSessionCookie\(cookieCtx, true\);\s*\} catch \(cookieError\) \{[\s\S]{0,400}?\}\s*ctx\.context\.setNewSession\(null\);/,
		);
	});

	it("writes only the sanitized navigation target into redirectTo", () => {
		const gate = sliceGate();
		expect(gate).toMatch(
			/const redirectTo = safeChallengeRedirectPath\(\s*rawNavigationTarget,\s*appUrl,\s*\);/,
		);
		expect(gate).toMatch(
			/verifyUrl\.searchParams\.set\("redirectTo", redirectTo\);/,
		);
		// The raw value decides the response SHAPE and nothing else; it must
		// never reach the param.
		expect(gate).not.toMatch(
			/searchParams\.set\(\s*"redirectTo",\s*rawNavigationTarget/,
		);

		// …and the sanitizing happens INSIDE the containment region. It is the
		// step with real URL parsing in it, so if it ever regained the ability
		// to throw, running it ahead of the revoke would leave the browser
		// holding the session this gate was in the middle of taking away.
		const revokeCookie = gate.indexOf(
			"deleteSessionCookie(cookieCtx, true)",
		);
		const clearNewSession = gate.indexOf("ctx.context.setNewSession(null)");
		const deleteSession = gate.indexOf(
			"authCtx.internalAdapter.deleteSession(",
		);
		const sanitize = gate.indexOf("safeChallengeRedirectPath(");
		expect(revokeCookie).toBeGreaterThanOrEqual(0);
		expect(sanitize).toBeGreaterThan(revokeCookie);
		expect(sanitize).toBeGreaterThan(clearNewSession);
		expect(sanitize).toBeGreaterThan(deleteSession);
	});

	it("chooses the response shape from the request, not from the path", () => {
		const gate = sliceGate();
		// A caller that supplied (or was already being sent to) a navigation
		// target is a browser; everything else is an XHR.
		expect(gate).toMatch(
			/const isNavigationRequest = rawNavigationTarget !== undefined;/,
		);
		// Recovered from the query, the body, then the Location header — and
		// every one of them runtime-narrowed to a string. `callbackURL` is
		// unvalidated JSON on an endpoint that declares no body schema, so a
		// `{}` there would otherwise reach a string method and throw AHEAD of
		// the containment block below.
		expect(gate).toMatch(
			/let rawNavigationTarget: string \| undefined;\s*try \{/,
		);
		expect(gate).toMatch(
			/const fromQuery = \(\s*ctx\.query as \{ callbackURL\?: unknown \} \| undefined\s*\)\?\.callbackURL;/,
		);
		expect(gate).toMatch(
			/const fromBody = \(\s*ctx\.body as \{ callbackURL\?: unknown \} \| undefined\s*\)\?\.callbackURL;/,
		);
		expect(gate).toMatch(/responseHeaders\?\.get\("location"\)/);
		expect(gate).toMatch(
			/typeof fromQuery === "string"[\s\S]{0,240}?typeof fromBody === "string"[\s\S]{0,240}?typeof fromLocation === "string"/,
		);
		expect(gate).toMatch(
			/\} catch \{\s*rawNavigationTarget = undefined;\s*\}/,
		);
		// XHR success: the JSON shape better-auth's own two-factor plugin
		// returns, which ConfirmEmailForm already understands. Only once the
		// challenge is actually in place.
		expect(gate).toMatch(
			/if \(challengeIssued && !isNavigationRequest\) \{\s*return ctx\.json\(\{ twoFactorRedirect: true \}\);\s*\}/,
		);
		// XHR failure: an error, not a login page behind a followed 302.
		expect(gate).toMatch(
			/if \(!challengeIssued && !isNavigationRequest\) \{\s*throw new APIError\("INTERNAL_SERVER_ERROR"/,
		);
		// `challengeIssued` is set at the very end of the try block, after the
		// challenge rows and the signed cookie are both in place — never
		// earlier, and never in the catch.
		expect(gate).toMatch(
			/redirectTarget = verifyUrl\.toString\(\);\s*challengeIssued = true;\s*\} catch \(error\) \{/,
		);
		// Navigation requests keep the redirect, to /auth/verify on success
		// and /auth/login on the contained-failure path.
		expect(AUTH_SOURCE).toMatch(/throw ctx\.redirect\(redirectTarget\);/);
		expect(gate).toMatch(
			/redirectTarget = new URL\("\/auth\/login", appUrl\)\.toString\(\);/,
		);
	});

	it("still reaches the mustChangePassword clearing after the gate", () => {
		// `/change-password` is exempt precisely so the gate cannot `throw`
		// past this block. Challenging that path would leave a user under a
		// forced password change with the flag still set — a deadlock, after
		// the password had already been changed and their other sessions
		// revoked.
		const gateEnd =
			AUTH_SOURCE.indexOf("throw ctx.redirect(redirectTarget);") +
			"throw ctx.redirect(redirectTarget);".length;
		const rest = AUTH_SOURCE.slice(gateEnd);
		expect(rest).toMatch(
			/ctx\.path === "\/change-password"[\s\S]{0,1200}?mustChangePassword: false/,
		);
		expect(TWO_FACTOR_GATE_EXEMPT_PATHS.has("/change-password")).toBe(true);
	});
});

describe("audit-events.ts wiring — no second copy of the gate", () => {
	it("predicts the gate's outcome with the gate's own predicate", () => {
		// The audit emission runs BEFORE the gate in the same hook body, so it
		// has to predict. A hand-copied path list would drift in the direction
		// of recording logins that were actually denied.
		expect(AUDIT_SOURCE).toMatch(
			/import\s+\{[^}]*isChallengeGatedMint[^}]*\}\s+from\s+["']\.\/two-factor-gate["']/,
		);
		expect(AUDIT_SOURCE).toMatch(
			/isChallengeGatedMint\(\{\s*path,\s*newSession,\s*activeSession: ctx\.context\?\.session \?\? null,\s*\}\)/,
		);
		expect(AUDIT_SOURCE).not.toContain("isChallengeGatedPath");
	});

	it("asks the shared module both questions on /verify-email (issue #2826)", () => {
		// That branch emits a login row for an auto-sign-in mint, so it needs
		// BOTH halves: did a login happen (`isFreshSessionMint`), and will the
		// gate let it stand (`!isChallengeGatedMint`). Re-deriving either one
		// locally is how the audit trail and the gate start disagreeing about
		// the same request — the row says a user logged in, the gate has
		// already revoked the session.
		expect(AUDIT_SOURCE).toMatch(
			/import\s+\{[^}]*isFreshSessionMint[^}]*\}\s+from\s+["']\.\/two-factor-gate["']/,
		);
		// `lastIndexOf`: the first occurrence of this test is the authMethod
		// lookup near the top of the function, not the emission branch.
		const start = AUDIT_SOURCE.lastIndexOf(
			'if (path === "/verify-email") {',
		);
		expect(
			start,
			'expected a "/verify-email" emission branch in audit-events.ts',
		).toBeGreaterThanOrEqual(0);
		const branch = AUDIT_SOURCE.slice(start, start + 900);
		expect(branch).toMatch(
			/isFreshSessionMint\(newSession, sessionLike\)\s*&&\s*!isChallengeGatedMint\(\{\s*path,\s*newSession,\s*activeSession: sessionLike,\s*\}\)/,
		);
		// The locally-derived discriminator this replaced. Its return would
		// mean two definitions of "fresh mint" in one file.
		expect(branch).not.toMatch(/const isFreshSessionMint\s*=/);
	});
});

describe("production two-factor config", () => {
	it("never enables skipVerificationOnEnable", () => {
		// With it set, /two-factor/enable starts minting a twoFactorEnabled
		// session with no factor proof — and that path is deliberately NOT
		// exempt, so the gate would challenge it. Turning it on is a security
		// decision, not a config tweak.
		expect(POLICY_SOURCE).not.toContain("skipVerificationOnEnable");
		expect(AUTH_SOURCE).not.toContain("skipVerificationOnEnable");
	});

	it("keeps the paths better-auth's own 2FA hook owns exempt", () => {
		// Config `hooks.after` runs before plugin after-hooks, so challenging
		// these here would pre-empt the built-in plugin's own challenge —
		// including its trust-device exception.
		for (const path of [
			"/sign-in/email",
			"/sign-in/username",
			"/sign-in/phone-number",
		]) {
			expect(TWO_FACTOR_GATE_EXEMPT_PATHS.has(path)).toBe(true);
		}
	});

	it("exempts none of the 2FA management endpoints", () => {
		// The step-up grant (issue #2827) makes "a call that reached this
		// handler is already factor-proven" true for these four, which makes
		// exempting them look free. None of them needs it — none mints a
		// session this gate would classify (behaviourally pinned in
		// `verify-email-two-factor-behavior.test.ts`) — so an exemption here
		// would only widen the bypass surface for no gain.
		for (const path of STEP_UP_MANAGED_PATHS) {
			expect(
				TWO_FACTOR_GATE_EXEMPT_PATHS.has(path),
				`${path} must not be exempt`,
			).toBe(false);
		}
	});

	it("exempts every endpoint that completes a second factor", () => {
		// The mirror of the above: the step-up module's own list of paths that
		// COMPARE a submitted code is exactly the set this gate must let mint,
		// or challenge completion loops forever. Sharing the constant means a
		// path added upstream cannot land on one list and miss the other.
		for (const path of STEP_UP_GATED_PATHS) {
			expect(
				TWO_FACTOR_GATE_EXEMPT_PATHS.has(path),
				`${path} must be exempt`,
			).toBe(true);
		}
	});
});
