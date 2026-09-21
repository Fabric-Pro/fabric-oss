/**
 * Non-member contact register (#2340).
 *
 * A `NonMemberContact` is a person an organization tracks work against who has
 * no Fabric account — typically a client-side stakeholder who owes
 * deliverables. See the model's `///` docblock in `schema.prisma`: a contact is
 * a SUBJECT of the system, never a user of it, so it holds no membership and
 * grants nobody access.
 *
 * Two behaviours in this file carry the weight of that docblock:
 *
 *  1. **Deletion redacts, it does not remove.** `redactNonMemberContact`
 *     anonymises the row in place and detaches its to-dos. An erasure request
 *     from someone outside the system must always be satisfiable, and it must
 *     never be satisfiable only by silently dropping obligations the
 *     organization is still tracking — so the to-dos survive, in the
 *     Unassigned bucket, and the caller is told how many moved there.
 *
 *  2. **Every read and write is scoped by `organizationId` in the WHERE.**
 *     The table is org-only (`ORG_ONLY_TABLES` in `src/tenant-db.ts`): there is
 *     no owning user to fall back on, so the org filter is the whole tenant
 *     boundary. A contact id alone is never enough to reach a row here.
 */

import { db, type Prisma } from "../client";

/**
 * The name a redacted contact carries afterwards.
 *
 * A tombstone rather than an empty string: a to-do history or an export that
 * still names the row should read as "this person was removed", not as a blank
 * that looks like corrupted data.
 */
export const REDACTED_CONTACT_NAME = "Removed contact";

export interface NonMemberContactRecord {
	id: string;
	organizationId: string;
	name: string;
	email: string | null;
	company: string | null;
	redactedAt: Date | null;
	createdById: string | null;
	createdAt: Date;
	updatedAt: Date;
}

/** A register row plus the number of to-dos currently assigned to it. */
export interface NonMemberContactWithTodoCount extends NonMemberContactRecord {
	todoCount: number;
}

const CONTACT_SELECT = {
	id: true,
	organizationId: true,
	name: true,
	email: true,
	company: true,
	redactedAt: true,
	createdById: true,
	createdAt: true,
	updatedAt: true,
} satisfies Prisma.NonMemberContactSelect;

export interface ListNonMemberContactsParams {
	organizationId: string;
	/** Case-insensitive substring match over name, email and company. */
	search?: string;
	limit?: number;
	offset?: number;
}

/**
 * The organization's register, newest-first by name.
 *
 * Redacted rows are excluded unconditionally — there is no `includeRedacted`
 * switch, because a redacted row holds nothing worth listing and re-surfacing
 * it would undo the erasure the redaction performed.
 */
export async function listNonMemberContacts(
	params: ListNonMemberContactsParams,
): Promise<{
	contacts: NonMemberContactWithTodoCount[];
	total: number;
	hasMore: boolean;
	nextOffset: number | null;
}> {
	const limit = params.limit ?? 100;
	const offset = params.offset ?? 0;
	const search = params.search?.trim();

	const where: Prisma.NonMemberContactWhereInput = {
		organizationId: params.organizationId,
		redactedAt: null,
		...(search
			? {
					OR: [
						{ name: { contains: search, mode: "insensitive" } },
						{ email: { contains: search, mode: "insensitive" } },
						{ company: { contains: search, mode: "insensitive" } },
					],
				}
			: {}),
	};

	const [rows, total] = await Promise.all([
		db.nonMemberContact.findMany({
			where,
			select: {
				id: true,
				organizationId: true,
				name: true,
				email: true,
				company: true,
				redactedAt: true,
				createdById: true,
				createdAt: true,
				updatedAt: true,
				_count: { select: { todos: true } },
			},
			orderBy: [{ name: "asc" }, { id: "asc" }],
			take: limit,
			skip: offset,
		}),
		db.nonMemberContact.count({ where }),
	]);

	const contacts = rows.map(({ _count, ...row }) => ({
		...row,
		todoCount: _count.todos,
	}));

	return {
		contacts,
		total,
		hasMore: offset + contacts.length < total,
		nextOffset:
			offset + contacts.length < total ? offset + contacts.length : null,
	};
}

/**
 * Live contacts in this organization whose name equals `name`, ignoring case
 * and surrounding whitespace.
 *
 * Feeds the create-time duplicate confirmation. Redacted rows are excluded:
 * a tombstone is not a person anyone is about to confuse the new contact with,
 * and matching against one would make every redaction poison the name forever.
 */
export async function findNonMemberContactsByName(params: {
	organizationId: string;
	name: string;
}): Promise<NonMemberContactRecord[]> {
	const name = params.name.trim();
	if (name.length === 0) {
		return [];
	}
	return db.nonMemberContact.findMany({
		where: {
			organizationId: params.organizationId,
			redactedAt: null,
			name: { equals: name, mode: "insensitive" },
		},
		select: CONTACT_SELECT,
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
	});
}

export interface CreateNonMemberContactParams {
	organizationId: string;
	name: string;
	email?: string | null;
	company?: string | null;
	createdById?: string | null;
}

/**
 * Adds a contact. Name is required; email and company are optional and exist
 * so two people with the same name stay distinguishable — the caller decides
 * whether a same-name row is a duplicate or a second person, which is why this
 * function does no duplicate checking of its own.
 */
export async function createNonMemberContact(
	params: CreateNonMemberContactParams,
): Promise<NonMemberContactRecord> {
	return db.nonMemberContact.create({
		data: {
			organizationId: params.organizationId,
			name: params.name.trim(),
			email: normalizeOptional(params.email),
			company: normalizeOptional(params.company),
			createdById: params.createdById ?? null,
		},
		select: CONTACT_SELECT,
	});
}

export interface UpdateNonMemberContactParams {
	contactId: string;
	organizationId: string;
	name?: string;
	email?: string | null;
	company?: string | null;
}

/**
 * Edits a live contact, returning `null` when no live row in this organization
 * carries that id.
 *
 * A redacted row is deliberately unreachable: editing one would write
 * identifying content back into a record whose whole purpose is that it no
 * longer holds any. Undefined fields are left untouched; an explicit `null`
 * clears the column.
 *
 * To-dos are not touched, so a rename leaves every assignment intact — a
 * contact's identity is its row, never its name.
 */
export async function updateNonMemberContact(
	params: UpdateNonMemberContactParams,
): Promise<NonMemberContactRecord | null> {
	const data: {
		name?: string;
		email?: string | null;
		company?: string | null;
	} = {};
	if (params.name !== undefined) {
		data.name = params.name.trim();
	}
	if (params.email !== undefined) {
		data.email = normalizeOptional(params.email);
	}
	if (params.company !== undefined) {
		data.company = normalizeOptional(params.company);
	}

	// updateMany rather than update: `update` keys on the unique id alone and
	// would reach a row in another organization before the WHERE could refuse
	// it. The org filter has to be part of the matching, not a check after it.
	const result = await db.nonMemberContact.updateMany({
		where: {
			id: params.contactId,
			organizationId: params.organizationId,
			redactedAt: null,
		},
		data,
	});
	if (result.count === 0) {
		return null;
	}

	return db.nonMemberContact.findFirst({
		where: {
			id: params.contactId,
			organizationId: params.organizationId,
		},
		select: CONTACT_SELECT,
	});
}

export interface RedactNonMemberContactResult {
	contact: NonMemberContactRecord;
	/**
	 * To-dos that were assigned to this contact and are now unassigned.
	 *
	 * Exact, not approximate: the contact row is locked before this count is
	 * taken, so an assignment committed a moment earlier is included and one
	 * arriving a moment later is refused rather than silently missed. It is
	 * shown to a person as "N to-dos moved to Unassigned", which is a promise
	 * about the whole list and not about a sample of it.
	 */
	detachedTodoCount: number;
	/** To-dos that merely SUGGESTED this contact and no longer do. */
	clearedSuggestionCount: number;
	/** To-dos whose stored candidate list still carried this person's name. */
	strippedCandidateCount: number;
}

/**
 * Erases a contact in place and detaches everything that pointed at it.
 *
 * Returns `null` when no LIVE row in this organization carries that id, which
 * covers both "never existed here" and "already redacted" — the second is not
 * an error to retry, it is an erasure that already happened, and reporting it
 * as a fresh success would put a second erasure row in the audit trail for
 * something that did not occur.
 *
 * The number of open to-dos is never a reason to refuse. Detaching them is what
 * makes that safe: the obligations stay on the list, in the Unassigned bucket,
 * and the caller is handed the count so a person can be told what just moved.
 */
export async function redactNonMemberContact(params: {
	contactId: string;
	organizationId: string;
}): Promise<RedactNonMemberContactResult | null> {
	return db.$transaction(async (tx) => {
		// FIRST, before anything is detached: take the contact row's write
		// lock, and decide liveness from the LOCKED state.
		//
		// Two races die here, and both of them end with an erasure that did not
		// erase. A plain read would let a second delete of the same contact see
		// a live row the first one is already erasing, and report a fresh
		// success for an erasure that did not happen. Worse, it would let
		// `setTodoAssignee` — which locks this same row before it writes —
		// attach a to-do to the contact after this transaction had passed the
		// detach below, leaving a live pointer at a tombstone that nothing
		// afterwards would clear, because the assignment also sets
		// `assignedManually` and freezes the row against the matcher.
		//
		// The lock is taken before the to-do updates because both sides must
		// take the contact first for the order to hold. Whoever loses the race
		// then gets the right answer rather than a stale one: an assignment
		// that was already committed is swept up by the detach below, and one
		// that arrives afterwards finds the row redacted (Postgres re-checks
		// `redactedAt IS NULL` against the updated row once the wait ends) and
		// is refused.
		const locked = await tx.$queryRaw<Array<{ id: string }>>`
			SELECT "id"
			FROM "non_member_contact"
			WHERE "id" = ${params.contactId}
				AND "organizationId" = ${params.organizationId}
				AND "redactedAt" IS NULL
			FOR UPDATE
		`;
		if (locked.length === 0) {
			return null;
		}

		// Scoped by `assigneeContactId` ALONE, with no organization filter. The
		// column is a foreign key into the row being erased, so every match is
		// by construction a row of this organization; adding an
		// `organizationId` filter here could only ever MISS one (TodoItem's own
		// organizationId is nullable) and leave a live pointer at a redacted
		// contact.
		const detached = await tx.todoItem.updateMany({
			where: { assigneeContactId: params.contactId },
			// `assignedManually` goes with the assignee it described. Left set,
			// it tells the matcher this row was decided by a person and must be
			// frozen (`frozenAssignment`), and it tells `TodoSuggestionChips` not
			// to offer anything -- so a row whose owner was just erased would sit
			// in the Unassigned bucket forever with no owner and no way to be
			// offered one. The decision died with the person it named.
			data: { assigneeContactId: null, assignedManually: false },
		});

		// An unapplied suggestion is a pointer too. Left behind, the register
		// would keep offering "Removed contact" as the person to assign work to.
		const clearedSuggestions = await tx.todoItem.updateMany({
			where: { suggestedContactId: params.contactId },
			data: { suggestedContactId: null },
		});

		// The candidate list denormalizes the NAME, and a name is exactly what
		// an erasure has to remove. Clearing `suggestedContactId` alone leaves
		// the erased person in a Json column that `todos.list` serves verbatim
		// and `TodoSuggestionChips` renders as "assign to <name>" -- on a row
		// this very transaction has just made unassigned, which is the state
		// that makes the chip appear at all. Containment (`@>`) narrows the
		// update to rows that actually name this contact, and an emptied array
		// becomes NULL to match the convention the matcher writes with.
		const contactCandidate = JSON.stringify([
			{ kind: "contact", id: params.contactId },
		]);
		const strippedCandidateCount = await tx.$executeRaw`
			UPDATE "todo_item"
			SET "suggestionCandidates" = NULLIF(
				COALESCE(
					(
						SELECT jsonb_agg(candidate)
						FROM jsonb_array_elements("suggestionCandidates") AS candidate
						WHERE NOT (
							candidate->>'kind' = 'contact'
							AND candidate->>'id' = ${params.contactId}
						)
					),
					'[]'::jsonb
				),
				'[]'::jsonb
			)
			WHERE "suggestionCandidates" @> ${contactCandidate}::jsonb
		`;

		const contact = await tx.nonMemberContact.update({
			where: { id: params.contactId },
			data: {
				name: REDACTED_CONTACT_NAME,
				email: null,
				company: null,
				redactedAt: new Date(),
			},
			select: CONTACT_SELECT,
		});

		return {
			contact,
			detachedTodoCount: detached.count,
			clearedSuggestionCount: clearedSuggestions.count,
			strippedCandidateCount,
		};
	});
}

/** Trims, and treats an emptied string as "cleared" rather than as "". */
function normalizeOptional(value: string | null | undefined): string | null {
	if (value === undefined || value === null) {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}
