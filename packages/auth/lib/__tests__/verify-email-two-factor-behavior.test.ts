/**
 * Behavioral (black-box) suite for the deny-by-default 2FA challenge gate
 * (GitHub issue #2825, and the `/verify-email` finding it grew out of — issue
 * #2805, finding 3), driven against better-auth's own public test harness
 * (`better-auth/test`'s `getTestInstance`, an in-memory `node:sqlite` instance
 * with a real request/response cycle running in-process) — never
 * `better-auth/dist/**`.
 *
 * WHY THIS FILE EXISTS. The gate no longer enumerates the paths it challenges;
 * it challenges every fresh session mint for a `twoFactorEnabled` user and
 * exempts a listed few (`../two-factor-gate.ts`). That inversion closes the
 * fail-open hole — `/verify-email` alone mints on three branches, only one of
 * which honours `autoSignInAfterVerification` — but it puts every
 * session-touching endpoint in the blast radius. So the negative half of this
 * suite matters as much as the positive half: a refresh-shaped request from a
 * 2FA user (a cookie rewrite, an org switch, a sliding-expiry bump) must come
 * through untouched, or the gate logs the whole product out.
 *
 * WHAT IS PINNED WHERE. `auth.ts` builds the Better Auth instance at
 * module-load time with dozens of side-effecting dependencies, so — by the
 * precedent of `passkey-policy-wiring.test.ts` and
 * `invite-reconciliation-wiring.test.ts` — it is not booted inside a Vitest
 * worker. The hook below is a port of that branch, exercised end-to-end
 * against a real better-auth pipeline; that production source actually says
 * what this port says is pinned separately and statically by
 * `verify-email-two-factor-wiring.test.ts`. The port shares the real decision
 * logic (`../two-factor-gate`) and the real challenge-row writer
 * (`../two-factor-challenge`) rather than reimplementing either, so only the
 * plumbing between them can drift.
 *
 * The instance boots with production's plugin set (username, admin, the
 * configured passkey wrapper, magic-link, organization, the configured
 * two-factor plugin), because a negative assertion against a surface that
 * isn't registered proves nothing.
 *
 * The `observed` log the hook keeps is the other half of the point: it
 * records, per request, the token Better Auth minted and the token it resolved
 * from the incoming cookie. Those two values are the entire basis for the
 * fresh-mint discriminator, and a better-auth upgrade that changed either one
 * (say, by rotating the token on a cookie refresh) would break the gate
 * silently in production but loudly here.
 *
 * Run with: pnpm --filter @repo/auth test lib/__tests__/verify-email-two-factor-behavior.test.ts
 */

import type { BetterAuthPlugin } from "better-auth";
import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
	createEmailVerificationToken,
	sessionMiddleware,
} from "better-auth/api";
import {
	deleteSessionCookie,
	parseSetCookieHeader,
	setSessionCookie,
} from "better-auth/cookies";
import { admin, magicLink, organization, username } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { describe, expect, it } from "vitest";
import { createPasskeyPlugin } from "../passkey-policy";
import { createTwoFactorChallenge } from "../two-factor-challenge";
import {
	isChallengeGatedMint,
	safeChallengeRedirectPath,
	TWO_FACTOR_GATE_EXEMPT_PATHS,
} from "../two-factor-gate";
import { createTwoFactorPlugin } from "../two-factor-policy";

const TEST_SECRET = "verify-email-2fa-secret-long-enough-for-boot-validation";
const APP_URL = "http://localhost:3000";
const NEW_EMAIL = "changed@example.com";

// The instance type varies with the plugin list passed to getTestInstance;
// narrowing it fully isn't worth it here, so the handful of `auth.api.*`
// calls this file makes are typed loosely via this alias.
type TestAuth = any;

interface Observation {
	path: string;
	/** Token of the session Better Auth minted or refreshed on this request. */
	newSessionToken: string | null;
	/** Token resolved from the incoming cookie, via `getSessionFromCtx`. */
	activeSessionToken: string | null;
	twoFactorEnabled: boolean;
	/** What the shared predicate decided for this request. */
	gated: boolean;
	/** Whether a challenge was actually installed (rows + signed cookie). */
	challenged: boolean;
}

/**
 * Port of the 2FA gate in `packages/auth/auth.ts`'s `hooks.after`, trimmed to
 * the statements that carry behaviour (the production copy carries the full
 * rationale in comments). The decision itself is not ported — it is imported
 * from `../two-factor-gate`, the same module production consults. Kept honest
 * by `verify-email-two-factor-wiring.test.ts`.
 */
function buildEnforcementHook(observed: Observation[]) {
	return createAuthMiddleware(async (ctx) => {
		const newSession = (ctx.context as any).newSession as
			| {
					session: { token: string };
					user: { id: string; twoFactorEnabled?: boolean | null };
			  }
			| null
			| undefined;
		const activeSession = (ctx.context as any).session as
			| { session?: { token?: string } }
			| null
			| undefined;

		const gated =
			!!newSession &&
			isChallengeGatedMint({
				path: ctx.path,
				newSession,
				activeSession,
			});

		const observation: Observation = {
			path: ctx.path,
			newSessionToken: newSession?.session?.token ?? null,
			activeSessionToken: activeSession?.session?.token ?? null,
			twoFactorEnabled: Boolean(newSession?.user?.twoFactorEnabled),
			gated,
			challenged: false,
		};
		observed.push(observation);

		if (!gated || !newSession) {
			return;
		}

		const authCtx = ctx.context as any;
		const cookieCtx = ctx as unknown as Parameters<
			typeof deleteSessionCookie
		>[0];

		let redirectTarget: string;
		let challengeIssued = false;

		// Total by construction, and outside containment only because of that:
		// a non-string `callbackURL` reads as absent rather than reaching a
		// string method. Mirrors production.
		let rawNavigationTarget: string | undefined;
		try {
			const fromQuery = (
				ctx.query as { callbackURL?: unknown } | undefined
			)?.callbackURL;
			const fromBody = (ctx.body as { callbackURL?: unknown } | undefined)
				?.callbackURL;
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
		const isNavigationRequest = rawNavigationTarget !== undefined;

		try {
			const maxAgeSeconds = 3 * 60;

			deleteSessionCookie(cookieCtx, true);
			ctx.context.setNewSession(null);
			await authCtx.internalAdapter.deleteSession(
				newSession.session.token,
			);

			const { identifier } = await createTwoFactorChallenge({
				internalAdapter: authCtx.internalAdapter,
				userId: newSession.user.id,
				maxAgeSeconds,
				ctx,
			});

			const cookieConfig = authCtx.createAuthCookie("two_factor", {
				maxAge: maxAgeSeconds,
			});
			await (
				ctx as unknown as {
					setSignedCookie: (
						name: string,
						value: string,
						secret: string,
						attributes: Record<string, unknown>,
					) => Promise<void>;
				}
			).setSignedCookie(
				cookieConfig.name,
				identifier,
				authCtx.secret,
				cookieConfig.attributes,
			);

			// Sanitized inside containment, as production does.
			const redirectTo = safeChallengeRedirectPath(
				rawNavigationTarget,
				APP_URL,
			);
			const verifyUrl = new URL("/auth/verify", APP_URL);
			if (redirectTo) {
				verifyUrl.searchParams.set("redirectTo", redirectTo);
			}

			redirectTarget = verifyUrl.toString();
			challengeIssued = true;
		} catch {
			try {
				deleteSessionCookie(cookieCtx, true);
			} catch {
				/* containment below must not depend on the cookie helper */
			}
			ctx.context.setNewSession(null);
			redirectTarget = new URL("/auth/login", APP_URL).toString();
		}

		observation.challenged = challengeIssued;

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
	});
}

/**
 * Endpoints that stand in for session-minting surfaces this repo does not
 * register but better-auth's shape permits — a sessionless mint (magic-link
 * shaped), a rekey of the caller's own session (/change-password shaped), and
 * a plain cookie refresh (/organization/set-active shaped).
 *
 * They exist because the interesting negative cases are about the SHAPE of the
 * mint, not about any one endpoint: driving them through the real pipeline
 * proves the discriminator on inputs no registered endpoint produces on
 * demand, and gives the redirect sanitizer a gated path with no `originCheck`
 * middleware in front of it — which is exactly the situation deny-by-default
 * newly creates.
 */
function testMintPlugin() {
	return {
		id: "test-mint",
		endpoints: {
			testMintSession: createAuthEndpoint(
				"/test/mint-session",
				{ method: "GET" },
				async (ctx) => {
					const query = ctx.query as Record<string, string>;
					const user = await ctx.context.internalAdapter.findUserById(
						query.userId,
					);
					const session =
						await ctx.context.internalAdapter.createSession(
							query.userId,
							false,
						);
					await setSessionCookie(ctx, { session, user: user as any });
					return ctx.json({ status: true });
				},
			),
			testRekeySession: createAuthEndpoint(
				"/test/rekey-session",
				{ method: "GET", use: [sessionMiddleware] },
				async (ctx) => {
					const current = ctx.context.session as {
						session: { token: string };
						user: { id: string };
					};
					const session =
						await ctx.context.internalAdapter.createSession(
							current.user.id,
							false,
						);
					await setSessionCookie(ctx, {
						session,
						user: current.user as any,
					});
					await ctx.context.internalAdapter.deleteSession(
						current.session.token,
					);
					return ctx.json({ status: true });
				},
			),
			testRefreshSession: createAuthEndpoint(
				"/test/refresh-session",
				{ method: "GET", use: [sessionMiddleware] },
				async (ctx) => {
					const current = ctx.context.session as {
						session: unknown;
						user: unknown;
					};
					await setSessionCookie(ctx, {
						session: current.session as any,
						user: current.user as any,
					});
					return ctx.json({ status: true });
				},
			),
		},
	} satisfies BetterAuthPlugin;
}

let capturedMagicLink: string | null = null;

/**
 * A better-auth instance wired the way production is: the full plugin set, the
 * session cookie cache on (so the "no replayable credential survives"
 * assertions have `session_data` chunks to be true about), `changeEmail` and
 * `autoSignInAfterVerification` enabled, and the gate installed as
 * `hooks.after`.
 */
async function setup() {
	const observed: Observation[] = [];
	capturedMagicLink = null;
	const instance = await getTestInstance({
		secret: TEST_SECRET,
		baseURL: APP_URL,
		plugins: [
			username(),
			admin(),
			createPasskeyPlugin(),
			magicLink({
				sendMagicLink: async ({ url }) => {
					capturedMagicLink = url;
				},
			}),
			organization(),
			createTwoFactorPlugin(),
			testMintPlugin(),
		],
		session: {
			cookieCache: { enabled: true, maxAge: 5 * 60 },
		},
		user: {
			changeEmail: {
				enabled: true,
				sendChangeEmailConfirmation: async () => {
					/* the tests mint their own tokens */
				},
			},
		},
		emailVerification: {
			autoSignInAfterVerification: true,
			sendVerificationEmail: async () => {
				/* the tests mint their own tokens */
			},
		},
		hooks: { after: buildEnforcementHook(observed) },
	});
	return { ...instance, observed };
}

type Instance = Awaited<ReturnType<typeof setup>>;

/** RFC 4648 base32, no padding — the encoding `otpauth://` URIs carry. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function decodeBase32(input: string): string {
	let buffer = 0;
	let bits = 0;
	let out = "";
	for (const char of input.replace(/=+$/, "").toUpperCase()) {
		const value = BASE32_ALPHABET.indexOf(char);
		if (value === -1) {
			throw new Error(`invalid base32 character: ${char}`);
		}
		buffer = (buffer << 5) | value;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			out += String.fromCharCode((buffer >>> bits) & 0xff);
		}
	}
	return out;
}

interface EnrolledUser {
	headers: Headers;
	userId: string;
	sessionToken: string;
	/** The decoded TOTP secret, for minting further codes. */
	secret: string;
	backupCodes: string[];
}

/**
 * Enroll a user in TOTP through the real two-step flow: `/two-factor/enable`
 * stores an unverified secret, `/two-factor/verify-totp` confirms it, flips
 * `twoFactorEnabled`, and REKEYS the session.
 *
 * That last part is why the flow is driven for real rather than short-cut with
 * `skipVerificationOnEnable`: the enrollment mint is itself a fresh mint for a
 * now-`twoFactorEnabled` user, so it only survives because
 * `/two-factor/verify-totp` is exempt. A fixture that enrolled by any other
 * route would hide the one case where breaking that exemption is silent.
 */
async function enrollTwoFactor(
	instance: Instance,
	credentials?: { email: string; password: string },
): Promise<EnrolledUser> {
	const auth = instance.auth as TestAuth;
	const signedIn = credentials
		? await instance.signInWithUser(credentials.email, credentials.password)
		: await instance.signInWithTestUser();
	const password = credentials?.password ?? instance.testUser.password;
	const headers = signedIn.headers;

	const enabled = await auth.api.enableTwoFactor({
		body: { password },
		headers,
	});
	const encodedSecret = new URL(enabled.totpURI).searchParams.get("secret");
	expect(encodedSecret).toBeTruthy();
	const secret = decodeBase32(encodedSecret as string);

	const verified = await auth.api.verifyTOTP({
		body: { code: await totpCode(instance, secret) },
		headers,
		returnHeaders: true,
	});

	// The enrollment mint replaced the session, so the live credential is the
	// cookie on THIS response, not the one sign-in captured.
	const enrolledHeaders = cookieHeaderFrom(verified.headers);
	const current = await auth.api.getSession({ headers: enrolledHeaders });
	expect(current?.user?.twoFactorEnabled).toBe(true);

	return {
		headers: enrolledHeaders,
		userId: current.user.id as string,
		sessionToken: current.session.token as string,
		secret,
		backupCodes: enabled.backupCodes as string[],
	};
}

async function totpCode(instance: Instance, secret: string): Promise<string> {
	const auth = instance.auth as TestAuth;
	const { code } = await auth.api.generateTOTP({ body: { secret } });
	return code as string;
}

function readSetCookies(headers: Headers): Array<{
	name: string;
	value: string;
}> {
	const rawSetCookies =
		typeof headers.getSetCookie === "function"
			? headers.getSetCookie()
			: [headers.get("set-cookie")].filter((v): v is string => !!v);
	const out: Array<{ name: string; value: string }> = [];
	for (const raw of rawSetCookies) {
		for (const [name, attrs] of parseSetCookieHeader(raw)) {
			out.push({ name, value: attrs.value ?? "" });
		}
	}
	return out;
}

/** Build a request `cookie` header from every non-empty Set-Cookie returned. */
function cookieHeaderFrom(headers: Headers): Headers {
	const cookies = readSetCookies(headers).filter(
		(cookie) => cookie.value !== "",
	);
	return new Headers({
		cookie: cookies
			.map((cookie) => `${cookie.name}=${cookie.value}`)
			.join("; "),
	});
}

async function findSessionByToken(instance: Instance, token: string) {
	return instance.db.findOne({
		model: "session",
		where: [{ field: "token", value: token }],
	});
}

/**
 * Every verification row whose identifier belongs to a 2FA challenge —
 * `2fa-<random>` (value = userId) and its `2fa-attempts-…` budget companion.
 */
async function findChallengeRows(instance: Instance) {
	const rows = (await instance.db.findMany({
		model: "verification",
	})) as Array<{ identifier: string; value: string }>;
	return rows.filter((row) => row.identifier.startsWith("2fa-"));
}

/** Force the session's sliding-expiry refresh to come due on the next read. */
async function makeSessionRefreshDue(instance: Instance, token: string) {
	await instance.db.update({
		model: "session",
		where: [{ field: "token", value: token }],
		update: { expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) },
	});
}

/** Mint the JWT the second click of a change-email flow carries. */
function changeEmailVerificationToken(fromEmail: string, toEmail: string) {
	return createEmailVerificationToken(TEST_SECRET, fromEmail, toEmail, 3600, {
		requestType: "change-email-verification",
	});
}

function lastObservationFor(instance: Instance, path: string) {
	return [...instance.observed]
		.reverse()
		.find((entry) => entry.path === path);
}

describe("/verify-email 2FA enforcement — behavioral", () => {
	it("challenges a sessionless change-email verification for a 2FA user: no usable session survives, both challenge rows exist, and the response is the twoFactorRedirect payload", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		const token = await changeEmailVerificationToken(
			instance.testUser.email,
			NEW_EMAIL,
		);

		// No cookie header: this is the "clicked the link on a signed-out
		// device" case, the one that used to hand out a full session.
		const response: Response = await auth.api.verifyEmail({
			query: { token },
			headers: new Headers(),
			asResponse: true,
		});

		expect(await response.json()).toEqual({ twoFactorRedirect: true });

		const observation = lastObservationFor(instance, "/verify-email");
		expect(observation?.twoFactorEnabled).toBe(true);
		// The endpoint resolved no incoming session, so the token it minted
		// cannot match one — this is what makes it a fresh mint.
		expect(observation?.activeSessionToken).toBeNull();
		expect(observation?.newSessionToken).toBeTruthy();
		expect(observation?.gated).toBe(true);
		expect(observation?.challenged).toBe(true);

		// The minted session row is gone.
		const mintedToken = observation?.newSessionToken as string;
		expect(await findSessionByToken(instance, mintedToken)).toBeNull();

		// …and nothing replayable was written to the wire either. Better
		// Auth's `deleteSessionCookie` strips the earlier valid Set-Cookie
		// entries rather than appending an expiring one beside them, so a
		// raw-header consumer sees no live credential.
		const cookies = readSetCookies(response.headers);
		const credentialCookies = cookies.filter(
			(cookie) =>
				cookie.name.includes("session_token") ||
				cookie.name.includes("session_data"),
		);
		for (const cookie of credentialCookies) {
			expect(cookie.value).toBe("");
		}

		// The challenge row and its attempts companion (the pair
		// `verifyTwoFactor().beginAttempt()` requires) both exist.
		const challengeRows = await findChallengeRows(instance);
		const challenge = challengeRows.find(
			(row) => !row.identifier.startsWith("2fa-attempts-"),
		);
		expect(challenge).toBeTruthy();
		expect(challenge?.value).toBe(enrolled.userId);
		expect(
			challengeRows.find(
				(row) =>
					row.identifier === `2fa-attempts-${challenge?.identifier}`,
			)?.value,
		).toBe("0");

		// The signed two_factor cookie carrying that identifier is set.
		const twoFactorCookie = cookies.find((cookie) =>
			cookie.name.includes("two_factor"),
		);
		expect(twoFactorCookie?.value).toBeTruthy();

		// Containment must not roll the verification back: the email change
		// itself still committed.
		const updated = (await instance.db.findOne({
			model: "user",
			where: [{ field: "id", value: enrolled.userId }],
		})) as { email: string; emailVerified: boolean } | null;
		expect(updated?.email).toBe(NEW_EMAIL);
		expect(updated?.emailVerified).toBe(true);
	});

	it("redirects instead of answering JSON when the request carries a callbackURL, while containing the session exactly the same way", async () => {
		// The other half of the JSON-vs-redirect contract. Our own UI never
		// sends a callbackURL to this endpoint, but a plain browser
		// navigation can, and Better Auth answers those with a redirect —
		// so the gate mirrors that rather than replying JSON to a navigation.
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		const token = await changeEmailVerificationToken(
			instance.testUser.email,
			NEW_EMAIL,
		);

		const response: Response = await auth.api.verifyEmail({
			query: { token, callbackURL: "/after" },
			headers: new Headers(),
			asResponse: true,
		});

		// A redirect, not the twoFactorRedirect payload.
		expect(response.status).toBe(302);
		const location = response.headers.get("location");
		expect(location).toBeTruthy();
		const target = new URL(location as string);
		expect(target.pathname).toBe("/auth/verify");
		// The destination is carried forward under the param name OtpForm
		// reads, and survives as a decoded relative path.
		expect(target.searchParams.get("redirectTo")).toBe("/after");
		// Percent-encoded on the wire, so the nested path can't be read as
		// part of the /auth/verify URL itself.
		expect(location).toContain("redirectTo=%2Fafter");

		// Containment is identical to the JSON case: the challenge was raised
		// and the minted session is gone from both the store and the wire.
		const observation = lastObservationFor(instance, "/verify-email");
		expect(observation?.gated).toBe(true);
		expect(observation?.challenged).toBe(true);

		const mintedToken = observation?.newSessionToken as string;
		expect(mintedToken).toBeTruthy();
		expect(await findSessionByToken(instance, mintedToken)).toBeNull();

		const cookies = readSetCookies(response.headers);
		for (const cookie of cookies.filter(
			(entry) =>
				entry.name.includes("session_token") ||
				entry.name.includes("session_data"),
		)) {
			expect(cookie.value).toBe("");
		}
		expect(
			cookies.find((cookie) => cookie.name.includes("two_factor"))?.value,
		).toBeTruthy();

		const challengeRows = await findChallengeRows(instance);
		expect(
			challengeRows.find(
				(row) => !row.identifier.startsWith("2fa-attempts-"),
			)?.value,
		).toBe(enrolled.userId);
	});

	it("leaves an already-signed-in 2FA user alone: the same request with a valid session refreshes it instead of minting, so no challenge is raised", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		const token = await changeEmailVerificationToken(
			instance.testUser.email,
			NEW_EMAIL,
		);

		const response: Response = await auth.api.verifyEmail({
			query: { token },
			headers: enrolled.headers,
			asResponse: true,
		});

		const body = (await response.json()) as Record<string, unknown>;
		expect(body.twoFactorRedirect).toBeUndefined();
		expect(body.status).toBe(true);

		const observation = lastObservationFor(instance, "/verify-email");
		expect(observation?.twoFactorEnabled).toBe(true);
		// This is the whole discriminator: Better Auth called
		// `setSessionCookie` (and therefore `setNewSession`) for the cookie
		// refresh, so `newSession` is populated — but with the SAME token it
		// resolved from the request.
		expect(observation?.newSessionToken).toBe(enrolled.sessionToken);
		expect(observation?.activeSessionToken).toBe(enrolled.sessionToken);
		expect(observation?.gated).toBe(false);
		expect(observation?.challenged).toBe(false);

		// The user stays signed in and no challenge was created.
		expect(
			await findSessionByToken(instance, enrolled.sessionToken),
		).not.toBeNull();
		expect(await findChallengeRows(instance)).toHaveLength(0);
	});

	it("does not over-fire: a user without 2FA keeps the session the sessionless change-email verification mints", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;

		const token = await changeEmailVerificationToken(
			instance.testUser.email,
			NEW_EMAIL,
		);

		const response: Response = await auth.api.verifyEmail({
			query: { token },
			headers: new Headers(),
			asResponse: true,
		});

		const body = (await response.json()) as Record<string, unknown>;
		expect(body.twoFactorRedirect).toBeUndefined();
		expect(body.status).toBe(true);

		const observation = lastObservationFor(instance, "/verify-email");
		expect(observation?.twoFactorEnabled).toBe(false);
		expect(observation?.challenged).toBe(false);

		const mintedToken = observation?.newSessionToken as string;
		expect(mintedToken).toBeTruthy();
		expect(await findSessionByToken(instance, mintedToken)).not.toBeNull();
		expect(await findChallengeRows(instance)).toHaveLength(0);
	});

	it("covers the autoSignInAfterVerification branch too: a 2FA user verifying a still-unverified address sessionless is challenged", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		// The default test user signs up unverified, which is what makes the
		// plain path reach its `autoSignInAfterVerification` mint rather than
		// short-circuiting on `user.emailVerified`.
		const before = (await instance.db.findOne({
			model: "user",
			where: [{ field: "id", value: enrolled.userId }],
		})) as { emailVerified: boolean } | null;
		expect(before?.emailVerified).toBe(false);

		// No `updateTo`: the plain verification token.
		const token = await createEmailVerificationToken(
			TEST_SECRET,
			instance.testUser.email,
		);

		const response: Response = await auth.api.verifyEmail({
			query: { token },
			headers: new Headers(),
			asResponse: true,
		});

		expect(await response.json()).toEqual({ twoFactorRedirect: true });

		const observation = lastObservationFor(instance, "/verify-email");
		expect(observation?.gated).toBe(true);
		expect(observation?.challenged).toBe(true);

		const mintedToken = observation?.newSessionToken as string;
		expect(await findSessionByToken(instance, mintedToken)).toBeNull();
		expect((await findChallengeRows(instance)).length).toBeGreaterThan(0);

		// The verification itself still committed.
		const after = (await instance.db.findOne({
			model: "user",
			where: [{ field: "id", value: enrolled.userId }],
		})) as { emailVerified: boolean } | null;
		expect(after?.emailVerified).toBe(true);
	});
});

describe("deny-by-default gate — refresh-shaped requests are untouched", () => {
	it("lets a due sliding-expiry refresh through on /get-session", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);
		await makeSessionRefreshDue(instance, enrolled.sessionToken);

		// `disableCookieCache` forces the DB path, which is the one that
		// refreshes the row and calls `setSessionCookie`.
		const session = await auth.api.getSession({
			headers: enrolled.headers,
			query: { disableCookieCache: true },
		});
		expect(session?.session?.token).toBe(enrolled.sessionToken);

		const observation = lastObservationFor(instance, "/get-session");
		expect(observation?.twoFactorEnabled).toBe(true);
		expect(observation?.newSessionToken).toBe(enrolled.sessionToken);
		expect(observation?.activeSessionToken).toBe(enrolled.sessionToken);
		expect(observation?.gated).toBe(false);
		expect(
			await findSessionByToken(instance, enrolled.sessionToken),
		).not.toBeNull();
		expect(await findChallengeRows(instance)).toHaveLength(0);
	});

	it("lets a sessionMiddleware-driven refresh through on /list-sessions", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);
		await makeSessionRefreshDue(instance, enrolled.sessionToken);

		const sessions = await auth.api.listSessions({
			headers: enrolled.headers,
		});
		expect(Array.isArray(sessions)).toBe(true);

		const observation = lastObservationFor(instance, "/list-sessions");
		expect(observation?.gated).toBe(false);
		expect(
			await findSessionByToken(instance, enrolled.sessionToken),
		).not.toBeNull();
		expect(await findChallengeRows(instance)).toHaveLength(0);
	});

	it("lets /update-user and /organization/set-active rewrite the cookie", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		await auth.api.updateUser({
			body: { name: "Renamed" },
			headers: enrolled.headers,
		});
		const afterUpdateUser = lastObservationFor(instance, "/update-user");
		expect(afterUpdateUser?.twoFactorEnabled).toBe(true);
		expect(afterUpdateUser?.newSessionToken).toBe(enrolled.sessionToken);
		expect(afterUpdateUser?.gated).toBe(false);

		const org = await auth.api.createOrganization({
			body: { name: "Example Org", slug: "example-org" },
			headers: enrolled.headers,
		});
		const activated = await auth.api.setActiveOrganization({
			body: { organizationId: org.id },
			headers: enrolled.headers,
		});
		expect(activated?.id).toBe(org.id);
		// The organization plugin composes its own session middleware, and the
		// cookie rewrite it performs is not surfaced on the context
		// `hooks.after` receives — `newSession` reads null here even though the
		// endpoint called `setSessionCookie`. So the gate cannot fire on this
		// path at all; what matters is the outcome, asserted below. (No
		// organization endpoint mints a session for a different token, so the
		// invisibility costs no enforcement.)
		const afterSetActive = lastObservationFor(
			instance,
			"/organization/set-active",
		);
		expect(afterSetActive?.gated).toBe(false);

		// Read the row rather than /get-session: the caller's cookie cache
		// still holds the pre-switch snapshot.
		const sessionRow = (await findSessionByToken(
			instance,
			enrolled.sessionToken,
		)) as { activeOrganizationId?: string } | null;
		expect(sessionRow).not.toBeNull();
		expect(sessionRow?.activeOrganizationId).toBe(org.id);
		expect(await findChallengeRows(instance)).toHaveLength(0);
	});

	it("sweeps every session-touching endpoint a 2FA user can drive without a challenge", async () => {
		// The negative half of deny-by-default, driven in one pass: if any of
		// these starts minting a distinct token, the gate would sign the user
		// out mid-session and this fails.
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		await auth.api.getSession({ headers: enrolled.headers });
		await auth.api.listSessions({ headers: enrolled.headers });
		await auth.api.updateUser({
			body: { name: "Swept" },
			headers: enrolled.headers,
		});
		await auth.api.listOrganizations({ headers: enrolled.headers });
		await auth.api.getSession({
			headers: enrolled.headers,
			query: { disableCookieCache: true },
		});
		await auth.api.testRefreshSession({
			query: {},
			headers: enrolled.headers,
		});
		await auth.api.generateBackupCodes({
			body: { password: instance.testUser.password },
			headers: enrolled.headers,
		});

		const challenged = instance.observed.filter((entry) => entry.gated);
		expect(challenged).toEqual([]);
		expect(await findChallengeRows(instance)).toHaveLength(0);
		expect(
			await findSessionByToken(instance, enrolled.sessionToken),
		).not.toBeNull();
	});
});

describe("deny-by-default gate — the 2FA management endpoints", () => {
	/**
	 * These four are behind their own step-up grant (issue #2827), which makes
	 * "a call that got here is already factor-proven" true — and therefore
	 * makes exempting them here look harmless. None of them needs an
	 * exemption, and these tests are what keeps that claim honest against a
	 * better-auth bump rather than against a reading of the dist. The harness
	 * deliberately does NOT install the step-up before-hook, so each endpoint
	 * is driven with the password alone and what is observed is purely this
	 * gate's behaviour.
	 */

	it("does not challenge /two-factor/disable, which rekeys the session for a now-flagless user", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		const disabled = await auth.api.disableTwoFactor({
			body: { password: instance.testUser.password },
			headers: enrolled.headers,
			returnHeaders: true,
		});

		const observation = lastObservationFor(instance, "/two-factor/disable");
		// It genuinely rekeys — a different token from the one it resolved off
		// the request — so the discriminator calls this a fresh mint…
		expect(observation?.activeSessionToken).toBe(enrolled.sessionToken);
		expect(observation?.newSessionToken).not.toBe(enrolled.sessionToken);
		// …and the ONLY reason it survives is that the user it minted for no
		// longer has a second factor. No exemption is involved.
		expect(observation?.twoFactorEnabled).toBe(false);
		expect(observation?.gated).toBe(false);
		expect(TWO_FACTOR_GATE_EXEMPT_PATHS.has("/two-factor/disable")).toBe(
			false,
		);

		const survivor = await auth.api.getSession({
			headers: cookieHeaderFrom(disabled.headers),
		});
		expect(survivor?.user?.twoFactorEnabled).toBe(false);
		expect(await findChallengeRows(instance)).toHaveLength(0);
	});

	it("does not challenge /two-factor/enable, which mints nothing in this configuration", async () => {
		// Re-enrolling an ALREADY-enrolled user is the case that would bite:
		// if enable ever started rotating the session for someone whose flag is
		// already set, this gate would challenge it and strand them. It does
		// not — the mint is behind `skipVerificationOnEnable`, which production
		// does not set, so enrolment completes at /two-factor/verify-totp.
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		const reEnabled = await auth.api.enableTwoFactor({
			body: { password: instance.testUser.password },
			headers: enrolled.headers,
		});
		expect(reEnabled.totpURI).toBeTruthy();

		const observation = lastObservationFor(instance, "/two-factor/enable");
		expect(observation).toBeTruthy();
		// Nothing was minted, so there is nothing for the gate to classify.
		expect(observation?.newSessionToken).toBeNull();
		expect(observation?.gated).toBe(false);
		expect(TWO_FACTOR_GATE_EXEMPT_PATHS.has("/two-factor/enable")).toBe(
			false,
		);

		// The caller keeps the session they arrived with.
		expect(
			await findSessionByToken(instance, enrolled.sessionToken),
		).not.toBeNull();
		expect(await findChallengeRows(instance)).toHaveLength(0);
	});

	it("does not challenge /two-factor/get-totp-uri or /two-factor/generate-backup-codes", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		await auth.api.getTOTPURI({
			body: { password: instance.testUser.password },
			headers: enrolled.headers,
		});
		await auth.api.generateBackupCodes({
			body: { password: instance.testUser.password },
			headers: enrolled.headers,
		});

		for (const path of [
			"/two-factor/get-totp-uri",
			"/two-factor/generate-backup-codes",
		]) {
			const observation = lastObservationFor(instance, path);
			expect(observation, path).toBeTruthy();
			expect(observation?.newSessionToken, path).toBeNull();
			expect(observation?.gated, path).toBe(false);
		}

		expect(
			await findSessionByToken(instance, enrolled.sessionToken),
		).not.toBeNull();
		expect(await findChallengeRows(instance)).toHaveLength(0);
	});
});

describe("deny-by-default gate — exempt rekeys survive", () => {
	it("lets /change-password with revokeOtherSessions rekey the session", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		// A second live session for the same user, so "other sessions gone" is
		// a real assertion. Created straight through the adapter: routing it
		// through an endpoint would trip the gate and leave challenge rows
		// behind, which is what the last assertion in this test is about.
		const authCtx = await (instance.auth as TestAuth).$context;
		const otherToken = (
			await authCtx.internalAdapter.createSession(enrolled.userId, false)
		).token as string;
		expect(await findSessionByToken(instance, otherToken)).not.toBeNull();

		const response: Response = await auth.api.changePassword({
			body: {
				currentPassword: instance.testUser.password,
				newPassword: "new-password-strong-enough",
				revokeOtherSessions: true,
			},
			headers: enrolled.headers,
			asResponse: true,
		});

		// A JSON answer, not a challenge: the caller proved the current
		// password and `sensitiveSessionMiddleware` re-read their session.
		const body = (await response.json()) as { token?: string };
		expect(body.token).toBeTruthy();

		const observation = lastObservationFor(instance, "/change-password");
		expect(observation?.twoFactorEnabled).toBe(true);
		// It IS a fresh mint — a different token from the one resolved off the
		// request — and survives only because the path is exempt.
		expect(observation?.newSessionToken).not.toBe(enrolled.sessionToken);
		expect(observation?.activeSessionToken).toBe(enrolled.sessionToken);
		expect(observation?.gated).toBe(false);

		expect(
			await findSessionByToken(instance, body.token as string),
		).not.toBeNull();
		expect(await findSessionByToken(instance, otherToken)).toBeNull();
		expect(await findChallengeRows(instance)).toHaveLength(0);
	});

	it("lets an admin impersonate a 2FA user and then restore their own session", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;

		// The target: the default test user, enrolled in 2FA.
		const target = await enrollTwoFactor(instance);

		// The admin: a second account, also enrolled, promoted via the role
		// field the admin plugin reads.
		const adminEmail = "admin@example.com";
		const adminPassword = "admin-password-strong-enough";
		await auth.api.signUpEmail({
			body: {
				email: adminEmail,
				password: adminPassword,
				name: "Example Admin",
			},
		});
		await instance.db.update({
			model: "user",
			where: [{ field: "email", value: adminEmail }],
			update: { role: "admin" },
		});
		const adminUser = await enrollTwoFactor(instance, {
			email: adminEmail,
			password: adminPassword,
		});

		const impersonation = await auth.api.impersonateUser({
			body: { userId: target.userId },
			headers: adminUser.headers,
			returnHeaders: true,
		});
		const impersonationObservation = lastObservationFor(
			instance,
			"/admin/impersonate-user",
		);
		// The minted session belongs to a user WITH 2FA and is a fresh mint;
		// the exemption is a deliberate, audited bypass of the target's factor.
		expect(impersonationObservation?.twoFactorEnabled).toBe(true);
		expect(impersonationObservation?.gated).toBe(false);
		const impersonatedToken =
			impersonationObservation?.newSessionToken as string;
		expect(
			await findSessionByToken(instance, impersonatedToken),
		).not.toBeNull();

		const impersonatedHeaders = cookieHeaderFrom(impersonation.headers);
		await auth.api.stopImpersonating({
			headers: impersonatedHeaders,
			returnHeaders: true,
		});
		const stopObservation = lastObservationFor(
			instance,
			"/admin/stop-impersonating",
		);
		// `ctx.context.session` still holds the IMPERSONATED session here, so
		// the restored admin token necessarily looks like a fresh mint.
		expect(stopObservation?.twoFactorEnabled).toBe(true);
		expect(stopObservation?.newSessionToken).toBe(adminUser.sessionToken);
		expect(stopObservation?.newSessionToken).not.toBe(
			stopObservation?.activeSessionToken,
		);
		expect(stopObservation?.gated).toBe(false);
		expect(
			await findSessionByToken(instance, adminUser.sessionToken),
		).not.toBeNull();
		expect(await findChallengeRows(instance)).toHaveLength(0);
	});
});

describe("deny-by-default gate — fresh mints are challenged", () => {
	it("challenges a magic-link sign-in and carries its callbackURL through as a relative path", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);
		// The default test user signs up unverified, and magic-link verify
		// revokes every session of an unverified account before it mints
		// (`revokeUnprovenAccountAccess`). Verifying first keeps the
		// "containment is scoped to the new credential" assertion below about
		// this gate rather than about that revoke.
		await instance.db.update({
			model: "user",
			where: [{ field: "id", value: enrolled.userId }],
			update: { emailVerified: true },
		});

		await auth.api.signInMagicLink({
			body: { email: instance.testUser.email, callbackURL: "/app/inbox" },
			headers: new Headers(),
		});
		expect(capturedMagicLink).toBeTruthy();
		const token = new URL(capturedMagicLink as string).searchParams.get(
			"token",
		);

		const response: Response = await auth.api.magicLinkVerify({
			query: { token, callbackURL: "/app/inbox" },
			headers: new Headers(),
			asResponse: true,
		});

		expect(response.status).toBe(302);
		const target = new URL(response.headers.get("location") as string);
		expect(target.pathname).toBe("/auth/verify");
		expect(target.searchParams.get("redirectTo")).toBe("/app/inbox");

		const observation = lastObservationFor(instance, "/magic-link/verify");
		expect(observation?.gated).toBe(true);
		expect(observation?.challenged).toBe(true);
		expect(
			await findSessionByToken(
				instance,
				observation?.newSessionToken as string,
			),
		).toBeNull();
		// The pre-existing session is untouched — containment is scoped to the
		// credential this request tried to mint.
		expect(
			await findSessionByToken(instance, enrolled.sessionToken),
		).not.toBeNull();
		expect((await findChallengeRows(instance)).length).toBe(2);
	});

	it("answers a JSON-shaped mint with JSON and a navigation-shaped mint with a 302", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		// No callbackURL anywhere and no Location header: an XHR.
		const jsonResponse: Response = await auth.api.testMintSession({
			query: { userId: enrolled.userId },
			headers: new Headers(),
			asResponse: true,
		});
		expect(await jsonResponse.json()).toEqual({ twoFactorRedirect: true });
		expect(lastObservationFor(instance, "/test/mint-session")?.gated).toBe(
			true,
		);

		const navigationResponse: Response = await auth.api.testMintSession({
			query: { userId: enrolled.userId, callbackURL: "/app/reports" },
			headers: new Headers(),
			asResponse: true,
		});
		expect(navigationResponse.status).toBe(302);
		const target = new URL(
			navigationResponse.headers.get("location") as string,
		);
		expect(target.pathname).toBe("/auth/verify");
		expect(target.searchParams.get("redirectTo")).toBe("/app/reports");
	});

	it("challenges a rekey on a non-exempt path even though the caller held a valid session", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		const response: Response = await auth.api.testRekeySession({
			query: {},
			headers: enrolled.headers,
			asResponse: true,
		});
		expect(await response.json()).toEqual({ twoFactorRedirect: true });

		const observation = lastObservationFor(instance, "/test/rekey-session");
		// Both tokens are readable and they differ — the discriminator's
		// positive case, distinct from the "no active session" fallback.
		expect(observation?.activeSessionToken).toBe(enrolled.sessionToken);
		expect(observation?.newSessionToken).not.toBe(enrolled.sessionToken);
		expect(observation?.gated).toBe(true);
		expect(observation?.challenged).toBe(true);
		expect(
			await findSessionByToken(
				instance,
				observation?.newSessionToken as string,
			),
		).toBeNull();
	});
});

describe("deny-by-default gate — challenge completion", () => {
	it("does not re-challenge a TOTP challenge completion, and the minted session survives", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		// Raise a challenge the normal way, then complete it.
		const challengeResponse: Response = await auth.api.testMintSession({
			query: { userId: enrolled.userId },
			headers: new Headers(),
			asResponse: true,
		});
		const challengeHeaders = cookieHeaderFrom(challengeResponse.headers);

		const completion = await auth.api.verifyTOTP({
			body: { code: await totpCode(instance, enrolled.secret) },
			headers: challengeHeaders,
			returnHeaders: true,
		});

		const observation = lastObservationFor(
			instance,
			"/two-factor/verify-totp",
		);
		expect(observation?.twoFactorEnabled).toBe(true);
		expect(observation?.gated).toBe(false);
		const finalToken = observation?.newSessionToken as string;
		expect(finalToken).toBeTruthy();
		expect(await findSessionByToken(instance, finalToken)).not.toBeNull();

		// The completed session is usable.
		const session = await auth.api.getSession({
			headers: cookieHeaderFrom(completion.headers),
		});
		expect(session?.user?.id).toBe(enrolled.userId);
		// The challenge rows were consumed.
		expect(await findChallengeRows(instance)).toHaveLength(0);
	});

	it("does not re-challenge a backup-code challenge completion", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		const challengeResponse: Response = await auth.api.testMintSession({
			query: { userId: enrolled.userId },
			headers: new Headers(),
			asResponse: true,
		});
		const challengeHeaders = cookieHeaderFrom(challengeResponse.headers);

		await auth.api.verifyBackupCode({
			body: { code: enrolled.backupCodes[0] },
			headers: challengeHeaders,
			returnHeaders: true,
		});

		const observation = lastObservationFor(
			instance,
			"/two-factor/verify-backup-code",
		);
		expect(observation?.twoFactorEnabled).toBe(true);
		expect(observation?.gated).toBe(false);
		expect(
			await findSessionByToken(
				instance,
				observation?.newSessionToken as string,
			),
		).not.toBeNull();
	});

	it("keeps /two-factor/verify-otp exempt even though no sendOTP is configured", () => {
		// Unreachable end-to-end here (and in production) — `/two-factor/
		// send-otp` rejects without a `sendOTP` implementation — but the
		// endpoint mints on both challenge completion and enrollment, so
		// omitting it would create an unbreakable loop the day one is wired.
		expect(TWO_FACTOR_GATE_EXEMPT_PATHS.has("/two-factor/verify-otp")).toBe(
			true,
		);
	});

	it("leaves better-auth's own /sign-in/email challenge — and its trust-device exception — intact", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		// First sign-in: the built-in plugin's own hook answers with its
		// twoFactorRedirect payload. Ours must not have pre-empted it by
		// deleting the session before that hook ran.
		const firstResponse: Response = await auth.api.signInEmail({
			body: {
				email: instance.testUser.email,
				password: instance.testUser.password,
			},
			asResponse: true,
		});
		const firstBody = (await firstResponse.json()) as {
			twoFactorRedirect?: boolean;
		};
		expect(firstBody.twoFactorRedirect).toBe(true);

		// Complete it with trustDevice, which the plugin only honours because
		// `newSession` was still intact when its hook ran.
		const trusted = await auth.api.verifyTOTP({
			body: {
				code: await totpCode(instance, enrolled.secret),
				trustDevice: true,
			},
			headers: cookieHeaderFrom(firstResponse.headers),
			returnHeaders: true,
		});
		const trustedHeaders = cookieHeaderFrom(trusted.headers);
		expect(trustedHeaders.get("cookie")).toContain("trust_device");

		// Second sign-in from the trusted device: a full session, no challenge.
		const secondResponse: Response = await auth.api.signInEmail({
			body: {
				email: instance.testUser.email,
				password: instance.testUser.password,
			},
			headers: trustedHeaders,
			asResponse: true,
		});
		const secondBody = (await secondResponse.json()) as {
			twoFactorRedirect?: boolean;
			token?: string;
		};
		expect(secondBody.twoFactorRedirect).toBeUndefined();
		expect(secondBody.token).toBeTruthy();

		const observation = lastObservationFor(instance, "/sign-in/email");
		expect(observation?.twoFactorEnabled).toBe(true);
		expect(observation?.gated).toBe(false);
		expect(
			await findSessionByToken(instance, secondBody.token as string),
		).not.toBeNull();
	});
});

describe("deny-by-default gate — redirect sanitization", () => {
	it("drops a hostile navigation target while still answering a navigation with a redirect", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		for (const hostile of [
			"https://evil.example/steal",
			"//evil.example",
			"/\\evil.example",
		]) {
			const response: Response = await auth.api.testMintSession({
				query: { userId: enrolled.userId, callbackURL: hostile },
				headers: new Headers(),
				asResponse: true,
			});
			// Still a navigation — the caller asked for one — but with no
			// destination the challenge page could be talked into following.
			expect(response.status).toBe(302);
			const target = new URL(response.headers.get("location") as string);
			expect(target.pathname).toBe("/auth/verify");
			expect(
				target.searchParams.get("redirectTo"),
				`${hostile} must not survive`,
			).toBeNull();
		}
	});

	it("normalizes a same-origin absolute target to a relative path", async () => {
		// magic-link and OAuth hand the hook fully qualified same-origin URLs;
		// the param the challenge page receives must still be relative, so the
		// client-side `safeRelativePath` check accepts it.
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		const response: Response = await auth.api.testMintSession({
			query: {
				userId: enrolled.userId,
				callbackURL: `${APP_URL}/app/projects?tab=open`,
			},
			headers: new Headers(),
			asResponse: true,
		});

		const target = new URL(response.headers.get("location") as string);
		expect(target.searchParams.get("redirectTo")).toBe(
			"/app/projects?tab=open",
		);
	});

	it("drops a target smuggled past the prefix checks with control characters", async () => {
		// `"/\t/evil.example"` starts with a single slash followed by a
		// character that is neither "/" nor "\", so it satisfies every
		// prefix-shaped rule — and then the URL parser strips the tab and
		// resolves it to https://evil.example/. Resolving against appUrl is
		// what catches it.
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		for (const hostile of [
			"/\t/evil.example",
			"/\n/evil.example",
			"/\r/evil.example",
			"/\t\\evil.example",
		]) {
			const response: Response = await auth.api.testMintSession({
				query: { userId: enrolled.userId, callbackURL: hostile },
				headers: new Headers(),
				asResponse: true,
			});
			expect(response.status).toBe(302);
			const target = new URL(response.headers.get("location") as string);
			expect(target.pathname).toBe("/auth/verify");
			expect(
				target.searchParams.get("redirectTo"),
				`${JSON.stringify(hostile)} must not survive`,
			).toBeNull();
		}
	});

	it("contains the mint when the navigation target is not a string at all", async () => {
		// `callbackURL` is unvalidated JSON on an endpoint that declares no
		// schema. Read without narrowing, an object here reaches
		// `.startsWith()` and throws — and it would throw BEFORE the cookie
		// scrub, the `newSession` null and the session delete, so the caller
		// would keep the very credential the gate was taking away. Exactly the
		// untyped-future-plugin case deny-by-default exists to survive.
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const enrolled = await enrollTwoFactor(instance);

		for (const shape of [{}, [], 42, true]) {
			const response: Response = await auth.api.testMintSession({
				query: {
					userId: enrolled.userId,
					callbackURL: shape as unknown as string,
				},
				headers: new Headers(),
				asResponse: true,
			});

			// A non-string reads as "no navigation target", so the caller is
			// treated as an XHR — and, crucially, is answered at all rather
			// than blowing up mid-hook.
			expect(await response.json(), JSON.stringify(shape)).toEqual({
				twoFactorRedirect: true,
			});

			const observation = lastObservationFor(
				instance,
				"/test/mint-session",
			);
			expect(observation?.gated, JSON.stringify(shape)).toBe(true);
			expect(observation?.challenged, JSON.stringify(shape)).toBe(true);
			expect(
				await findSessionByToken(
					instance,
					observation?.newSessionToken as string,
				),
				JSON.stringify(shape),
			).toBeNull();
			for (const cookie of readSetCookies(response.headers)) {
				if (
					cookie.name.includes("session_token") ||
					cookie.name.includes("session_data")
				) {
					expect(cookie.value, JSON.stringify(shape)).toBe("");
				}
			}
		}
	});
});

describe("deny-by-default gate — fail-closed containment", () => {
	/**
	 * Break one step of the challenge, drive a gated mint, and assert that the
	 * credential still does not escape. `auth.$context` hands back the very
	 * `internalAdapter` object each request context shallow-copies, so a patch
	 * here is seen by the pipeline.
	 */
	async function withBrokenStep(
		instance: Instance,
		patch: (ctx: any) => () => void,
		drive: () => Promise<Response>,
	) {
		const authCtx = await (instance.auth as TestAuth).$context;
		const restore = patch(authCtx);
		try {
			return await drive();
		} finally {
			restore();
		}
	}

	function assertNoLiveCredential(response: Response) {
		for (const cookie of readSetCookies(response.headers)) {
			if (
				cookie.name.includes("session_token") ||
				cookie.name.includes("session_data")
			) {
				expect(cookie.value).toBe("");
			}
		}
	}

	it("contains the session when the session delete, a challenge-row write, or the cookie config fails", async () => {
		const breakages: Array<{
			name: string;
			/**
			 * Whether the minted session ROW is expected to survive. It does
			 * only when the delete itself is the step that failed — and even
			 * then it is an orphan: the browser never receives the cookie, and
			 * `newSession` is nulled before any later hook could read it.
			 */
			rowSurvives?: boolean;
			patch: (ctx: any) => () => void;
		}> = [
			{
				name: "deleteSession",
				rowSurvives: true,
				patch: (ctx) => {
					const original = ctx.internalAdapter.deleteSession;
					ctx.internalAdapter.deleteSession = async () => {
						throw new Error("deleteSession failed");
					};
					return () => {
						ctx.internalAdapter.deleteSession = original;
					};
				},
			},
			{
				name: "challenge row write",
				patch: (ctx) => {
					const original =
						ctx.internalAdapter.createVerificationValue;
					ctx.internalAdapter.createVerificationValue = async () => {
						throw new Error("challenge row write failed");
					};
					return () => {
						ctx.internalAdapter.createVerificationValue = original;
					};
				},
			},
			{
				name: "attempts row write",
				patch: (ctx) => {
					const original =
						ctx.internalAdapter.createVerificationValue;
					let calls = 0;
					ctx.internalAdapter.createVerificationValue = async (
						...args: unknown[]
					) => {
						calls += 1;
						if (calls > 1) {
							throw new Error("attempts row write failed");
						}
						return (original as any).apply(
							ctx.internalAdapter,
							args,
						);
					};
					return () => {
						ctx.internalAdapter.createVerificationValue = original;
					};
				},
			},
			{
				name: "signed cookie write",
				patch: (ctx) => {
					const original = ctx.createAuthCookie;
					ctx.createAuthCookie = (
						name: string,
						...rest: unknown[]
					) => {
						if (name === "two_factor") {
							throw new Error("cookie config failed");
						}
						return (original as any).call(ctx, name, ...rest);
					};
					return () => {
						ctx.createAuthCookie = original;
					};
				},
			},
		];

		for (const breakage of breakages) {
			const instance = await setup();
			const auth = instance.auth as TestAuth;
			const enrolled = await enrollTwoFactor(instance);

			// XHR-shaped: the caller must see a failed call, not a login page
			// behind a transparently-followed 302.
			const jsonResponse = await withBrokenStep(
				instance,
				breakage.patch,
				() =>
					auth.api.testMintSession({
						query: { userId: enrolled.userId },
						headers: new Headers(),
						asResponse: true,
					}) as Promise<Response>,
			);
			expect(jsonResponse.status, breakage.name).toBeGreaterThanOrEqual(
				400,
			);
			assertNoLiveCredential(jsonResponse);

			const jsonObservation = lastObservationFor(
				instance,
				"/test/mint-session",
			);
			expect(jsonObservation?.gated, breakage.name).toBe(true);
			expect(jsonObservation?.challenged, breakage.name).toBe(false);
			const mintedRow = await findSessionByToken(
				instance,
				jsonObservation?.newSessionToken as string,
			);
			if (breakage.rowSurvives) {
				expect(mintedRow, breakage.name).not.toBeNull();
			} else {
				expect(mintedRow, breakage.name).toBeNull();
			}

			// Navigation-shaped: the browser is sent to the login page.
			const navigationResponse = await withBrokenStep(
				instance,
				breakage.patch,
				() =>
					auth.api.testMintSession({
						query: {
							userId: enrolled.userId,
							callbackURL: "/app/reports",
						},
						headers: new Headers(),
						asResponse: true,
					}) as Promise<Response>,
			);
			expect(navigationResponse.status, breakage.name).toBe(302);
			expect(
				new URL(navigationResponse.headers.get("location") as string)
					.pathname,
				breakage.name,
			).toBe("/auth/login");
			assertNoLiveCredential(navigationResponse);
		}
	});
});
