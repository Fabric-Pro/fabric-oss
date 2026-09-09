/**
 * The library half of the session-organization seed, exercised against a real
 * Better Auth instance (`better-auth/test`'s `getTestInstance` — an in-memory
 * `node:sqlite` database driven through the real request/response cycle
 * in-process) — never `better-auth/dist/**`.
 *
 * WHY THIS FILE EXISTS. The whole fix rests on a contract that lives inside
 * better-auth, not inside Fabric — the return-value contract documented on
 * `seedSessionOrganizationOnCreate`. Until this file, that contract was
 * verified only by reading `dist/db/with-hooks.mjs`. An upgrade that changed
 * the merge would leave `seedSessionOrganizationOnCreate` returning a patch,
 * the library ignoring it, and every other suite green — the fix would die
 * exactly as silently as the bug it fixes was born, because the seed's unit
 * tests call the function themselves and the wiring test only reads `auth.ts`
 * as text.
 *
 * WHAT IS PINNED WHERE.
 *  - `seed-session-organization.test.ts` pins the seed's own contract: never
 *    throws, never overwrites, refuses to guess, returns `{ data }` or
 *    `undefined`.
 *  - `seed-session-organization-wiring.test.ts` pins WHERE each half is mounted
 *    in `auth.ts`, and that the create-time hook's result is returned.
 *  - This file pins what the LIBRARY then does with those returns, and the
 *    interleaving of the two mounts: the merge, the cookie that merge lands in,
 *    the created row the after-hook receives, and the two return values
 *    (`false`, `null`) the seed must never produce.
 *
 * `auth.ts` itself is still not booted here — it builds the Better Auth
 * instance at module load with dozens of side-effecting dependencies, the
 * reason `invite-reconciliation-wiring.test.ts` and
 * `verify-email-two-factor-behavior.test.ts` both give. The hooks below are a
 * port of production's mount, trimmed to the two seed calls; that production
 * really calls them from these two hooks, in that order, is what the wiring
 * test pins statically. The seed functions themselves are the REAL ones —
 * only `@repo/database` and `@repo/logs` are mocked, so the merge, the cookie
 * and the no-op-on-second-seed are the library's actual behaviour and not a
 * fixture's.
 *
 * The `activeOrganizationId` field comes from the real `organization()` plugin,
 * which declares it `input: false`. That flag is checked in `parseInputData`,
 * which parses request bodies — so a hook may still merge the field. The first
 * case below is what proves it, and would catch better-auth moving that guard
 * into the adapter.
 *
 * Run with:
 *   pnpm --filter @repo/auth test lib/__tests__/seed-session-organization-behavior.test.ts
 */

import { getCookieCache, parseSetCookieHeader } from "better-auth/cookies";
import { organization } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveUserOrganization: vi.fn(),
	sessionUpdate: vi.fn(),
	loggerError: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	resolveUserOrganization: (...args: unknown[]) =>
		mocks.resolveUserOrganization(...args),
	db: {
		session: {
			update: (...args: unknown[]) => mocks.sessionUpdate(...args),
		},
	},
}));

vi.mock("@repo/logs", () => ({
	logger: {
		error: (...args: unknown[]) => mocks.loggerError(...args),
		warn: vi.fn(),
		info: vi.fn(),
	},
}));

import {
	seedSessionOrganization,
	seedSessionOrganizationOnCreate,
} from "../seed-session-organization";

const TEST_SECRET = "seed-session-organization-secret-long-enough-to-boot";
const APP_URL = "http://localhost:3000";
const ORG = "org_the_only_membership";
const CREDENTIALS = {
	email: "seed-session@example.com",
	password: "seed-session-password",
	name: "Seed Session",
};

const NO_MEMBERSHIP = { kind: "no_membership" as const };
const RESOLVED = { kind: "resolved" as const, organizationId: ORG };

/** The shape of a session row as it comes back out of the store. */
interface SessionRow {
	id: string;
	token: string;
	userId: string;
	activeOrganizationId?: string | null;
}

/**
 * The narrow slice of better-auth's adapter this file uses to read (and, via
 * the `@repo/database` mock, write) session rows directly.
 */
interface StoreAdapter {
	findOne: (args: {
		model: string;
		where: Array<{ field: string; value: string }>;
	}) => Promise<SessionRow | null>;
	findMany: (args: { model: string }) => Promise<SessionRow[]>;
	update: (args: {
		model: string;
		where: Array<{ field: string; value: string }>;
		update: Record<string, unknown>;
	}) => Promise<unknown>;
}

// The instance type varies with the plugin list passed to getTestInstance;
// the handful of `auth.api.*` calls made here are typed loosely via this alias,
// as in `verify-email-two-factor-behavior.test.ts`.
type TestAuth = any;

/** Every session the after-hook was handed, in order. */
type AfterHookLog = SessionRow[];

/**
 * A Better Auth instance mounted the way `auth.ts` mounts the seed: the real
 * create-time seed on `session.create.before` with its result RETURNED, and the
 * real row-update seed on `session.create.after`.
 *
 * `beforeOverride` exists only for the two cases that pin what the library does
 * with a return value the seed deliberately never produces (`false`, `null`).
 */
async function buildInstance(options?: {
	beforeOverride?: () => Promise<unknown>;
}) {
	const afterHookSaw: AfterHookLog = [];
	const instance = await getTestInstance(
		{
			secret: TEST_SECRET,
			baseURL: APP_URL,
			plugins: [organization()],
			// The cookie is the whole point of the create-time mount: the row
			// and the signed cookie are produced in one request body, and
			// after-hooks drain only once that body has returned.
			session: { cookieCache: { enabled: true, maxAge: 300 } },
			databaseHooks: {
				session: {
					create: {
						before: async (session: any) => {
							if (options?.beforeOverride) {
								// Cast because `null` is not assignable to
								// better-auth's hook type at all — TypeScript
								// already refuses it here. The case below pins
								// what the library does when one reaches it
								// anyway: a JS caller, an `any`-typed helper,
								// or an upgrade that widens the signature.
								return (await options.beforeOverride()) as never;
							}
							return await seedSessionOrganizationOnCreate(
								session,
							);
						},
						after: async (session: any) => {
							afterHookSaw.push({ ...session });
							await seedSessionOrganization(session);
						},
					},
				},
			},
		},
		// The fixture user would sign up (and create a session) before the test
		// can say what the resolver should answer; these tests create their own.
		{ disableTestUser: true },
	);

	const store = instance.db as unknown as StoreAdapter;

	// `seedSessionOrganization`'s write goes through the mocked `@repo/database`
	// client, so point it at the same store better-auth is using. Without this
	// the after-hook path would be asserted only by its call arguments, and the
	// "one write, not two" claim would not be observable on the row itself.
	mocks.sessionUpdate.mockImplementation(
		async ({
			where,
			data,
		}: {
			where: { id: string };
			data: Record<string, unknown>;
		}) =>
			await store.update({
				model: "session",
				where: [{ field: "id", value: where.id }],
				update: data,
			}),
	);

	return { ...instance, store, afterHookSaw };
}

type Instance = Awaited<ReturnType<typeof buildInstance>>;

/**
 * Create the account. Sign-up mints a session of its own, so it runs with the
 * resolver answering "belongs nowhere" — nothing is seeded, and the assertions
 * below are about the sign-in that follows.
 */
async function signUp(instance: Instance): Promise<void> {
	mocks.resolveUserOrganization.mockResolvedValue(NO_MEMBERSHIP);
	await (instance.auth as TestAuth).api.signUpEmail({ body: CREDENTIALS });
	mocks.resolveUserOrganization.mockReset();
	mocks.sessionUpdate.mockClear();
	instance.afterHookSaw.length = 0;
}

interface SignInResult {
	/** The token of the session this sign-in minted. */
	token: string;
	/** Every cookie the sign-in response set, as one `cookie` header. */
	cookieHeader: Headers;
}

async function signIn(instance: Instance): Promise<SignInResult> {
	const { headers, response } = await (
		instance.auth as TestAuth
	).api.signInEmail({
		body: { email: CREDENTIALS.email, password: CREDENTIALS.password },
		returnHeaders: true,
	});

	const pairs: string[] = [];
	const rawSetCookies =
		typeof headers.getSetCookie === "function"
			? headers.getSetCookie()
			: [headers.get("set-cookie")].filter((v: unknown): v is string =>
					Boolean(v),
				);
	for (const raw of rawSetCookies) {
		for (const [name, attributes] of parseSetCookieHeader(raw)) {
			pairs.push(`${name}=${attributes.value ?? ""}`);
		}
	}

	return {
		token: response.token as string,
		cookieHeader: new Headers({ cookie: pairs.join("; ") }),
	};
}

/** The session row as the store actually holds it. */
async function readSession(
	instance: Instance,
	token: string,
): Promise<SessionRow | null> {
	return await instance.store.findOne({
		model: "session",
		where: [{ field: "token", value: token }],
	});
}

/**
 * The session as the API reads it back off the signed cookie — decoded by
 * better-auth's own `getCookieCache`, so the assertion is about the cookie the
 * library wrote, not about a hand-rolled parse of it.
 */
async function readSessionCookie(
	cookieHeader: Headers,
): Promise<SessionRow | null> {
	const cached = (await getCookieCache(cookieHeader, {
		secret: TEST_SECRET,
	})) as { session?: SessionRow } | null;
	return cached?.session ?? null;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("the create-time seed, against a real Better Auth session create", () => {
	// The merge itself. If better-auth ever stops merging a `{ data }` return —
	// or starts enforcing the organization plugin's `input: false` inside the
	// adapter — this is the assertion that fails.
	it("merges the returned patch into the session row the library creates", async () => {
		const instance = await buildInstance();
		await signUp(instance);
		mocks.resolveUserOrganization.mockResolvedValue(RESOLVED);

		const { token } = await signIn(instance);

		const row = await readSession(instance, token);
		expect(row?.activeOrganizationId).toBe(ORG);
		// And no UPDATE ran, so the merge is the only thing that could have put
		// it there. Without this the case would also pass on a before-hook that
		// dropped its return and left the after-hook to write the row — the
		// exact no-op this suite exists to catch.
		expect(mocks.sessionUpdate).not.toHaveBeenCalled();
	});

	// The defect this fix exists for: the row and the signed cookie are written
	// in one request body, and the API reads the cookie. Seeding from the
	// after-hook alone left this value empty (pinned by the after-hook-only case
	// further down).
	it("puts the organization in the session cookie written by that same request", async () => {
		const instance = await buildInstance();
		await signUp(instance);
		mocks.resolveUserOrganization.mockResolvedValue(RESOLVED);

		const { cookieHeader } = await signIn(instance);

		const fromCookie = await readSessionCookie(cookieHeader);
		expect(fromCookie?.activeOrganizationId).toBe(ORG);
	});

	// The interleaving that makes the dual mount safe. `createWithHooks` hands
	// `session.create.after` the CREATED row, so the after-hook seed sees a
	// session that already names an organization and leaves it alone — one
	// write, not two.
	it("hands the after-hook the row it already patched, so the second seed no-ops", async () => {
		const instance = await buildInstance();
		await signUp(instance);
		mocks.resolveUserOrganization.mockResolvedValue(RESOLVED);

		await signIn(instance);

		expect(instance.afterHookSaw).toHaveLength(1);
		expect(instance.afterHookSaw[0]?.activeOrganizationId).toBe(ORG);
		// The after-hook seed short-circuits on an already-set session, so it
		// never reaches the resolver and never writes.
		expect(mocks.sessionUpdate).not.toHaveBeenCalled();
	});

	// The other half of the dual mount. The create-time hook runs strictly
	// ahead of invite reconciliation and organization creation, so a brand-new
	// signup has no membership when it fires; the after-hook seed is that
	// account's only one. Simulated by answering "belongs nowhere" for the
	// create-time call and "resolved" for everything after it.
	it("still seeds from the after-hook when the membership appears mid-request", async () => {
		const instance = await buildInstance();
		await signUp(instance);
		mocks.resolveUserOrganization
			.mockResolvedValueOnce(NO_MEMBERSHIP)
			.mockResolvedValue(RESOLVED);

		const { token, cookieHeader } = await signIn(instance);

		// The row the library created carried nothing — which is what the
		// after-hook is for.
		expect(
			instance.afterHookSaw[0]?.activeOrganizationId ?? null,
		).toBeNull();

		const sessionId = instance.afterHookSaw[0]?.id;
		expect(sessionId).toBeTruthy();
		expect(mocks.sessionUpdate).toHaveBeenCalledTimes(1);
		expect(mocks.sessionUpdate).toHaveBeenCalledWith({
			where: { id: sessionId },
			data: { activeOrganizationId: ORG },
		});

		const row = await readSession(instance, token);
		expect(row?.activeOrganizationId).toBe(ORG);

		// And the cookie does NOT carry it — the exact gap the create-time
		// mount closes, asserted rather than described. If a better-auth
		// upgrade ever made after-hooks run before the body is written, this
		// flips and the second mount stops being necessary.
		const fromCookie = await readSessionCookie(cookieHeader);
		expect(fromCookie?.activeOrganizationId ?? null).toBeNull();
	});
});

describe("the return values the seed must never produce", () => {
	// `createWithHooks` treats a literal `false` as "abort" and creates no
	// session at all. This is why `seedSessionOrganizationOnCreate` returns
	// `undefined` rather than a boolean — a default must never be able to fail
	// a sign-in.
	it("aborts session creation when a create-time hook returns false", async () => {
		const instance = await buildInstance({
			beforeOverride: async () => false,
		});

		await expect(
			(instance.auth as TestAuth).api.signUpEmail({ body: CREDENTIALS }),
		).rejects.toThrow(/Failed to create session/i);

		const sessions = await instance.store.findMany({ model: "session" });
		expect(sessions).toHaveLength(0);
	});

	// `null` is the trap `undefined` avoids: the merge is guarded by
	// `typeof result === "object" && "data" in result`, and `typeof null` is
	// `"object"`, so the `in` check throws INSIDE the session-creation path and
	// takes the sign-in with it.
	it("throws inside the library when a create-time hook returns null", async () => {
		const instance = await buildInstance({
			beforeOverride: async () => null,
		});

		await expect(
			(instance.auth as TestAuth).api.signUpEmail({ body: CREDENTIALS }),
		).rejects.toThrow(/Cannot use 'in' operator/i);
	});
});
