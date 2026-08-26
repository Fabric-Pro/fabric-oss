/**
 * Drift guard for the 2FA management step-up
 * (../two-factor-management-step-up.ts).
 *
 * The gate is a hook bolted onto endpoints this repo does not own, so it rests
 * on four upstream facts. Each of them fails SILENTLY if it changes — a renamed
 * path simply stops being gated, a renamed error code turns a typo'd password
 * into a spent grant, and a newly-mounted `view-backup-codes` would hand out
 * plaintext codes through a route nothing checks. So each is pinned
 * behaviourally here:
 *
 *  1. The four management endpoints still live at the paths the gate matches on,
 *     and still gate on the password alone — which is the whole reason the gate
 *     exists.
 *  2. A wrong password still rejects with `INVALID_PASSWORD`, and a malformed
 *     body still rejects with `VALIDATION_ERROR`. Those two codes are the
 *     restore allowlist; if either moves, a rejected call silently costs the
 *     user their verification.
 *  3. `/two-factor/view-backup-codes` is still server-only, i.e. absent from the
 *     HTTP router. If it ever appears there it needs the gate too.
 *  4. The signed-cookie mechanism the grant rides on — `createAuthCookie` +
 *     `setSignedCookie` / `getSignedCookie`, the same pair the plugin uses for
 *     its own trusted-device cookie — still round-trips, still rejects a
 *     tampered value, and still produces an HttpOnly cookie.
 *
 * Asserted against the PUBLIC surface (`auth.api.*`, `auth.handler`, and
 * `better-auth/{api,cookies}`), never `better-auth/dist/**` and never a version
 * string.
 *
 * Run with: pnpm --filter @repo/auth test lib/__tests__/two-factor-management-step-up-drift.test.ts
 */

import { createAuthEndpoint } from "better-auth/api";
import { expireCookie, parseSetCookieHeader } from "better-auth/cookies";
import { twoFactor } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { describe, expect, it } from "vitest";
import {
	STEP_UP_GRANT_COOKIE_NAME,
	STEP_UP_GRANT_TTL_MS,
	STEP_UP_MANAGED_PATHS,
	STEP_UP_RESTORABLE_FAILURE_CODES,
} from "../two-factor-management-step-up";
import {
	enrollTwoFactorAndAuthenticate,
	extractCookie,
} from "./two-factor-test-helpers";

type TestAuth = any;

const BASE = "http://localhost:3000/api/auth";
const COOKIE_PAYLOAD = "session-id-abc!1755300000000";

/**
 * A test-only plugin that drives EXACTLY the three cookie operations the grant
 * uses, through real endpoints on a real instance — rather than reimplementing
 * them against a synthetic context, which would pin nothing.
 */
function cookieProbePlugin() {
	const cookieFor = (ctx: any) =>
		ctx.context.createAuthCookie(STEP_UP_GRANT_COOKIE_NAME, {
			maxAge: Math.floor(STEP_UP_GRANT_TTL_MS / 1000),
		});
	return {
		id: "test-step-up-cookie-probe",
		endpoints: {
			setStepUpProbeCookie: createAuthEndpoint(
				"/test-step-up-cookie/set",
				{ method: "POST" },
				async (ctx: any) => {
					const cookie = cookieFor(ctx);
					await ctx.setSignedCookie(
						cookie.name,
						COOKIE_PAYLOAD,
						ctx.context.secret,
						cookie.attributes,
					);
					return ctx.json({ name: cookie.name });
				},
			),
			readStepUpProbeCookie: createAuthEndpoint(
				"/test-step-up-cookie/read",
				{ method: "POST" },
				async (ctx: any) => {
					const value = await ctx.getSignedCookie(
						cookieFor(ctx).name,
						ctx.context.secret,
					);
					// Encoded rather than returned raw so the three outcomes
					// (`string` / `false` / `null`) survive JSON.
					return ctx.json({
						kind:
							typeof value === "string"
								? "value"
								: value === false
									? "bad-signature"
									: "absent",
						value: typeof value === "string" ? value : null,
					});
				},
			),
			expireStepUpProbeCookie: createAuthEndpoint(
				"/test-step-up-cookie/expire",
				{ method: "POST" },
				async (ctx: any) => {
					expireCookie(ctx, cookieFor(ctx));
					return ctx.json({ ok: true });
				},
			),
		},
	};
}

async function setupUpstreamOnly() {
	return getTestInstance({
		plugins: [
			twoFactor({ skipVerificationOnEnable: true }),
			cookieProbePlugin() as never,
		],
	});
}

function post(auth: TestAuth, path: string, body: unknown, cookie?: string) {
	return auth.handler(
		new Request(`${BASE}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:3000",
				...(cookie ? { cookie } : {}),
			},
			body: JSON.stringify(body),
		}),
	) as Promise<Response>;
}

describe("better-auth 2FA management endpoint drift", () => {
	it("pins the four password-gated management paths the gate matches on", () => {
		expect([...STEP_UP_MANAGED_PATHS]).toEqual([
			"/two-factor/disable",
			"/two-factor/enable",
			"/two-factor/generate-backup-codes",
			"/two-factor/get-totp-uri",
		]);
	});

	it("still gates all four on the password alone, rejecting a wrong one with INVALID_PASSWORD", async () => {
		// The premise of the whole change: with a valid session and the right
		// password these four succeed, and upstream asks for nothing else. The
		// wrong-password rejection is asserted through the HTTP router, which is
		// also what pins the path strings above.
		const instance = await setupUpstreamOnly();
		const auth = instance.auth as TestAuth;
		const { sessionCookie } =
			await enrollTwoFactorAndAuthenticate(instance);

		for (const path of STEP_UP_MANAGED_PATHS) {
			const res = await post(
				auth,
				path,
				{ password: "not-the-password" },
				sessionCookie,
			);
			expect(res.status, path).toBe(400);
			expect((await res.json()).code, path).toBe("INVALID_PASSWORD");
		}
	});

	it("still rejects a malformed body with VALIDATION_ERROR before the handler runs", async () => {
		const instance = await setupUpstreamOnly();
		const auth = instance.auth as TestAuth;
		const { sessionCookie } =
			await enrollTwoFactorAndAuthenticate(instance);

		const res = await post(auth, "/two-factor/disable", {}, sessionCookie);
		expect(res.status).toBe(400);
		expect((await res.json()).code).toBe("VALIDATION_ERROR");
	});

	it("pins the restore allowlist to the two codes that are provably pre-side-effect", () => {
		// Widening this is a security decision, not a bug fix: `/two-factor/enable`
		// and `/two-factor/disable` can fail part-way, and restoring a grant after
		// a partial mutation lets the next call act on half-changed state.
		expect([...STEP_UP_RESTORABLE_FAILURE_CODES]).toEqual([
			"INVALID_PASSWORD",
			"VALIDATION_ERROR",
		]);
	});

	it("still keeps view-backup-codes off the HTTP router", async () => {
		// It is `createAuthEndpoint.serverOnly`, which is why the gate does not
		// cover it. If this ever answers, the endpoint hands plaintext backup
		// codes to anyone with a session and needs gating.
		const instance = await setupUpstreamOnly();
		const auth = instance.auth as TestAuth;
		const { sessionCookie, userId } =
			await enrollTwoFactorAndAuthenticate(instance);

		const res = await post(
			auth,
			"/two-factor/view-backup-codes",
			{ userId },
			sessionCookie,
		);
		expect(res.status).toBe(404);

		// Still reachable server-side, which is how the repo's own
		// `getBackupCodesStatus` procedure reads the count.
		expect(typeof auth.api.viewBackupCodes).toBe("function");
	});
});

describe("better-auth signed-cookie mechanism drift", () => {
	it("still issues the grant cookie HttpOnly, path-scoped and TTL-bounded", async () => {
		const instance = await setupUpstreamOnly();
		const auth = instance.auth as TestAuth;

		const res = await post(auth, "/test-step-up-cookie/set", {});
		const raw = res.headers.getSetCookie()[0];
		const attrs = [...parseSetCookieHeader(raw).values()][0];

		expect(raw).toContain(STEP_UP_GRANT_COOKIE_NAME);
		expect(attrs.httponly).toBe(true);
		expect(attrs.path).toBe("/");
		expect(attrs["max-age"]).toBe(STEP_UP_GRANT_TTL_MS / 1000);
	});

	it("still round-trips a signed value, and refuses a tampered one", async () => {
		const instance = await setupUpstreamOnly();
		const auth = instance.auth as TestAuth;

		const setRes = await post(auth, "/test-step-up-cookie/set", {});
		const cookie = extractCookie(setRes.headers, STEP_UP_GRANT_COOKIE_NAME);

		const readRes = await post(
			auth,
			"/test-step-up-cookie/read",
			{},
			cookie,
		);
		expect(await readRes.json()).toEqual({
			kind: "value",
			value: COOKIE_PAYLOAD,
		});

		// A forged payload carrying the original signature: the signature must
		// fail, which is what stops a caller minting themselves a grant for
		// another session id.
		const separator = cookie.indexOf("=");
		const name = cookie.slice(0, separator);
		const decoded = decodeURIComponent(cookie.slice(separator + 1));
		const signature = decoded.slice(decoded.lastIndexOf("."));
		const tampered = `${name}=${encodeURIComponent(`attacker-session!1755300000000${signature}`)}`;
		const tamperedRes = await post(
			auth,
			"/test-step-up-cookie/read",
			{},
			tampered,
		);
		expect((await tamperedRes.json()).kind).toBe("bad-signature");

		const absentRes = await post(auth, "/test-step-up-cookie/read", {});
		expect((await absentRes.json()).kind).toBe("absent");
	});

	it("still expires the cookie by re-issuing it with Max-Age 0", async () => {
		const instance = await setupUpstreamOnly();
		const auth = instance.auth as TestAuth;

		const res = await post(auth, "/test-step-up-cookie/expire", {});
		const raw = res.headers.getSetCookie()[0];
		const attrs = [...parseSetCookieHeader(raw).values()][0];

		expect(raw).toContain(STEP_UP_GRANT_COOKIE_NAME);
		expect(attrs["max-age"]).toBe(0);
	});
});
