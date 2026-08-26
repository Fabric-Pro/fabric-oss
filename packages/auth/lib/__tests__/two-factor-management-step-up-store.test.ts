/**
 * Query-shape tests for `createPrismaStepUpGrantStore()`
 * (../two-factor-management-step-up.ts).
 *
 * The grant's security properties are properties of the SQL these four methods
 * emit, not of the hook logic around them. The behavioral suite runs against an
 * in-memory store and cannot observe them, and these tests have no Postgres, so
 * what they pin is the shape:
 *
 *  - mint / consume / restore are each a single `updateMany` with every guard IN
 *    THE WHERE CLAUSE, so a concurrent writer that moved the row between read
 *    and write makes the write match nothing rather than overwrite;
 *  - consume matches on the EXACT `grantedAt` and clears it in the same
 *    statement, which is what makes a grant single-use under concurrency and
 *    stops an old cookie riding a newer grant;
 *  - every session-row predicate carries `expiresAt: { gt: now }`, so a revoked
 *    or expired session can neither receive nor spend a grant even while the
 *    cookie cache would still resolve it;
 *  - restore is guarded on the column still being null, so a grant minted by a
 *    concurrent verification is never clobbered by a late restore;
 *  - the "is 2FA active" predicate is the OR of a fresh user-flag read and an
 *    EXISTENCE check for a verified enrolment row — never a single read whose
 *    absence would open the gate.
 *
 * Run with: pnpm --filter @repo/auth test lib/__tests__/two-factor-management-step-up-store.test.ts
 */

import { describe, expect, it, vi } from "vitest";
import {
	createPrismaStepUpGrantStore,
	type StepUpGrantPrismaClient,
} from "../two-factor-management-step-up";

function createClient(overrides?: {
	findUnique?: () => Promise<unknown>;
	findFirst?: () => Promise<unknown>;
	updateMany?: () => Promise<unknown>;
}) {
	const findUnique = vi.fn(
		overrides?.findUnique ?? (async () => ({ twoFactorEnabled: false })),
	);
	const findFirst = vi.fn(overrides?.findFirst ?? (async () => null));
	const updateMany = vi.fn(
		overrides?.updateMany ?? (async () => ({ count: 1 })),
	);
	const client = {
		user: { findUnique },
		twoFactor: { findFirst },
		session: { updateMany },
	} as unknown as StepUpGrantPrismaClient;
	return { client, findUnique, findFirst, updateMany };
}

const NOW = new Date("2026-08-16T12:00:00.000Z");
const GRANTED_AT = new Date("2026-08-16T11:58:00.000Z");

describe("createPrismaStepUpGrantStore().isTwoFactorActive()", () => {
	it("reads the user flag fresh and checks for a verified row by existence", async () => {
		const { client, findUnique, findFirst } = createClient();
		await createPrismaStepUpGrantStore(client).isTwoFactorActive("user-1");

		expect(findUnique).toHaveBeenCalledWith({
			where: { id: "user-1" },
			// A fresh read, not the session's user: session.cookieCache serves a
			// snapshot up to five minutes old, and "not enrolled" is the UNGATED
			// branch.
			select: { twoFactorEnabled: true },
		});
		expect(findFirst).toHaveBeenCalledWith({
			// Existence, not "read the row then inspect it", so the answer is the
			// same whether or not duplicate rows exist for the user.
			where: { userId: "user-1", verified: true },
			select: { id: true },
		});
	});

	it.each([
		["the user flag alone", { twoFactorEnabled: true }, null, true],
		[
			"a verified row alone",
			{ twoFactorEnabled: false },
			{ id: "row-1" },
			true,
		],
		["both", { twoFactorEnabled: true }, { id: "row-1" }, true],
		["neither", { twoFactorEnabled: false }, null, false],
		["a missing user", null, null, false],
		["a null flag with no row", { twoFactorEnabled: null }, null, false],
	])("treats 2FA as active given %s", async (_label, user, row, expected) => {
		const { client } = createClient({
			findUnique: async () => user,
			findFirst: async () => row,
		});

		await expect(
			createPrismaStepUpGrantStore(client).isTwoFactorActive("user-1"),
		).resolves.toBe(expected);
	});
});

describe("createPrismaStepUpGrantStore() — grant lifecycle", () => {
	it("mints onto a live session row only, in one guarded statement", async () => {
		const { client, updateMany } = createClient();

		const written = await createPrismaStepUpGrantStore(client).grant(
			"sess-1",
			"user-1",
			GRANTED_AT,
		);

		expect(written).toBe(true);
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: "sess-1",
				// Binds the grant to the caller's own session, so a session id
				// belonging to someone else can never be written.
				userId: "user-1",
				// A session revoked between the verification and this write must
				// not receive a grant.
				expiresAt: { gt: GRANTED_AT },
			},
			data: { twoFactorStepUpGrantedAt: GRANTED_AT },
		});
	});

	it("reports a mint that matched nothing, so no cookie is issued for a dead session", async () => {
		const { client } = createClient({
			updateMany: async () => ({ count: 0 }),
		});

		await expect(
			createPrismaStepUpGrantStore(client).grant(
				"sess-1",
				"user-1",
				GRANTED_AT,
			),
		).resolves.toBe(false);
	});

	it("consumes by clearing the exact grant it matched, in one statement", async () => {
		const { client, updateMany } = createClient();

		const consumed = await createPrismaStepUpGrantStore(client).consume(
			"sess-1",
			"user-1",
			GRANTED_AT,
			NOW,
		);

		expect(consumed).toBe(true);
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: "sess-1",
				userId: "user-1",
				// The revocation check that the signed cookie cannot provide: a
				// cookie outlives a deleted session, this predicate does not.
				expiresAt: { gt: NOW },
				// Exact match, so a cookie from an earlier grant cannot spend a
				// newer one.
				twoFactorStepUpGrantedAt: GRANTED_AT,
			},
			// Cleared in the same statement as the match — this is what makes the
			// grant single-use: two concurrent management calls contend on the row
			// and only one can match.
			data: { twoFactorStepUpGrantedAt: null },
		});
	});

	it("refuses the call when the guarded consume matched nothing", async () => {
		const { client } = createClient({
			updateMany: async () => ({ count: 0 }),
		});

		await expect(
			createPrismaStepUpGrantStore(client).consume(
				"sess-1",
				"user-1",
				GRANTED_AT,
				NOW,
			),
		).resolves.toBe(false);
	});

	it("restores only onto a still-null column on a still-live session", async () => {
		const { client, updateMany } = createClient();

		const restored = await createPrismaStepUpGrantStore(client).restore(
			"sess-1",
			GRANTED_AT,
			NOW,
		);

		expect(restored).toBe(true);
		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: "sess-1",
				// Without this a restore racing a fresh verification would replace
				// the newer grant with this older one, and the newer cookie would
				// then fail its exact match.
				twoFactorStepUpGrantedAt: null,
				expiresAt: { gt: NOW },
			},
			data: { twoFactorStepUpGrantedAt: GRANTED_AT },
		});
	});

	it("reports a restore that matched nothing rather than throwing", async () => {
		const { client } = createClient({
			updateMany: async () => ({ count: 0 }),
		});

		await expect(
			createPrismaStepUpGrantStore(client).restore(
				"sess-1",
				GRANTED_AT,
				NOW,
			),
		).resolves.toBe(false);
	});
});
