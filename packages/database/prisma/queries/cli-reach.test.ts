/**
 * `recordOrganizationCliReach` — the two writes behind the CLI connection fact
 * (Fizzy #2457, R2/R32).
 *
 * What is actually under test is the pair of unique constraints, because that
 * is what makes the claim "one row per credential, one first-reach row per
 * organization" survive two clients connecting at the same second — a
 * database-level guarantee, not a claim about whether anything downstream
 * logs it. The reach row upserts on
 * `(organizationId, credentialKind, credentialId)`; the first-reach row is
 * inserted with `skipDuplicates`, which Prisma compiles to
 * `INSERT ... ON CONFLICT DO NOTHING`, and the returned `count` — 1 for the
 * insert that landed, 0 for one the index turned away — is what makes the
 * answer exactly once.
 *
 * So the mock below is not a stub that returns a number: it is a stand-in for
 * the unique index itself, keyed on `organizationId`, which is the only way a
 * test can pin "true on the first call, false on every call after" instead of
 * merely restating the call shape. It also REFUSES a call that drops
 * `skipDuplicates`, because that argument is the whole mechanism — without it
 * the duplicate raises instead of reporting, and the exactly-once answer would
 * be back to being carried by an exception on every request after the first.
 *
 * An `upsert` cannot replace any of this: it would report success to both
 * racers and R25's funnel would double-count the first organization to connect
 * from two machines.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn();
const createMany = vi.fn();
vi.mock("../client", () => ({
	db: {
		organizationCliReach: { upsert: (args: unknown) => upsert(args) },
		organizationCliFirstReach: {
			createMany: (args: unknown) => createMany(args),
		},
	},
}));

const { recordOrganizationCliReach } = await import("./cli-reach");

const ORG = "org-example-alpha";
const OTHER_ORG = "org-example-beta";

interface CreateManyArgs {
	data: Array<{ organizationId: string; firstReachedAt: Date }>;
	skipDuplicates?: boolean;
}

/**
 * The `organizationId` unique index, as `ON CONFLICT DO NOTHING` sees it:
 * inserts what is not already there and reports how many rows that was.
 */
function firstReachIndex() {
	const inserted = new Set<string>();

	return (args: CreateManyArgs): { count: number } => {
		if (!args.skipDuplicates) {
			// Postgres would raise here, not return a count. Failing loudly
			// keeps this suite from passing against a version of the query that
			// went back to letting an exception carry the answer.
			throw Object.assign(new Error("Unique constraint failed"), {
				code: "P2002",
			});
		}

		let count = 0;
		for (const row of args.data) {
			if (!inserted.has(row.organizationId)) {
				inserted.add(row.organizationId);
				count += 1;
			}
		}
		return { count };
	};
}

function reach(
	overrides: { organizationId?: string; credentialId?: string } = {},
) {
	return recordOrganizationCliReach({
		organizationId: overrides.organizationId ?? ORG,
		credentialKind: "ORGANIZATION_API_KEY",
		credentialId: overrides.credentialId ?? "orgkey-1",
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	upsert.mockResolvedValue({ id: "reach-1" });
	createMany.mockImplementation(firstReachIndex());
});

describe("the reach row", () => {
	it("upserts on the organization-and-credential pair", async () => {
		await reach();

		const args = upsert.mock.calls[0][0];
		expect(args.where).toEqual({
			organizationId_credentialKind_credentialId: {
				organizationId: ORG,
				credentialKind: "ORGANIZATION_API_KEY",
				credentialId: "orgkey-1",
			},
		});
	});

	it("refreshes lastReachedAt and leaves firstReachedAt alone", async () => {
		await reach();

		const args = upsert.mock.calls[0][0];
		expect(args.update).toEqual({ lastReachedAt: expect.any(Date) });
		// Absent from the update, not merely equal to the old value: this row's
		// first reach is set once by the create branch and never moves.
		expect(Object.keys(args.update)).not.toContain("firstReachedAt");
		expect(args.create.firstReachedAt).toBeInstanceOf(Date);
	});
});

describe("the first-reach row is the event", () => {
	it("is true on the first call and false on every call after", async () => {
		// The property the whole module exists for, asserted against the index
		// rather than against a mocked return value.
		await expect(reach()).resolves.toEqual({
			firstReachForOrganization: true,
		});
		await expect(reach()).resolves.toEqual({
			firstReachForOrganization: false,
		});
		await expect(reach()).resolves.toEqual({
			firstReachForOrganization: false,
		});
	});

	it("does not re-fire for a second credential in the same organization", async () => {
		await expect(reach({ credentialId: "orgkey-1" })).resolves.toEqual({
			firstReachForOrganization: true,
		});

		// A different machine, a different key, same organization — one event.
		await expect(reach({ credentialId: "orgkey-2" })).resolves.toEqual({
			firstReachForOrganization: false,
		});
	});

	it("gives a different organization its own first reach", async () => {
		await reach();

		await expect(reach({ organizationId: OTHER_ORG })).resolves.toEqual({
			firstReachForOrganization: true,
		});
	});

	it("lets the index decide instead of raising on the steady-state path", async () => {
		await reach();
		await reach();

		// `skipDuplicates` is what turns the duplicate into a count of 0. Without
		// it this runs on every authenticated MCP request as a genuine Postgres
		// ERROR plus a thrown-and-caught Prisma exception.
		for (const [args] of createMany.mock.calls) {
			expect(args.skipDuplicates).toBe(true);
			expect(args.data).toEqual([
				{ organizationId: ORG, firstReachedAt: expect.any(Date) },
			]);
		}
	});

	it("still refreshes the credential's row when the organization already has one", async () => {
		await reach();
		await expect(reach()).resolves.toEqual({
			firstReachForOrganization: false,
		});

		// Not being the first reach is not a failure to record the reach.
		expect(upsert).toHaveBeenCalledTimes(2);
	});

	it("rethrows a failure that is not the constraint", async () => {
		// Swallowing everything here would turn a broken database into a
		// permanent, silent "this organization has never connected". The
		// caller is fire-and-forget and logs it; this layer must not hide it.
		createMany.mockRejectedValue(new Error("connection terminated"));

		await expect(reach()).rejects.toThrow("connection terminated");
	});
});

describe("the order of the two writes", () => {
	it("leaves the first-reach row unwritten when the reach upsert fails", async () => {
		// Load-bearing, and the reason these are not run concurrently: the
		// first-reach row can only ever be inserted once, so if it landed while
		// the call reported a failure, the caller would never emit R25's event
		// and no later request could report a first reach again.
		upsert.mockRejectedValue(new Error("connection terminated"));

		await expect(reach()).rejects.toThrow("connection terminated");
		expect(createMany).not.toHaveBeenCalled();
	});
});
