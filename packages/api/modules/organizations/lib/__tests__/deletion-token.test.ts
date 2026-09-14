/**
 * The deletion confirmation token (Fizzy #2462).
 *
 * This token is the only thing proving that the person confirming a deletion is
 * the person who asked for it, so the properties below are the security surface
 * of the whole flow rather than incidental behaviour:
 *
 *  - it is spendable exactly ONCE, so a forwarded or re-opened link cannot
 *    delete a second time (and, after a restore, cannot re-delete at all);
 *  - it expires;
 *  - it names the organization it was minted for, so it is not a general
 *    "delete something" capability;
 *  - every failure looks identical to the caller. Distinguishing unknown from
 *    expired from already-spent tells an attacker exactly as much as it tells
 *    an honest user.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = {
	create: vi.fn(),
	findFirst: vi.fn(),
	findMany: vi.fn(),
	deleteMany: vi.fn(),
};

vi.mock("@repo/database", () => ({
	db: { verification: store },
}));

const ORG_ID = "org-example";
const USER_ID = "user-example";

async function load() {
	return await import("../deletion-token");
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("createOrganizationDeletionToken", () => {
	it("stores the organization and requester, and returns a future expiry", async () => {
		const { createOrganizationDeletionToken } = await load();
		store.create.mockResolvedValue({});

		const { token, expiresAt } = await createOrganizationDeletionToken({
			organizationId: ORG_ID,
			userId: USER_ID,
		});

		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

		const row = store.create.mock.calls[0]?.[0]?.data;
		expect(row.identifier).toBe(`delete-org-${token}`);
		expect(JSON.parse(row.value)).toEqual({
			organizationId: ORG_ID,
			userId: USER_ID,
		});
	});

	it("mints a different token every time", async () => {
		const { createOrganizationDeletionToken } = await load();
		store.create.mockResolvedValue({});

		const a = await createOrganizationDeletionToken({
			organizationId: ORG_ID,
			userId: USER_ID,
		});
		const b = await createOrganizationDeletionToken({
			organizationId: ORG_ID,
			userId: USER_ID,
		});

		expect(a.token).not.toBe(b.token);
	});
});

describe("consumeOrganizationDeletionToken", () => {
	const validRow = {
		id: "verification-1",
		value: JSON.stringify({ organizationId: ORG_ID, userId: USER_ID }),
		expiresAt: new Date(Date.now() + 60_000),
	};

	it("returns the payload and deletes the row in the same call", async () => {
		const { consumeOrganizationDeletionToken } = await load();
		store.findFirst.mockResolvedValue(validRow);
		store.deleteMany.mockResolvedValue({ count: 1 });

		const payload = await consumeOrganizationDeletionToken("tok");

		expect(payload).toEqual({ organizationId: ORG_ID, userId: USER_ID });
		expect(store.deleteMany).toHaveBeenCalledWith({
			where: { id: validRow.id },
		});
	});

	it("refuses when the row was already removed by a concurrent redemption", async () => {
		// Two tabs, one token. The delete reports how many rows it actually
		// removed, and only the caller that removed one is holding a real token.
		const { consumeOrganizationDeletionToken } = await load();
		store.findFirst.mockResolvedValue(validRow);
		store.deleteMany.mockResolvedValue({ count: 0 });

		expect(await consumeOrganizationDeletionToken("tok")).toBeNull();
	});

	it("refuses an expired token, and still removes the row", async () => {
		const { consumeOrganizationDeletionToken } = await load();
		store.findFirst.mockResolvedValue({
			...validRow,
			expiresAt: new Date(Date.now() - 1),
		});
		store.deleteMany.mockResolvedValue({ count: 1 });

		expect(await consumeOrganizationDeletionToken("tok")).toBeNull();
		expect(store.deleteMany).toHaveBeenCalled();
	});

	it("refuses an unknown token", async () => {
		const { consumeOrganizationDeletionToken } = await load();
		store.findFirst.mockResolvedValue(null);

		expect(await consumeOrganizationDeletionToken("nope")).toBeNull();
		expect(store.deleteMany).not.toHaveBeenCalled();
	});

	it("refuses a row whose payload is malformed rather than throwing", async () => {
		const { consumeOrganizationDeletionToken } = await load();
		store.findFirst.mockResolvedValue({ ...validRow, value: "not json" });
		store.deleteMany.mockResolvedValue({ count: 1 });

		expect(await consumeOrganizationDeletionToken("tok")).toBeNull();
	});
});

describe("readOrganizationDeletionToken", () => {
	it("returns the payload WITHOUT spending the token", async () => {
		const { readOrganizationDeletionToken } = await load();
		store.findFirst.mockResolvedValue({
			value: JSON.stringify({ organizationId: ORG_ID, userId: USER_ID }),
			expiresAt: new Date(Date.now() + 60_000),
		});

		const payload = await readOrganizationDeletionToken("tok");

		expect(payload).toEqual({ organizationId: ORG_ID, userId: USER_ID });
		// The load-bearing assertion of this whole describe block. A read that
		// deleted would burn the token on page render — which is exactly what
		// a link-following mail scanner triggers, leaving the owner holding a
		// dead link they never clicked.
		expect(store.deleteMany).not.toHaveBeenCalled();
	});

	it("can be called repeatedly with the same result", async () => {
		const { readOrganizationDeletionToken } = await load();
		store.findFirst.mockResolvedValue({
			value: JSON.stringify({ organizationId: ORG_ID, userId: USER_ID }),
			expiresAt: new Date(Date.now() + 60_000),
		});

		const first = await readOrganizationDeletionToken("tok");
		const second = await readOrganizationDeletionToken("tok");

		expect(first).toEqual(second);
		expect(store.deleteMany).not.toHaveBeenCalled();
	});

	it("looks the token up under the namespaced identifier", async () => {
		const { readOrganizationDeletionToken } = await load();
		store.findFirst.mockResolvedValue(null);

		await readOrganizationDeletionToken("tok");

		expect(store.findFirst.mock.calls[0]?.[0]?.where).toEqual({
			identifier: "delete-org-tok",
		});
	});

	// The same indistinguishable-failure property `consume` has, for the same
	// reason: this feeds a page that would otherwise become an oracle telling
	// the holder of a link WHICH way it was invalid.
	it.each([
		["unknown", null],
		[
			"expired",
			{
				value: JSON.stringify({
					organizationId: ORG_ID,
					userId: USER_ID,
				}),
				expiresAt: new Date(Date.now() - 1),
			},
		],
		[
			"malformed",
			{ value: "not json", expiresAt: new Date(Date.now() + 60_000) },
		],
		[
			"missing fields",
			{
				value: JSON.stringify({ organizationId: ORG_ID }),
				expiresAt: new Date(Date.now() + 60_000),
			},
		],
	])("returns null for a %s token", async (_label, row) => {
		const { readOrganizationDeletionToken } = await load();
		store.findFirst.mockResolvedValue(row);

		expect(await readOrganizationDeletionToken("tok")).toBeNull();
		expect(store.deleteMany).not.toHaveBeenCalled();
	});
});

describe("revokeOrganizationDeletionTokens", () => {
	it("removes only the tokens naming this organization", async () => {
		// A link minted before a restore must not still be spendable afterwards,
		// or a stale mail could re-delete what someone deliberately brought back.
		const { revokeOrganizationDeletionTokens } = await load();
		store.findMany.mockResolvedValue([
			{
				id: "keep",
				value: JSON.stringify({
					organizationId: "org-other",
					userId: USER_ID,
				}),
			},
			{
				id: "drop",
				value: JSON.stringify({
					organizationId: ORG_ID,
					userId: USER_ID,
				}),
			},
			{ id: "malformed", value: "{{" },
		]);
		store.deleteMany.mockResolvedValue({ count: 1 });

		const result = await revokeOrganizationDeletionTokens(ORG_ID);

		expect(result).toEqual({ revoked: 1 });
		expect(store.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["drop"] } },
		});
	});

	it("does no write when nothing matches", async () => {
		const { revokeOrganizationDeletionTokens } = await load();
		store.findMany.mockResolvedValue([]);

		expect(await revokeOrganizationDeletionTokens(ORG_ID)).toEqual({
			revoked: 0,
		});
		expect(store.deleteMany).not.toHaveBeenCalled();
	});
});
