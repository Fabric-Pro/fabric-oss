/**
 * Unit tests for the non-member contact register queries (#2340).
 *
 * These pin the three properties the procedures above them cannot see, because
 * each one lives in a Prisma argument rather than in a return value:
 *
 *  1. A redacted contact is excluded from every read — the list, the duplicate
 *     lookup, and the edit. Only the shape of the `where` shows that.
 *  2. Redaction detaches to-dos instead of deleting them, and the detach is
 *     scoped by `assigneeContactId` alone so no row can be left pointing at an
 *     erased contact.
 *  3. Every read and write carries `organizationId` in the WHERE. The table is
 *     org-only, so that filter IS the tenant boundary: an id alone must never
 *     be enough to reach a row.
 *
 * Run with:
 *   pnpm --filter @repo/database test __tests__/non-member-contacts.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	contactFindMany: vi.fn(),
	contactFindFirst: vi.fn(),
	contactCount: vi.fn(),
	contactCreate: vi.fn(),
	contactUpdate: vi.fn(),
	contactUpdateMany: vi.fn(),
	contactDelete: vi.fn(),
	todoUpdateMany: vi.fn(),
	/** The raw statement that strips the erased name out of the candidate JSON. */
	todoExecuteRaw: vi.fn(),
	/** The locking read that claims the contact row before anything moves. */
	contactQueryRaw: vi.fn(),
}));

vi.mock("../prisma/client", () => {
	const client = {
		nonMemberContact: {
			findMany: (args: unknown) => mocks.contactFindMany(args),
			findFirst: (args: unknown) => mocks.contactFindFirst(args),
			count: (args: unknown) => mocks.contactCount(args),
			create: (args: unknown) => mocks.contactCreate(args),
			update: (args: unknown) => mocks.contactUpdate(args),
			updateMany: (args: unknown) => mocks.contactUpdateMany(args),
			delete: (args: unknown) => mocks.contactDelete(args),
		},
		todoItem: {
			updateMany: (args: unknown) => mocks.todoUpdateMany(args),
		},
		// A tagged template, so it is handed the string parts and then the
		// interpolated values — the contact id is among the latter.
		$executeRaw: (...args: unknown[]) => mocks.todoExecuteRaw(...args),
		$queryRaw: (...args: unknown[]) => mocks.contactQueryRaw(...args),
		$transaction: (fn: (tx: unknown) => unknown) => fn(client),
	};
	return { db: client, Prisma: {} };
});

import {
	createNonMemberContact,
	findNonMemberContactsByName,
	listNonMemberContacts,
	REDACTED_CONTACT_NAME,
	redactNonMemberContact,
	updateNonMemberContact,
} from "../prisma/queries/non-member-contacts";

const ORG = "org-acme";
const OTHER_ORG = "org-other";

function contactRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "contact-1",
		organizationId: ORG,
		name: "Dana Reyes",
		email: null,
		company: null,
		redactedAt: null,
		createdById: "user-1",
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		...overrides,
	};
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) {
		mock.mockReset();
	}
});

describe("listNonMemberContacts", () => {
	it("excludes redacted contacts and scopes to the organization", async () => {
		mocks.contactFindMany.mockResolvedValue([
			{ ...contactRow(), _count: { todos: 2 } },
		]);
		mocks.contactCount.mockResolvedValue(1);

		const result = await listNonMemberContacts({ organizationId: ORG });

		const where = mocks.contactFindMany.mock.calls[0][0].where;
		expect(where).toMatchObject({
			organizationId: ORG,
			redactedAt: null,
		});
		// The count must use the SAME filter, or `total` reports rows the page
		// can never show and the list paginates past its own end.
		expect(mocks.contactCount.mock.calls[0][0].where).toEqual(where);
		expect(result.contacts).toEqual([
			expect.objectContaining({ id: "contact-1", todoCount: 2 }),
		]);
	});

	it("keeps the redaction filter when a search term is supplied", async () => {
		// The search branch rebuilds the `where`. Spreading the OR over the
		// base filter instead of into it would drop `redactedAt: null` and put
		// erased contacts back in front of anyone who typed in the search box —
		// the one code path where the exclusion is easiest to lose.
		mocks.contactFindMany.mockResolvedValue([]);
		mocks.contactCount.mockResolvedValue(0);

		await listNonMemberContacts({ organizationId: ORG, search: " rey " });

		const where = mocks.contactFindMany.mock.calls[0][0].where;
		expect(where.redactedAt).toBeNull();
		expect(where.organizationId).toBe(ORG);
		expect(where.OR).toEqual([
			{ name: { contains: "rey", mode: "insensitive" } },
			{ email: { contains: "rey", mode: "insensitive" } },
			{ company: { contains: "rey", mode: "insensitive" } },
		]);
	});

	it("reports hasMore only while rows remain", async () => {
		mocks.contactFindMany.mockResolvedValue([
			{ ...contactRow(), _count: { todos: 0 } },
		]);
		mocks.contactCount.mockResolvedValue(3);

		const result = await listNonMemberContacts({
			organizationId: ORG,
			limit: 1,
			offset: 1,
		});

		expect(result.total).toBe(3);
		expect(result.hasMore).toBe(true);
		expect(result.nextOffset).toBe(2);
	});
});

describe("findNonMemberContactsByName", () => {
	it("matches case-insensitively on the trimmed name, excluding redacted rows", async () => {
		mocks.contactFindMany.mockResolvedValue([contactRow()]);

		await findNonMemberContactsByName({
			organizationId: ORG,
			name: "  dana reyes  ",
		});

		expect(mocks.contactFindMany.mock.calls[0][0].where).toEqual({
			organizationId: ORG,
			redactedAt: null,
			name: { equals: "dana reyes", mode: "insensitive" },
		});
	});

	it("never queries for a blank name", async () => {
		// A blank name cannot be created, so a blank duplicate lookup would
		// match nothing useful and would scan the register for every caller who
		// sent whitespace.
		const result = await findNonMemberContactsByName({
			organizationId: ORG,
			name: "   ",
		});

		expect(result).toEqual([]);
		expect(mocks.contactFindMany).not.toHaveBeenCalled();
	});
});

describe("createNonMemberContact", () => {
	it("stores a name-only contact with email and company cleared", async () => {
		mocks.contactCreate.mockResolvedValue(contactRow());

		await createNonMemberContact({
			organizationId: ORG,
			name: "  Dana Reyes  ",
			createdById: "user-1",
		});

		expect(mocks.contactCreate.mock.calls[0][0].data).toEqual({
			organizationId: ORG,
			name: "Dana Reyes",
			email: null,
			company: null,
			createdById: "user-1",
		});
	});

	it("treats a blank email or company as cleared rather than empty text", async () => {
		mocks.contactCreate.mockResolvedValue(contactRow());

		await createNonMemberContact({
			organizationId: ORG,
			name: "Dana Reyes",
			email: "   ",
			company: "",
		});

		const data = mocks.contactCreate.mock.calls[0][0].data;
		expect(data.email).toBeNull();
		expect(data.company).toBeNull();
	});
});

describe("updateNonMemberContact", () => {
	it("matches on id AND organization AND redactedAt, and touches no to-do", async () => {
		mocks.contactUpdateMany.mockResolvedValue({ count: 1 });
		mocks.contactFindFirst.mockResolvedValue(
			contactRow({ name: "Dana Reyes-Okonkwo" }),
		);

		const updated = await updateNonMemberContact({
			contactId: "contact-1",
			organizationId: ORG,
			name: "Dana Reyes-Okonkwo",
		});

		expect(mocks.contactUpdateMany.mock.calls[0][0].where).toEqual({
			id: "contact-1",
			organizationId: ORG,
			redactedAt: null,
		});
		expect(mocks.contactUpdateMany.mock.calls[0][0].data).toEqual({
			name: "Dana Reyes-Okonkwo",
		});
		// A rename must leave every assignment where it is — a contact's
		// identity is its row, not its name.
		expect(mocks.todoUpdateMany).not.toHaveBeenCalled();
		expect(updated?.name).toBe("Dana Reyes-Okonkwo");
	});

	it("returns null without re-reading when nothing matched", async () => {
		// The no-match case covers a contact in another organization and a
		// redacted one alike: both must look identical to the caller, so
		// neither becomes a probe for whether an id exists somewhere else.
		mocks.contactUpdateMany.mockResolvedValue({ count: 0 });

		const updated = await updateNonMemberContact({
			contactId: "contact-1",
			organizationId: OTHER_ORG,
			name: "Whoever",
		});

		expect(updated).toBeNull();
		expect(mocks.contactFindFirst).not.toHaveBeenCalled();
	});

	it("leaves an omitted field untouched and clears an explicit null", async () => {
		mocks.contactUpdateMany.mockResolvedValue({ count: 1 });
		mocks.contactFindFirst.mockResolvedValue(contactRow());

		await updateNonMemberContact({
			contactId: "contact-1",
			organizationId: ORG,
			email: null,
		});

		expect(mocks.contactUpdateMany.mock.calls[0][0].data).toEqual({
			email: null,
		});
	});
});

describe("redactNonMemberContact", () => {
	it("anonymises the row, detaches its to-dos, and reports the count", async () => {
		mocks.contactQueryRaw.mockResolvedValue([{ id: "contact-1" }]);
		mocks.todoUpdateMany
			.mockResolvedValueOnce({ count: 4 })
			.mockResolvedValueOnce({ count: 1 });
		mocks.contactUpdate.mockResolvedValue(
			contactRow({
				name: REDACTED_CONTACT_NAME,
				redactedAt: new Date("2026-02-02T00:00:00.000Z"),
			}),
		);

		const result = await redactNonMemberContact({
			contactId: "contact-1",
			organizationId: ORG,
		});

		// The row survives, emptied — nothing is deleted.
		expect(mocks.contactDelete).not.toHaveBeenCalled();
		const updateData = mocks.contactUpdate.mock.calls[0][0].data;
		expect(updateData.name).toBe(REDACTED_CONTACT_NAME);
		expect(updateData.email).toBeNull();
		expect(updateData.company).toBeNull();
		expect(updateData.redactedAt).toBeInstanceOf(Date);

		// Detach, never delete: the obligations stay on the To Do list and
		// land in the Unassigned bucket.
		expect(mocks.todoUpdateMany.mock.calls[0][0]).toEqual({
			where: { assigneeContactId: "contact-1" },
			// `assignedManually` goes with the assignee it described: left set, the
			// matcher freezes the row and the suggestion chips stay hidden, so a
			// row whose owner was erased could never be offered another one.
			data: { assigneeContactId: null, assignedManually: false },
		});
		expect(mocks.todoUpdateMany.mock.calls[1][0]).toEqual({
			where: { suggestedContactId: "contact-1" },
			data: { suggestedContactId: null },
		});

		expect(result?.detachedTodoCount).toBe(4);
		expect(result?.clearedSuggestionCount).toBe(1);
	});

	it("detaches by contact id alone, with no organization filter", async () => {
		// TodoItem.organizationId is nullable. Adding it to this WHERE could
		// only ever MISS a row and leave a live pointer at an erased contact;
		// it cannot widen anything, because `assigneeContactId` is a foreign
		// key into the row being erased.
		mocks.contactQueryRaw.mockResolvedValue([{ id: "contact-1" }]);
		mocks.todoUpdateMany.mockResolvedValue({ count: 0 });
		mocks.contactUpdate.mockResolvedValue(contactRow());

		await redactNonMemberContact({
			contactId: "contact-1",
			organizationId: ORG,
		});

		for (const call of mocks.todoUpdateMany.mock.calls) {
			expect(call[0].where).not.toHaveProperty("organizationId");
		}
	});

	it("claims the contact row with a lock before it detaches anything", async () => {
		// The claim is a LOCKING read, and it comes first on purpose. Both
		// sides of this race take the contact row before they touch a to-do:
		// `setTodoAssignee` locks it (FOR SHARE) before writing an assignment,
		// this locks it (FOR UPDATE) before detaching them. With the order the
		// same on both sides there is no interleaving that leaves a to-do
		// pointing at a tombstone — the loser either has its assignment swept
		// up by the detach below or finds the row already redacted.
		mocks.contactQueryRaw.mockResolvedValue([{ id: "contact-1" }]);
		mocks.todoUpdateMany.mockResolvedValue({ count: 0 });
		mocks.contactUpdate.mockResolvedValue(contactRow());

		await redactNonMemberContact({
			contactId: "contact-1",
			organizationId: ORG,
		});

		const [parts, ...values] = mocks.contactQueryRaw.mock.calls[0] as [
			string[],
			...unknown[],
		];
		const sql = parts.join("?");
		expect(sql).toContain('FROM "non_member_contact"');
		expect(sql).toContain('"redactedAt" IS NULL');
		expect(sql).toContain("FOR UPDATE");
		// The organization is part of the claim, not a check after it: an id
		// alone must never be enough to reach a row in this table.
		expect(values).toEqual(["contact-1", ORG]);
		expect(mocks.contactQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.todoUpdateMany.mock.invocationCallOrder[0],
		);
	});

	it("refuses an already-redacted contact without writing anything", async () => {
		// The locked read carries `redactedAt: null`, so a second delete finds
		// nothing — and because it is taken under the lock, a second delete
		// running CONCURRENTLY waits and then sees the tombstone rather than
		// the live row it started from. Returning a fresh success here would
		// put a second erasure in the audit trail for something that did not
		// happen.
		mocks.contactQueryRaw.mockResolvedValue([]);

		const result = await redactNonMemberContact({
			contactId: "contact-1",
			organizationId: ORG,
		});

		expect(result).toBeNull();
		expect(mocks.todoUpdateMany).not.toHaveBeenCalled();
		expect(mocks.contactUpdate).not.toHaveBeenCalled();
	});

	it("refuses an id belonging to another organization", async () => {
		mocks.contactQueryRaw.mockResolvedValue([]);

		const result = await redactNonMemberContact({
			contactId: "contact-1",
			organizationId: OTHER_ORG,
		});

		expect(result).toBeNull();
		expect(mocks.contactUpdate).not.toHaveBeenCalled();
	});

	it("never refuses because to-dos are open", async () => {
		// An erasure request from someone outside the system must always be
		// satisfiable. A large open-to-do count is reported, never a blocker.
		mocks.contactQueryRaw.mockResolvedValue([{ id: "contact-1" }]);
		mocks.todoUpdateMany
			.mockResolvedValueOnce({ count: 12 })
			.mockResolvedValueOnce({ count: 0 });
		mocks.contactUpdate.mockResolvedValue(contactRow());

		const result = await redactNonMemberContact({
			contactId: "contact-1",
			organizationId: ORG,
		});

		expect(result?.detachedTodoCount).toBe(12);
	});
});
