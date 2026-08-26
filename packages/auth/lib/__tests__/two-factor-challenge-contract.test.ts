/**
 * DRIFT GUARD for `../two-factor-challenge.ts`.
 *
 * `packages/auth/auth.ts` hand-rolls a replica of Better Auth's 2FA challenge
 * flow, because the `twoFactor()` plugin's own `hooks.after` matcher covers
 * only `/sign-in/{email,username,phone-number}` — leaving magic-link and OAuth
 * sign-ins ungated. That replica has to stay bit-compatible with a private,
 * undocumented contract of the upstream library: the exact set of verification
 * rows a challenge consists of.
 *
 * Nothing else detects when that contract moves. It has already broken once in
 * production: Better Auth 1.6.22 added the companion `2fa-attempts-<id>` row
 * that `verifyTwoFactor().beginAttempt()` consumes, the replica did not write
 * it, and every TOTP and backup-code submission that followed a magic-link or
 * OAuth sign-in returned 401 with no self-service recovery. The failure class
 * is "upstream changes the row set; our replica keeps writing the old one" —
 * so what this file pins is the row set itself, derived at run time from the
 * INSTALLED library rather than from anything we wrote down.
 *
 * How it works: drive a native credential sign-in for a 2FA-enabled user (the
 * plugin's own hook creates the challenge), diff the verification table to see
 * exactly what it wrote, then do the same for a challenge created through
 * `createTwoFactorChallenge`, and compare the two normalized row sets. Because
 * the expected side is captured from the library at run time, adding a third
 * required row upstream, renaming an identifier prefix, or changing a seeded
 * value fails this test on the next dependency bump — no test edit needed to
 * "teach" it the new contract.
 *
 * Everything here goes through the public surface: `better-auth/test`'s
 * `getTestInstance` (in-memory `node:sqlite`, real request/response cycle in
 * process), `better-auth/api`'s `createAuthEndpoint`, and `auth.api.*`. It
 * deliberately does NOT import or parse `better-auth/dist/**`, which would
 * pin packaging text rather than behavior, and it asserts no version string.
 *
 * Companion tests, both of which stay:
 *   - two-factor-challenge.test.ts — unit tests for the replica in isolation
 *     (write order, sequential-not-concurrent). Not a drift guard: its
 *     expectations are hard-coded, so it cannot notice upstream moving.
 *   - two-factor-lockout-behavior.test.ts — the account-level lockout, whose
 *     harness conventions this file follows.
 *
 * Run with: pnpm --filter @repo/auth test lib/__tests__/two-factor-challenge-contract.test.ts
 */

import { symmetricDecrypt } from "better-auth/crypto";
import { twoFactor } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { describe, expect, it } from "vitest";
import {
	createReplicaChallengePlugin,
	expectAPIErrorCode,
	extractCookie,
	startReplicaChallenge,
	WRONG_TOTP_CODE,
} from "./two-factor-test-helpers";

/**
 * The challenge lifetime `auth.ts` passes to `createTwoFactorChallenge`
 * (auth.ts's `const maxAgeSeconds = 3 * 60`). The test instance's
 * `twoFactorCookieMaxAge` is set to the same value so the native hook and the
 * replica are compared at an identical lifetime — otherwise the expiry
 * assertions would be comparing two different configurations rather than two
 * implementations.
 */
const CHALLENGE_MAX_AGE_SECONDS = 3 * 60;

/**
 * Slack for the wall-clock gap between "test recorded the time" and "the row
 * was written". Generous because CI is slow, and because this assertion is
 * about the challenge lasting roughly its configured lifetime, not about
 * millisecond precision.
 */
const EXPIRY_TOLERANCE_MS = 10_000;

/**
 * Both implementations must key the challenge row with this shape. Pinned on
 * BOTH the native and the replica identifier, so an upstream rename of the
 * `2fa-` prefix fails here rather than silently redefining what the replica
 * is supposed to match. Length is deliberately not pinned: upstream widening
 * its random suffix is not a compatibility break.
 */
const CHALLENGE_IDENTIFIER_PATTERN = /^2fa-[A-Za-z0-9_-]+$/;

/**
 * The instance type varies with the plugin list passed to getTestInstance;
 * narrowing it fully isn't worth it here, so the handful of `auth.api.*`
 * calls this file makes are typed loosely via this alias.
 */
type TestAuth = any;

interface VerificationRow {
	id: string;
	identifier: string;
	value: string;
	expiresAt: Date;
}

/**
 * Build a fresh in-memory instance carrying the real `twoFactor()` plugin
 * alongside the replica endpoint (`createReplicaChallengePlugin`, shared via
 * ./two-factor-test-helpers — it performs exactly the two production
 * statements `auth.ts` runs when it gates a magic-link or OAuth sign-in:
 * `createTwoFactorChallenge(...)` against the live
 * `ctx.context.internalAdapter`, then the signed `two_factor` cookie via
 * `createAuthCookie` + `setSignedCookie`), so one adapter and one context
 * serve both sides of the comparison below. Running the replica through a
 * real endpoint (rather than calling it with a synthetic adapter) is what
 * makes that comparison meaningful: both sides' rows are written by the same
 * `internalAdapter` on the same instance, so any normalization the adapter
 * applies to identifiers or timestamps applies equally to both. It also
 * gives the completion tests a genuinely signed cookie without this file
 * re-implementing Better Auth's cookie signing.
 *
 * `skipVerificationOnEnable` is a test-only setup convenience (it lets a
 * test enable 2FA without an authenticator app); production `auth.ts` does
 * not set it.
 */
async function setup() {
	const challengeState: { userId?: string } = {};
	const instance = await getTestInstance({
		plugins: [
			twoFactor({
				skipVerificationOnEnable: true,
				twoFactorCookieMaxAge: CHALLENGE_MAX_AGE_SECONDS,
			}),
			createReplicaChallengePlugin(
				challengeState,
				CHALLENGE_MAX_AGE_SECONDS,
			),
		],
	});
	return { ...instance, challengeState };
}

type Instance = Awaited<ReturnType<typeof setup>>;

/**
 * Enable 2FA (password-authenticated) for the instance's default test user.
 * Returns the user id, the plaintext TOTP secret, and the plaintext backup
 * codes from the enable response.
 *
 * The secret is decrypted from the stored `twoFactor` record rather than read
 * out of the enable response's `totpURI`: the URI carries a base32-encoded
 * copy (that is what an authenticator app scans), while `auth.api.generateTOTP`
 * derives its code from the raw secret. Decrypting with better-auth's own
 * public `symmetricDecrypt` and the context's `secretConfig` is how the plugin
 * itself recovers it, so this needs no encoding assumptions of its own.
 */
async function enableTwoFactorForTestUser(instance: Instance) {
	const auth = instance.auth as TestAuth;
	const { testUser } = instance;

	const signIn = await auth.api.signInEmail({
		body: { email: testUser.email, password: testUser.password },
		returnHeaders: true,
	});
	const userId: string = signIn.response.user.id;
	const sessionCookie = extractCookie(signIn.headers, "session_token");

	const enabled = await auth.api.enableTwoFactor({
		body: { password: testUser.password },
		headers: new Headers({ cookie: sessionCookie }),
	});

	const twoFactorRow = await instance.db.findOne<{ secret: string }>({
		model: "twoFactor",
		where: [{ field: "userId", value: userId }],
	});
	if (!twoFactorRow) {
		throw new Error(`No twoFactor row for user ${userId}`);
	}
	const authCtx = await auth.$context;
	const totpSecret = await symmetricDecrypt({
		key: authCtx.secretConfig,
		data: twoFactorRow.secret,
	});

	return {
		userId,
		totpSecret,
		backupCodes: enabled.backupCodes as string[],
	};
}

async function listVerificationRows(
	instance: Instance,
): Promise<VerificationRow[]> {
	const rows = await instance.db.findMany({ model: "verification" });
	return rows as unknown as VerificationRow[];
}

/**
 * Run `action` and return every verification row that did not exist before
 * it. Diffing the table (rather than spying on `createVerificationValue`)
 * keeps the capture agnostic about HOW upstream writes the rows — if a future
 * version writes them through a different adapter method, this still sees
 * them, and the comparison still means something.
 */
async function captureVerificationWrites(
	instance: Instance,
	action: () => Promise<unknown>,
): Promise<VerificationRow[]> {
	const before = new Set(
		(await listVerificationRows(instance)).map((row) => row.id),
	);
	await action();
	return (await listVerificationRows(instance)).filter(
		(row) => !before.has(row.id),
	);
}

interface NormalizedChallenge {
	/**
	 * Every captured row as `normalized identifier -> normalized value`. This
	 * is the whole contract in one comparable object: a row upstream adds, an
	 * identifier it renames, or a seed value it changes all show up as a diff
	 * here.
	 */
	shape: Record<string, string>;
	challengeIdentifier: string;
	expiresAt: number[];
}

/**
 * Strip the two things that legitimately differ between any two challenges —
 * the random challenge identifier and the user id — so the remaining
 * structure can be compared directly.
 *
 * The challenge row is located by VALUE, not by identifier prefix: Better
 * Auth resolves a challenge by looking the cookie's identifier up and
 * treating the row's value as the user id
 * (`verifyTwoFactor` -> `findUserById(verificationToken.value)`). Finding it
 * that way means a renamed identifier prefix surfaces as a diff in `shape`
 * instead of breaking this helper's own lookup.
 */
function normalizeChallenge(
	rows: VerificationRow[],
	userId: string,
): NormalizedChallenge {
	const challengeRows = rows.filter((row) => row.value === userId);
	// Exactly one row carries the user id — the one the `two_factor` cookie
	// points at. If upstream ever writes a second, the assertion below fails
	// loudly rather than this helper silently picking one of them.
	expect(challengeRows).toHaveLength(1);
	const challengeIdentifier = challengeRows[0]?.identifier as string;

	const shape: Record<string, string> = {};
	for (const row of rows) {
		shape[row.identifier.replaceAll(challengeIdentifier, "<CHALLENGE>")] =
			row.value === userId ? "<USER_ID>" : row.value;
	}

	return {
		shape,
		challengeIdentifier,
		expiresAt: rows.map((row) => new Date(row.expiresAt).getTime()),
	};
}

/**
 * Every row in a challenge shares one `expiresAt`, and that expiry sits about
 * `CHALLENGE_MAX_AGE_SECONDS` in the future. The shared value is the part
 * that matters: `beginAttempt()` consumes the attempts row through
 * `consumeVerificationValue`, which rejects an expired row outright, so an
 * attempts row expiring before its own challenge would fail verification with
 * a still-valid cookie.
 */
function expectSharedLifetime(
	normalized: NormalizedChallenge,
	startedAt: number,
) {
	const [first, ...rest] = normalized.expiresAt;
	expect(first).toBeDefined();
	for (const other of rest) {
		expect(other).toBe(first);
	}
	const lifetimeMs = (first as number) - startedAt;
	expect(lifetimeMs).toBeGreaterThanOrEqual(
		CHALLENGE_MAX_AGE_SECONDS * 1000 - EXPIRY_TOLERANCE_MS,
	);
	expect(lifetimeMs).toBeLessThanOrEqual(
		CHALLENGE_MAX_AGE_SECONDS * 1000 + EXPIRY_TOLERANCE_MS,
	);
}

describe("2FA challenge contract — replica vs the installed better-auth", () => {
	it("writes the same verification row set better-auth's own sign-in challenge writes", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { testUser } = instance;
		const { userId } = await enableTwoFactorForTestUser(instance);

		// The expected side, captured from the library at run time: a real
		// credential sign-in for a 2FA-enabled user, which is the one path
		// better-auth's own `hooks.after` matcher covers.
		const nativeStartedAt = Date.now();
		const nativeRows = await captureVerificationWrites(instance, () =>
			auth.api.signInEmail({
				body: { email: testUser.email, password: testUser.password },
				returnHeaders: true,
			}),
		);
		// Guards the harness itself: if the native hook stopped writing rows
		// (or this capture stopped seeing them), the comparison below would
		// pass vacuously for an empty expected set.
		expect(nativeRows.length).toBeGreaterThan(0);

		// The actual side: the replica, through the same instance, same
		// adapter, same lifetime.
		const replicaStartedAt = Date.now();
		const replicaRows = await captureVerificationWrites(instance, () =>
			startReplicaChallenge(instance, userId),
		);

		expect(replicaRows).toHaveLength(nativeRows.length);

		const native = normalizeChallenge(nativeRows, userId);
		const replica = normalizeChallenge(replicaRows, userId);

		// The load-bearing assertion. Deliberately compares the FULL row set
		// rather than looking for the two rows we already know about, so a
		// third required row upstream fails here.
		expect(replica.shape).toEqual(native.shape);

		expect(native.challengeIdentifier).toMatch(
			CHALLENGE_IDENTIFIER_PATTERN,
		);
		expect(replica.challengeIdentifier).toMatch(
			CHALLENGE_IDENTIFIER_PATTERN,
		);

		expectSharedLifetime(native, nativeStartedAt);
		expectSharedLifetime(replica, replicaStartedAt);
	});

	it("produces a challenge that completes through the real TOTP endpoint", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { userId, totpSecret } =
			await enableTwoFactorForTestUser(instance);

		const challenge = await startReplicaChallenge(instance, userId);
		const { code } = await auth.api.generateTOTP({
			body: { secret: totpSecret },
		});

		// No session cookie is sent: `verifyTwoFactor` treats this as an
		// unauthenticated sign-in submission, which is the only case that
		// consumes the attempts row — i.e. exactly the case that broke in
		// production when the row was missing.
		const result = await auth.api.verifyTOTP({
			body: { code },
			headers: new Headers({ cookie: challenge }),
		});

		expect(result.token).toBeTruthy();
		expect(result.user.id).toBe(userId);
	});

	it("produces a challenge that completes through the real backup-code endpoint", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { userId, backupCodes } =
			await enableTwoFactorForTestUser(instance);

		const challenge = await startReplicaChallenge(instance, userId);

		const result = await auth.api.verifyBackupCode({
			body: { code: backupCodes[0] },
			headers: new Headers({ cookie: challenge }),
		});

		expect(result.token).toBeTruthy();
		expect(result.user.id).toBe(userId);
	});

	it("seeds an attempts budget the upstream retry cap actually reads: 5 comparisons, then TOO_MANY_ATTEMPTS", async () => {
		const instance = await setup();
		const auth = instance.auth as TestAuth;
		const { userId, totpSecret } =
			await enableTwoFactorForTestUser(instance);

		const challenge = await startReplicaChallenge(instance, userId);

		// The replica seeds the attempts row at "0". This proves upstream
		// reads that value as a real starting count — a row seeded with
		// anything it parses as spent would reject the FIRST submission, and
		// a row it cannot parse at all is treated as fully spent.
		for (let i = 0; i < 5; i++) {
			const failure = await auth.api
				.verifyTOTP({
					body: { code: WRONG_TOTP_CODE },
					headers: new Headers({ cookie: challenge }),
				})
				.catch((e: unknown) => e);
			expectAPIErrorCode(failure, "INVALID_CODE");
		}

		// The 6th is refused by the per-challenge budget before the code is
		// compared — including a genuinely correct one.
		const { code } = await auth.api.generateTOTP({
			body: { secret: totpSecret },
		});
		const exhausted = await auth.api
			.verifyTOTP({
				body: { code },
				headers: new Headers({ cookie: challenge }),
			})
			.catch((e: unknown) => e);
		expectAPIErrorCode(exhausted, "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE");
	});
});
