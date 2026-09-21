/**
 * Assigning a to-do while the same contact is being erased (#2340).
 *
 * `contacts.delete` does not delete: `redactNonMemberContact` detaches every
 * to-do pointing at the contact, clears the suggestions that name it, strips it
 * out of the stored candidate lists and anonymises the row — one transaction,
 * so from outside it either happened or it did not. `todos.assign` writes the
 * other direction. The two are reachable by the same people at the same moment,
 * and the state they must never produce together is a to-do pointing at a
 * tombstone: the erasure has already run, so nothing will detach that row
 * afterwards, and the assignment sets `assignedManually`, which freezes it
 * against the matcher — no later run clears it and none offers a replacement.
 * The row sits in the list owing work to a person who asked to be forgotten.
 *
 * The sibling tests in this folder mock the delegates and assert the shape of
 * one call. This one runs the real assign path and the real erasure against ONE
 * in-memory store, in the orders that actually occur:
 *
 *  - the erasure commits between the caller's `isAssignableContact` check and
 *    the write it authorized (the interleaving this module was changed to
 *    survive);
 *  - the erasure commits while the write is already waiting for the contact
 *    row — what the lock does when it is granted late;
 *  - the assignment commits first, and the erasure that follows sweeps it up
 *    and counts it.
 *
 * What it cannot prove is Postgres's locking itself; the double answers the
 * locking read from the store and the test decides when the erasure lands, so
 * what is pinned here is the ORDER OF THE DECISIONS — that liveness is settled
 * by the statement that writes, not by a read taken before it.
 *
 * Run with:
 *   pnpm --filter @repo/database test assign-redaction-interleaving
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "org-acme";
const OTHER_ORG = "org-other";
const CONTACT = "contact-dana";
const TODO = "todo-scope";

type ContactRow = {
	id: string;
	organizationId: string;
	name: string;
	email: string | null;
	company: string | null;
	redactedAt: Date | null;
	createdById: string | null;
	createdAt: Date;
	updatedAt: Date;
};

type TodoRow = {
	id: string;
	organizationId: string | null;
	assigneeUserId: string | null;
	assigneeContactId: string | null;
	assignedManually: boolean;
	suggestedUserId: string | null;
	suggestedContactId: string | null;
	suggestionCandidates: Array<{ kind: string; id: string }> | null;
};

const store = vi.hoisted(() => ({
	contacts: [] as Array<Record<string, unknown>>,
	todos: [] as Array<Record<string, unknown>>,
	/**
	 * What happens while a locking read waits for another transaction.
	 *
	 * Postgres re-checks the WHERE against the row the winner left behind, so a
	 * lock granted after an erasure commits answers about the TOMBSTONE. The
	 * hook runs the erasure at that moment and is cleared once it has fired.
	 */
	onLockWait: null as null | (() => Promise<void>),
}));

vi.mock("../../../client", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;

	/** Scalar equality, `undefined` meaning "no filter" — as Prisma reads it. */
	const matches = (
		row: Record<string, unknown>,
		where: Record<string, unknown>,
	): boolean => {
		for (const [column, expected] of Object.entries(where)) {
			if (expected === undefined) {
				continue;
			}
			if (row[column] !== expected) {
				return false;
			}
		}
		return true;
	};

	/** `Prisma.DbNull` lands in the store as the null it stands for. */
	const applied = (value: unknown): unknown =>
		value !== null && typeof value === "object" && !(value instanceof Date)
			? null
			: value;

	const delegate = (rows: Array<Record<string, unknown>>) => ({
		findFirst: async ({ where }: { where: Record<string, unknown> }) =>
			rows.find((row) => matches(row, where)) ?? null,
		updateMany: async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			const hit = rows.filter((row) => matches(row, where));
			for (const row of hit) {
				for (const [column, value] of Object.entries(data)) {
					row[column] = applied(value);
				}
			}
			return { count: hit.length };
		},
		update: async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			const row = rows.find((candidate) => matches(candidate, where));
			if (!row) {
				throw new Error("update: no row");
			}
			for (const [column, value] of Object.entries(data)) {
				row[column] = applied(value);
			}
			return { ...row };
		},
	});

	const client = {
		nonMemberContact: delegate(store.contacts),
		todoItem: delegate(store.todos),
		/**
		 * The locking reads, both of them: the erasure's `FOR UPDATE` claim and
		 * the assignment's `FOR SHARE` one. Same filter, same two values, so
		 * one implementation answers both — after letting whatever the test
		 * says is already holding the row commit first.
		 */
		$queryRaw: async (
			_parts: TemplateStringsArray,
			contactId: string,
			organizationId: string,
		) => {
			const waiting = store.onLockWait;
			if (waiting) {
				store.onLockWait = null;
				await waiting();
			}
			return store.contacts.filter(
				(row) =>
					row.id === contactId &&
					row.organizationId === organizationId &&
					row.redactedAt === null,
			);
		},
		/**
		 * The candidate strip, over the same store. The statement interpolates
		 * the contact id (inside the element filter) before the containment
		 * literal, so the id is the first value.
		 */
		$executeRaw: async (
			_parts: TemplateStringsArray,
			contactId: string,
			_contactCandidate: string,
		) => {
			let count = 0;
			for (const row of store.todos) {
				const candidates = row.suggestionCandidates as Array<{
					kind: string;
					id: string;
				}> | null;
				const names = (candidate: { kind: string; id: string }) =>
					candidate.kind === "contact" && candidate.id === contactId;
				if (!candidates?.some(names)) {
					continue;
				}
				const kept = candidates.filter(
					(candidate) => !names(candidate),
				);
				row.suggestionCandidates = kept.length > 0 ? kept : null;
				count += 1;
			}
			return count;
		},
		$transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(client),
	};

	return { ...actual, db: client };
});

const { isAssignableContact, setTodoAssignee } = await import(
	"../mutate-todos"
);
const { redactNonMemberContact, REDACTED_CONTACT_NAME } = await import(
	"../../non-member-contacts"
);

function seed(overrides: { contactOrganizationId?: string } = {}): {
	contact: ContactRow;
	todo: TodoRow;
} {
	const contact: ContactRow = {
		id: CONTACT,
		organizationId: overrides.contactOrganizationId ?? ORG,
		name: "Dana Reyes",
		email: "dev@example.com",
		company: "Example Partners",
		redactedAt: null,
		createdById: "user-creator",
		createdAt: new Date("2026-09-01T09:00:00.000Z"),
		updatedAt: new Date("2026-09-01T09:00:00.000Z"),
	};
	const todo: TodoRow = {
		id: TODO,
		organizationId: ORG,
		assigneeUserId: null,
		assigneeContactId: null,
		assignedManually: false,
		suggestedUserId: null,
		suggestedContactId: CONTACT,
		suggestionCandidates: [{ kind: "contact", id: CONTACT }],
	};
	store.contacts.push(contact as unknown as Record<string, unknown>);
	store.todos.push(todo as unknown as Record<string, unknown>);
	return { contact, todo };
}

const erase = () =>
	redactNonMemberContact({ contactId: CONTACT, organizationId: ORG });

const assign = () =>
	setTodoAssignee({
		todoId: TODO,
		organizationId: ORG,
		assigneeUserId: null,
		assigneeContactId: CONTACT,
	});

beforeEach(() => {
	store.contacts.length = 0;
	store.todos.length = 0;
	store.onLockWait = null;
});

describe("the erasure commits between the check and the write", () => {
	it("refuses the assignment instead of re-attaching the erased person", async () => {
		const { contact, todo } = seed();

		// T1: the procedure's own check, outside any transaction. True, and
		// true is exactly what it was — the row is live at this instant.
		await expect(
			isAssignableContact({ organizationId: ORG, contactId: CONTACT }),
		).resolves.toBe(true);

		// T2: the whole erasure commits. Nothing points at the contact yet, so
		// there is nothing here for it to detach.
		const erasure = await erase();
		expect(erasure?.detachedTodoCount).toBe(0);
		expect(contact.redactedAt).toBeInstanceOf(Date);
		expect(contact.name).toBe(REDACTED_CONTACT_NAME);

		// T3: the write the check authorized. It re-asks under the lock, and
		// the answer has changed.
		await expect(assign()).resolves.toEqual({
			assigned: false,
			reason: "contact_not_assignable",
		});

		// Nothing was written. The row that the erasure left unassigned stays
		// unassigned, and `assignedManually` stays false — set, it would freeze
		// the row against the matcher forever.
		expect(todo.assigneeContactId).toBeNull();
		expect(todo.assignedManually).toBe(false);
	});
});

describe("the erasure commits while the write waits for the row", () => {
	it("refuses once the lock is granted against the tombstone", async () => {
		const { todo } = seed();

		await expect(
			isAssignableContact({ organizationId: ORG, contactId: CONTACT }),
		).resolves.toBe(true);

		// The erasure lands during the wait — the moment a lock granted late
		// describes. Postgres answers the waiting statement from the row the
		// winner committed, which is the tombstone.
		let erased = 0;
		store.onLockWait = async () => {
			const result = await erase();
			erased = result?.detachedTodoCount ?? -1;
		};

		await expect(assign()).resolves.toEqual({
			assigned: false,
			reason: "contact_not_assignable",
		});

		expect(erased).toBe(0);
		expect(todo.assigneeContactId).toBeNull();
		expect(todo.assignedManually).toBe(false);
		// The suggestion the erasure cleared is not resurrected by the refused
		// write either: a refusal writes nothing at all.
		expect(todo.suggestedContactId).toBeNull();
		expect(todo.suggestionCandidates).toBeNull();
	});
});

describe("a live contact", () => {
	it("is assigned, manually, with the suggestion cleared", async () => {
		const { todo } = seed();

		await expect(assign()).resolves.toEqual({ assigned: true });

		expect(todo.assigneeContactId).toBe(CONTACT);
		expect(todo.assigneeUserId).toBeNull();
		// The flag the re-extraction matcher checks before it touches an
		// assignee: without it the next run replaces the choice with a guess.
		expect(todo.assignedManually).toBe(true);
		expect(todo.suggestedContactId).toBeNull();
		expect(todo.suggestionCandidates).toBeNull();
	});

	it("is swept up by an erasure that arrives afterwards, and counted", async () => {
		const { todo } = seed();

		await expect(assign()).resolves.toEqual({ assigned: true });

		const erasure = await erase();

		// The count is what a person is told moved to Unassigned, so it has to
		// include the assignment that committed a moment before the erasure
		// claimed the row.
		expect(erasure?.detachedTodoCount).toBe(1);
		expect(todo.assigneeContactId).toBeNull();
		// `assignedManually` goes with the assignee it described, or the row
		// would sit unassigned and frozen, offered to nobody.
		expect(todo.assignedManually).toBe(false);
	});
});

describe("a contact of another organization", () => {
	it("is refused with the same reason as a redacted one", async () => {
		const { todo } = seed({ contactOrganizationId: OTHER_ORG });

		// The register is org-only with no owning user, so the organization
		// filter IS the tenant boundary — and it is part of the locked read,
		// not a check after it.
		await expect(
			isAssignableContact({ organizationId: ORG, contactId: CONTACT }),
		).resolves.toBe(false);

		// The same reason the redacted case produces, which `assign.ts` maps to
		// the same words: telling them apart would let a caller probe another
		// tenant's register one id at a time.
		await expect(assign()).resolves.toEqual({
			assigned: false,
			reason: "contact_not_assignable",
		});

		expect(todo.assigneeContactId).toBeNull();
		expect(todo.assignedManually).toBe(false);
	});
});
