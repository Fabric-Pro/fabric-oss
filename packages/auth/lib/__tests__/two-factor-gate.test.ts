/**
 * Unit tests for the deny-by-default 2FA gate's pure parts
 * (../two-factor-gate.ts, GitHub issue #2825).
 *
 * The end-to-end behaviour is locked by
 * `verify-email-two-factor-behavior.test.ts` against a real better-auth
 * pipeline; this file pins the decisions that suite cannot make visible one at
 * a time — the exact membership of the exemption set, the discriminator's
 * fail-closed edges, and every rejection the redirect sanitizer has to make.
 *
 * Run with: pnpm --filter @repo/auth test lib/__tests__/two-factor-gate.test.ts
 */

import { describe, expect, it } from "vitest";
import {
	isChallengeGatedMint,
	isFreshSessionMint,
	safeChallengeRedirectPath,
	TWO_FACTOR_GATE_EXEMPT_PATHS,
} from "../two-factor-gate";

const APP_URL = "https://app.example.com";

const twoFactorUser = { twoFactorEnabled: true };

function mint(token: string) {
	return { session: { token }, user: twoFactorUser };
}

function active(token: string) {
	return { session: { token } };
}

describe("TWO_FACTOR_GATE_EXEMPT_PATHS", () => {
	it("contains exactly the paths that may mint without a second factor", () => {
		// Pinned as an exact list, not a subset check: adding an entry is a
		// 2FA bypass for that path and has to be a deliberate edit here too.
		expect([...TWO_FACTOR_GATE_EXEMPT_PATHS].sort()).toEqual([
			"/admin/impersonate-user",
			"/admin/stop-impersonating",
			"/change-password",
			"/passkey/verify-authentication",
			"/sign-in/email",
			"/sign-in/phone-number",
			"/sign-in/username",
			"/two-factor/verify-backup-code",
			"/two-factor/verify-otp",
			"/two-factor/verify-totp",
		]);
	});

	it("does not exempt /two-factor/enable", () => {
		// Inert today (`skipVerificationOnEnable` is unset, so the endpoint
		// never mints), but if that option is ever turned on it would hand out
		// a twoFactorEnabled session with no factor proof — the exact thing
		// the gate exists to challenge.
		expect(TWO_FACTOR_GATE_EXEMPT_PATHS.has("/two-factor/enable")).toBe(
			false,
		);
	});

	it("matches exactly, so near-miss paths are not exempt", () => {
		for (const path of [
			"/admin/stop-impersonating/foo",
			"/sign-in/email/callback",
			"/two-factor/verify-totp-x",
			"two-factor/verify-totp",
			"/change-password/confirm",
		]) {
			expect(
				isChallengeGatedMint({
					path,
					newSession: mint("new"),
					activeSession: null,
				}),
				`${path} must not inherit an exemption`,
			).toBe(true);
		}
	});
});

describe("isFreshSessionMint", () => {
	it("is false when nothing was minted", () => {
		expect(isFreshSessionMint(null, active("existing"))).toBe(false);
		expect(isFreshSessionMint(undefined, active("existing"))).toBe(false);
	});

	it("is false when the minted token matches the one resolved from the request", () => {
		// A cookie rewrite for a session the request already carried —
		// /organization/set-active, an address change, a sliding-expiry bump.
		expect(isFreshSessionMint(mint("same"), active("same"))).toBe(false);
	});

	it("is true when the tokens differ", () => {
		expect(isFreshSessionMint(mint("new"), active("old"))).toBe(true);
	});

	it("fails closed when no active token can be read", () => {
		// The old, /verify-email-scoped expression compared
		// `newSession?.session?.token !== activeSession?.session?.token`, which
		// calls `undefined !== undefined` a refresh — so a malformed or absent
		// active session waved the mint through unchallenged.
		expect(isFreshSessionMint(mint("new"), null)).toBe(true);
		expect(isFreshSessionMint(mint("new"), undefined)).toBe(true);
		expect(isFreshSessionMint(mint("new"), {})).toBe(true);
		expect(isFreshSessionMint(mint("new"), { session: {} })).toBe(true);
		expect(
			isFreshSessionMint(mint("new"), {
				session: { token: undefined },
			}),
		).toBe(true);
		expect(
			isFreshSessionMint(
				mint("new"),
				// A non-string token is unclassifiable, not a match.
				{ session: { token: 42 } } as unknown as {
					session?: { token?: string };
				},
			),
		).toBe(true);
	});

	it("fails closed when the mint itself has no readable token", () => {
		expect(
			isFreshSessionMint(
				{ session: {}, user: twoFactorUser },
				active("existing"),
			),
		).toBe(true);
	});
});

describe("isChallengeGatedMint", () => {
	it("gates a fresh mint for a 2FA user on a non-exempt path", () => {
		expect(
			isChallengeGatedMint({
				path: "/magic-link/verify",
				newSession: mint("new"),
				activeSession: null,
			}),
		).toBe(true);
	});

	it("does not gate a user without 2FA", () => {
		expect(
			isChallengeGatedMint({
				path: "/magic-link/verify",
				newSession: {
					session: { token: "new" },
					user: { twoFactorEnabled: false },
				},
				activeSession: null,
			}),
		).toBe(false);
		expect(
			isChallengeGatedMint({
				path: "/magic-link/verify",
				newSession: { session: { token: "new" }, user: {} },
				activeSession: null,
			}),
		).toBe(false);
	});

	it("does not gate a refresh of an existing session", () => {
		expect(
			isChallengeGatedMint({
				path: "/organization/set-active",
				newSession: mint("same"),
				activeSession: active("same"),
			}),
		).toBe(false);
	});

	it("does not gate any exempt path, even on a fresh mint", () => {
		for (const path of TWO_FACTOR_GATE_EXEMPT_PATHS) {
			expect(
				isChallengeGatedMint({
					path,
					newSession: mint("new"),
					activeSession: active("old"),
				}),
				`${path} is exempt`,
			).toBe(false);
		}
	});

	it("does not gate a request that minted nothing", () => {
		expect(
			isChallengeGatedMint({
				path: "/two-factor/enable",
				newSession: null,
				activeSession: active("existing"),
			}),
		).toBe(false);
	});
});

describe("safeChallengeRedirectPath", () => {
	it("keeps a relative path as-is", () => {
		expect(safeChallengeRedirectPath("/app/projects", APP_URL)).toBe(
			"/app/projects",
		);
		expect(safeChallengeRedirectPath("/app?tab=1#top", APP_URL)).toBe(
			"/app?tab=1#top",
		);
	});

	it("normalizes a same-origin absolute URL to a relative path", () => {
		// magic-link and OAuth hand the hook fully qualified same-origin
		// targets, so rejecting absolute URLs outright would drop every
		// legitimate redirect on the two paths that most need one.
		expect(
			safeChallengeRedirectPath(
				"https://app.example.com/app/projects?tab=1#top",
				APP_URL,
			),
		).toBe("/app/projects?tab=1#top");
		// A trailing-slash / path-carrying appUrl still compares by origin.
		expect(
			safeChallengeRedirectPath(
				"https://app.example.com/app",
				"https://app.example.com/",
			),
		).toBe("/app");
	});

	it("rejects anything that could leave the origin", () => {
		for (const hostile of [
			"https://evil.example/app",
			"http://app.example.com/app", // scheme mismatch → different origin
			"https://app.example.com.evil.example/app",
			"//evil.example",
			"//evil.example/app",
			"/\\evil.example",
			"\\\\evil.example",
			// Opaque-origin schemes resolve with `origin === "null"`, which
			// would compare equal to itself if the check were a bare
			// inequality — the explicit "null" guard is what rejects these.
			"javascript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"",
		]) {
			expect(
				safeChallengeRedirectPath(hostile, APP_URL),
				`${hostile} must be rejected`,
			).toBeNull();
		}
	});

	it("rejects control-character smuggling that prefix checks cannot see", () => {
		// THE bypass this validator resolves against a base to close: WHATWG
		// URL parsing STRIPS ASCII tab / LF / CR before interpreting a URL, so
		// each of these reaches another host while starting with exactly one
		// slash followed by a character that is neither "/" nor "\".
		//   new URL("/\t/evil.example", "https://app.example.com").href
		//     === "https://evil.example/"
		for (const hostile of [
			"/\t/evil.example",
			"/\n/evil.example",
			"/\r/evil.example",
			"/\t\\evil.example",
			"/\u0000/evil.example",
			"/app\u007f/x",
			"htt\tps://evil.example",
		]) {
			expect(
				safeChallengeRedirectPath(hostile, APP_URL),
				`${JSON.stringify(hostile)} must be rejected`,
			).toBeNull();
		}
	});

	it("resolves relative targets against appUrl rather than inspecting their prefix", () => {
		// The accepted set is defined by where a value RESOLVES, not by how it
		// starts — which is the only rule a parsing quirk cannot slip past.
		expect(safeChallengeRedirectPath("/app/settings", APP_URL)).toBe(
			"/app/settings",
		);
		// Same-origin by resolution, so it is accepted and normalized rather
		// than rejected for lacking a leading slash.
		expect(safeChallengeRedirectPath("app/projects", APP_URL)).toBe(
			"/app/projects",
		);
		expect(safeChallengeRedirectPath("/./app/../app/x", APP_URL)).toBe(
			"/app/x",
		);
	});

	it("is total over unknown input and never throws", () => {
		// It runs inside the gate's fail-closed containment region, where a
		// throw would skip revocation. `callbackURL` is unvalidated JSON on an
		// endpoint that declares no body schema, so it can be any shape.
		for (const value of [
			{},
			[],
			42,
			true,
			Symbol("x"),
			() => "/app",
			new Date(),
			Number.NaN,
		]) {
			expect(() =>
				safeChallengeRedirectPath(value, APP_URL),
			).not.toThrow();
			expect(safeChallengeRedirectPath(value, APP_URL)).toBeNull();
		}
	});

	it("rejects a same-origin URL whose path is protocol-relative once flattened", () => {
		// `pathname` always starts with "/", but "//evil.example" as a bare
		// path is read as an absolute URL by the browser that follows it.
		expect(
			safeChallengeRedirectPath(
				"https://app.example.com//evil.example",
				APP_URL,
			),
		).toBeNull();
	});

	it("rejects absent input and an unparseable appUrl", () => {
		expect(safeChallengeRedirectPath(null, APP_URL)).toBeNull();
		expect(safeChallengeRedirectPath(undefined, APP_URL)).toBeNull();
		expect(
			safeChallengeRedirectPath(
				"https://app.example.com/app",
				"not a url",
			),
		).toBeNull();
	});
});
