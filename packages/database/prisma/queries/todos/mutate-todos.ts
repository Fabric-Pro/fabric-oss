/**
 * The consolidated To Do list's writes (#2340).
 *
 * Every mutation the To Do page performs lands here, and the reason they share
 * one module is that they all have to agree about the same awkward fact: a
 * to-do row is not where a meeting-sourced to-do's completion lives. `TodoItem`
 * binds to a `ProjectMeetingActionItem` by `(transcriptId, itemKey,
 * occurrenceIndex)` — never by row id, because extraction deletes and recreates
 * those rows on every run — and completion is a property of the action item.
 * `TodoItem.completedAt` is for MANUAL rows alone. A write that put completion
 * on both would give the surface two answers, and the read
 * (`list-todos.ts`) only consults one of them per row.
 *
 * WHY THE OCCURRENCE LOOKUP IS A QUERY AND NOT A RELATION.
 * `occurrenceIndex` is a POSITION among the items of one transcript that
 * normalize to the same key, assigned in ascending `orderIndex`. The read
 * expresses that with `ROW_NUMBER() OVER (PARTITION BY transcriptId, itemKey
 * ORDER BY orderIndex)`; there is no Prisma relation that can express it. So
 * `resolveBoundActionItem` fetches exactly that partition — the same rows, the
 * same order, the same tenancy filter the read applies — and indexes into it.
 * Narrowing the partition by anything else would shift every position in it and
 * silently complete a different commitment, so the only filters here are the
 * ones the read also applies.
 *
 * WHAT THIS MODULE DOES NOT DECIDE: who may write. These functions are scoped
 * by `organizationId` — that is the tenant boundary and it is never optional —
 * but an organization member is not automatically entitled to every row in it.
 * A manual to-do may have no project at all, so "the caller can reach the row's
 * project" authorizes nothing for it. The write rule is the READ's own
 * visibility predicate, evaluated over the loaded row in
 * `packages/api/modules/todos/lib/mutation-access.ts`: a row the caller cannot
 * see is a row they cannot change. It loads the row through
 * `loadTodoForMutation` before deciding, so a caller of this module that
 * skipped that step would be writing to a row it had only named.
 */

import { db, Prisma } from "../../client";

/**
 * A to-do as the mutations need to see it.
 *
 * Deliberately narrow, and deliberately including BOTH tenancy scalars and the
 * binding triple: the authorization rule reads `userId` and `projectId`, and
 * the completion write reads the triple. A caller that selected less would have
 * to go back for one of them.
 */
export interface TodoMutationRow {
	id: string;
	source: "MEETING_DIGEST" | "MANUAL";
	transcriptId: string | null;
	itemKey: string | null;
	occurrenceIndex: number | null;
	itemTextSnapshot: string | null;
	title: string | null;
	projectId: string | null;
	/** The row's owner — `user_owned` RLS keys on this column. */
	userId: string | null;
	organizationId: string | null;
	assigneeUserId: string | null;
	assigneeContactId: string | null;
	assignedManually: boolean;
	snoozedUntil: Date | null;
	/** Manual rows only. A meeting-sourced row leaves this null. */
	completedAt: Date | null;
	completedById: string | null;
	lastKnownCompletedAt: Date | null;
	sourceDate: Date;
	createdAt: Date;
	updatedAt: Date;
}

const TODO_MUTATION_SELECT = {
	id: true,
	source: true,
	transcriptId: true,
	itemKey: true,
	occurrenceIndex: true,
	itemTextSnapshot: true,
	title: true,
	projectId: true,
	userId: true,
	organizationId: true,
	assigneeUserId: true,
	assigneeContactId: true,
	assignedManually: true,
	snoozedUntil: true,
	completedAt: true,
	completedById: true,
	lastKnownCompletedAt: true,
	sourceDate: true,
	createdAt: true,
	updatedAt: true,
} as const;

/**
 * One to-do of this organization, or `null`.
 *
 * `findFirst` rather than `findUnique`: the id alone is unique, so `findUnique`
 * would reach a row of another tenant and leave the organization as a check
 * AFTER the match rather than part of it. The same reasoning
 * `updateNonMemberContact` records for its `updateMany`.
 *
 * `null` covers both "no such to-do" and "not this organization's", on purpose.
 * The caller reports one refusal for both, so naming an id never tells anyone
 * whether it exists somewhere else.
 */
export async function loadTodoForMutation(params: {
	todoId: string;
	organizationId: string;
}): Promise<TodoMutationRow | null> {
	return db.todoItem.findFirst({
		where: { id: params.todoId, organizationId: params.organizationId },
		select: TODO_MUTATION_SELECT,
	});
}

/**
 * The same load for a batch, in one query.
 *
 * Returns only the rows that exist in this organization — the caller pairs the
 * result back against the ids it asked for, and reports the missing ones
 * individually. A batch whose every id was deleted by a re-extraction between
 * render and submit therefore returns an empty array rather than throwing, and
 * the caller still answers for each id.
 */
export async function loadTodosForMutation(params: {
	todoIds: readonly string[];
	organizationId: string;
}): Promise<TodoMutationRow[]> {
	if (params.todoIds.length === 0) {
		return [];
	}
	return db.todoItem.findMany({
		where: {
			id: { in: [...params.todoIds] },
			organizationId: params.organizationId,
		},
		select: TODO_MUTATION_SELECT,
	});
}

/**
 * The live action item a meeting-sourced to-do is bound to, or `null` when the
 * binding resolves to nothing (a reworded item, a dropped item, a surplus
 * duplicate — what the read calls an ORPHAN).
 *
 * The partition is `(transcriptId, itemKey)` ordered by `orderIndex`, which is
 * exactly the window the read's `live_action_item` CTE opens, and the
 * `organizationId` filter is exactly the one it applies. Both have to match or
 * the position this function indexes into is not the position the page showed.
 *
 * The transcript relation is the scope guard, the way
 * `applyActionItemCompletion` uses it: a linked-meeting action item has no
 * `projectId` column of its own, so an id paired with someone else's project
 * can only be refused through the relation.
 */
export async function resolveBoundActionItem(params: {
	todo: Pick<
		TodoMutationRow,
		"transcriptId" | "itemKey" | "occurrenceIndex" | "projectId"
	>;
	organizationId: string;
}): Promise<{ id: string; completedAt: Date | null; text: string } | null> {
	const { todo } = params;
	if (
		todo.transcriptId === null ||
		todo.itemKey === null ||
		todo.occurrenceIndex === null
	) {
		return null;
	}

	const partition = await db.projectMeetingActionItem.findMany({
		where: {
			transcriptId: todo.transcriptId,
			itemKey: todo.itemKey,
			organizationId: params.organizationId,
			...(todo.projectId
				? { transcript: { projectId: todo.projectId } }
				: {}),
		},
		orderBy: [{ orderIndex: "asc" }],
		select: { id: true, completedAt: true, text: true },
	});

	return partition[todo.occurrenceIndex] ?? null;
}

/** Where a to-do's completion was written. */
export type TodoCompletionTarget = "action_item" | "todo";

export interface TodoCompletionResult {
	todoId: string;
	target: TodoCompletionTarget;
	completedAt: Date | null;
	/** The action item that carries the completion; null for a manual row. */
	actionItemId: string | null;
}

/**
 * Completes or reopens one to-do, writing to whichever row actually holds
 * completion for its shape.
 *
 * MEETING-SOURCED: the action item takes `completedAt`/`completedById`, and the
 * to-do takes a `lastKnownCompletedAt` SNAPSHOT in the same transaction. That
 * snapshot is not a duplicate of the truth — it is the only record that
 * survives a rewording. Once re-extraction changes the item's text the binding
 * orphans, the action item the completion was written to is gone, and without
 * the snapshot the orphaned row cannot say it had ever been completed. Reopening
 * clears it for the same reason: a stale snapshot would let an orphan claim a
 * completion the person had since taken back.
 *
 * This is NOT the only writer of that pair. The meeting digest writes the same
 * `completedAt` from its own surface and maintains the same snapshot the same
 * way — see `complete-action-item.ts`. The two must keep agreeing exactly,
 * because a person alternating between the surfaces is ordinary use and the
 * snapshot's whole contract ("a non-null value can only mean the binding
 * stopped resolving") is false the moment one of them drifts.
 *
 * MANUAL: the to-do's own `completedAt`/`completedById`, and nothing else. No
 * action item is touched — there is none — and `lastKnownCompletedAt` stays
 * null, because it is a cache of a meeting-sourced row's completion and a
 * manual row reading it back would be reading its own completion twice.
 *
 * ORPHANED (a meeting-sourced row whose binding resolves to nothing live): the
 * to-do's own `completedAt`. There is no live action item to hold it, and a row
 * that can never be closed is worse than one that holds its own completion.
 *
 * Returns `null` only when nothing could be written at all — the to-do vanished
 * between the load and the write.
 */
export async function setTodoCompletion(params: {
	todo: TodoMutationRow;
	organizationId: string;
	completed: boolean;
	/** Who ticked it. Recorded on whichever row carries the completion. */
	userId: string;
	/** One clock per request, passed in for the same reason the read takes one. */
	now?: Date;
}): Promise<TodoCompletionResult | null> {
	const { todo, organizationId, completed, userId } = params;
	const completedAt = completed ? (params.now ?? new Date()) : null;
	const completedById = completed ? userId : null;

	if (todo.transcriptId === null) {
		const result = await db.todoItem.updateMany({
			where: {
				id: todo.id,
				organizationId,
				// Re-asserted rather than assumed: the row was loaded a moment
				// ago and a concurrent write must not turn a manual completion
				// into one silently written onto a meeting-sourced row.
				transcriptId: null,
			},
			data: { completedAt, completedById },
		});
		if (result.count === 0) {
			return null;
		}
		return {
			todoId: todo.id,
			target: "todo",
			completedAt,
			actionItemId: null,
		};
	}

	const actionItem = await resolveBoundActionItem({ todo, organizationId });
	if (!actionItem) {
		// The binding resolves to nothing live: re-extraction reworded the item
		// out from under this row. The commitment the person is tracking is
		// still real, so refusing to let them close it would leave a row that
		// can never be resolved — the failure the orphan path exists to avoid.
		//
		// The row carries the completion itself in that case. This does not
		// break the "never in two places" rule it looks like it breaks: there is
		// no live action item to be the other place. `lastKnownCompletedAt`
		// stays out of it, because it is a cache of a *bound* row's completion
		// and an orphan reading it back would be reading its own twice.
		const orphanWrite = await db.todoItem.updateMany({
			where: { id: todo.id, organizationId },
			data: { completedAt, completedById },
		});
		if (orphanWrite.count === 0) {
			return null;
		}
		return {
			todoId: todo.id,
			target: "todo",
			completedAt,
			actionItemId: null,
		};
	}

	const written = await db.$transaction(async (tx) => {
		const updated = await tx.projectMeetingActionItem.updateMany({
			where: {
				id: actionItem.id,
				organizationId,
				...(todo.projectId
					? { transcript: { projectId: todo.projectId } }
					: {}),
			},
			data: { completedAt, completedById },
		});
		if (updated.count === 0) {
			return false;
		}
		// Same transaction as the completion it snapshots. Split apart, a
		// failure between the two would leave a row the page shows as completed
		// with no snapshot to survive the next rewording, or a snapshot for a
		// completion that never landed.
		await tx.todoItem.updateMany({
			where: { id: todo.id, organizationId },
			data: {
				lastKnownCompletedAt: completedAt,
				// Cleared unconditionally, not left alone. A row completed
				// while it was orphaned carries the completion in its OWN
				// column; if the binding later re-resolves, the read's
				// `COALESCE(ai."completedAt", t."completedAt")` falls through
				// to that stale value and reports the row completed however
				// many times the person reopens it. This is what restores the
				// "never in two places" invariant the bound branch assumes.
				completedAt: null,
				completedById: null,
			},
		});
		return true;
	});

	if (!written) {
		return null;
	}

	return {
		todoId: todo.id,
		target: "action_item",
		completedAt,
		actionItemId: actionItem.id,
	};
}

/**
 * Sets or ends a snooze.
 *
 * `null` ends it. There is no separate "clear" write because the read treats an
 * absent `snoozedUntil` and an elapsed one identically — the boundary in
 * `list-todos.ts` is `snoozedUntil <= now` — so ending a snooze early and never
 * having had one are the same state, and spelling them differently in the
 * database would invent a distinction the read cannot see.
 *
 * Whether a date is allowed (it must not be in the past) is decided by the
 * caller against the request's single clock, not here: this module would have
 * to sample a second clock to check it, and two clocks in one request is how a
 * snooze gets refused and applied in the same breath.
 */
export async function setTodoSnooze(params: {
	todoId: string;
	organizationId: string;
	snoozedUntil: Date | null;
}): Promise<boolean> {
	const result = await db.todoItem.updateMany({
		where: { id: params.todoId, organizationId: params.organizationId },
		data: { snoozedUntil: params.snoozedUntil },
	});
	return result.count > 0;
}

/**
 * What `setTodoAssignee` did, and when it did nothing, which of the two
 * reasons applies.
 *
 * A boolean was enough while the only way to write nothing was "no such to-do
 * in this organization". A contact target can now also be refused BY THE WRITE
 * ITSELF, and the caller has to tell the two apart because they describe
 * different things to the person: one is a to-do that is gone, the other is a
 * contact that is gone. What the caller must NOT do is describe
 * `contact_not_assignable` any differently from the refusal it gives a contact
 * id belonging to another organization — see `assign.ts`.
 */
export type SetTodoAssigneeResult =
	| { assigned: true }
	| {
			assigned: false;
			reason: "todo_not_found" | "contact_not_assignable";
	  };

/** The columns every assignment writes, whoever it names. */
function assigneeWrite(params: {
	assigneeUserId: string | null;
	assigneeContactId: string | null;
}) {
	return {
		assigneeUserId: params.assigneeUserId,
		assigneeContactId: params.assigneeContactId,
		assignedManually: true,
		suggestedUserId: null,
		suggestedContactId: null,
		// `Prisma.DbNull`, not `null` and not `Prisma.JsonNull`: the column
		// is a nullable `Json?`, so the first does not type-check and the
		// second would store the JSON literal `null` — a value the read
		// would hand the page as a present-but-empty suggestion rather than
		// as no suggestion at all.
		suggestionCandidates: Prisma.DbNull,
	};
}

/**
 * Points a to-do at a member, at a non-member contact, or at nobody.
 *
 * Three things happen together and must not be separable:
 *
 *  1. The two assignee columns are written as a pair, so the XOR the model
 *     documents cannot be broken by assigning a contact to a row that already
 *     names a member.
 *  2. `assignedManually` becomes true. That flag is the whole point of the
 *     write: it is what the re-extraction matcher checks before it touches an
 *     assignee, so a person's choice survives the next run instead of being
 *     replaced by the machine's guess.
 *  3. The suggestion columns are cleared. A suggestion is an unconfirmed guess
 *     offered for confirmation; leaving one beside a confirmed assignee would
 *     keep the surface asking a question that has been answered.
 *
 * Whether a MEMBER target is reachable stays the caller's check: membership is
 * a tenancy question about a different table, and a membership that lapses
 * between the check and the write leaves a row naming someone who is merely no
 * longer here — the next re-extraction and every read still describe them
 * correctly.
 *
 * A CONTACT TARGET IS DIFFERENT, AND THIS FUNCTION DECIDES IT — under a row
 * lock, in the same transaction as the write. `redactNonMemberContact` erases a
 * contact by detaching every to-do that points at it and then anonymising the
 * row, all in one transaction. A caller that checked liveness first and wrote
 * afterwards could have that whole erasure commit in between, and its write
 * would then re-attach the erased person to an obligation the erasure had just
 * detached them from — with `assignedManually` set, which freezes the row
 * against the matcher, so nothing downstream would ever clear it again. The
 * lock is what removes the gap:
 *
 *  - `FOR SHARE`, not `FOR UPDATE`: this transaction does not modify the
 *    contact, and two people assigning work to the same contact at once have no
 *    reason to queue behind each other. A shared lock still conflicts with the
 *    redaction's `FOR UPDATE`, which is the only conflict that matters.
 *  - The lock is taken BEFORE the to-do is written, and `redactNonMemberContact`
 *    takes its own contact lock before it detaches anything. One order, both
 *    sides: whoever gets the contact row first wins, and the loser either sees
 *    the tombstone (Postgres re-checks `redactedAt IS NULL` after the wait, so
 *    the row drops out and nothing is written) or has its already-committed
 *    assignment swept up by the erasure's detach. There is no interleaving left
 *    that ends with a live pointer at a redacted contact.
 *
 * The member and unassign paths stay a single statement: they touch one table,
 * so there is nothing to serialize and no transaction to pay for.
 */
export async function setTodoAssignee(params: {
	todoId: string;
	organizationId: string;
	assigneeUserId: string | null;
	assigneeContactId: string | null;
}): Promise<SetTodoAssigneeResult> {
	const where = { id: params.todoId, organizationId: params.organizationId };
	const data = assigneeWrite(params);

	const contactId = params.assigneeContactId;
	if (contactId === null) {
		const result = await db.todoItem.updateMany({ where, data });
		return result.count > 0
			? { assigned: true }
			: { assigned: false, reason: "todo_not_found" };
	}

	return db.$transaction(async (tx): Promise<SetTodoAssigneeResult> => {
		// `$queryRaw` because Prisma has no way to ask for a row lock, and the
		// lock — not the row it returns — is the point. The filter is the same
		// one `isAssignableContact` reads with, so the answer cannot differ
		// from the caller's earlier check for any reason except the race this
		// statement exists to settle.
		const live = await tx.$queryRaw<Array<{ id: string }>>`
			SELECT "id"
			FROM "non_member_contact"
			WHERE "id" = ${contactId}
				AND "organizationId" = ${params.organizationId}
				AND "redactedAt" IS NULL
			FOR SHARE
		`;
		if (live.length === 0) {
			return { assigned: false, reason: "contact_not_assignable" };
		}

		const result = await tx.todoItem.updateMany({ where, data });
		return result.count > 0
			? { assigned: true }
			: { assigned: false, reason: "todo_not_found" };
	});
}

/** Is `userId` a member of this organization right now? */
export async function isAssignableOrganizationMember(params: {
	organizationId: string;
	userId: string;
}): Promise<boolean> {
	const membership = await db.member.findFirst({
		where: {
			organizationId: params.organizationId,
			userId: params.userId,
		},
		select: { id: true },
	});
	return membership !== null;
}

/**
 * Is `contactId` a live contact of this organization?
 *
 * `redactedAt: null` is load-bearing, not tidiness. A redacted row is a
 * tombstone whose name reads "Removed contact"; assigning work to one would
 * re-enter an erased person into the organization's obligations through the
 * back door, which is exactly what `redactNonMemberContact` detaching every
 * to-do exists to prevent.
 *
 * This is the EARLY answer, not the authoritative one. It reads outside any
 * transaction, so what it reports was true at the moment of the read and can
 * stop being true before its caller writes anything; `setTodoAssignee` re-asks
 * the same question under a row lock in the transaction that does the write.
 * Kept because refusing before a transaction is opened is cheaper and because a
 * surface that only wants to know whether a contact is assignable — offering it
 * in a picker, say — should not have to attempt a write to find out.
 */
export async function isAssignableContact(params: {
	organizationId: string;
	contactId: string;
}): Promise<boolean> {
	const contact = await db.nonMemberContact.findFirst({
		where: {
			id: params.contactId,
			organizationId: params.organizationId,
			redactedAt: null,
		},
		select: { id: true },
	});
	return contact !== null;
}

export interface CreateManualTodoParams {
	organizationId: string;
	/** The creator, who is also the row's owner for `user_owned` RLS. */
	userId: string;
	title: string;
	projectId?: string | null;
	/** The request's clock. Becomes `sourceDate`. */
	now?: Date;
}

/**
 * Adds a manual to-do.
 *
 * Every meeting column stays null — that nullity IS the discriminator the read
 * branches on for completion (`transcriptId IS NULL` selects the row's own
 * `completedAt`), so a manual row that carried a stray `transcriptId` would
 * have its completion read off an action item it has no binding to.
 *
 * `sourceDate` is now. The model documents it as "the meeting's date for a
 * meeting-sourced row, creation for a manual one", and BOTH the age cutoff and
 * the recency ordering key off that one field — so a manual row created today
 * sorts with today's work rather than at the bottom of a list it was never
 * given a date for.
 *
 * `assignedManually` stays false: nobody has chosen an assignee yet. It is set
 * by `setTodoAssignee`, which is also where the assignee target is validated —
 * one place, whether the row is a minute or a month old.
 */
export async function createManualTodo(
	params: CreateManualTodoParams,
): Promise<TodoMutationRow> {
	const now = params.now ?? new Date();
	return db.todoItem.create({
		data: {
			source: "MANUAL",
			title: params.title,
			projectId: params.projectId ?? null,
			sourceDate: now,
			createdById: params.userId,
			userId: params.userId,
			organizationId: params.organizationId,
		},
		select: TODO_MUTATION_SELECT,
	});
}
