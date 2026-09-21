/**
 * The meeting digest's completion write, and the to-do snapshot it maintains
 * (#2340).
 *
 * WHY THIS LIVES IN THE TODOS FOLDER. Ticking an action item off is the meeting
 * digest's feature and predates the To Do list by a long way. What brought it
 * here is that `ProjectMeetingActionItem.completedAt` stopped being a value only
 * one surface reads: `TodoItem.lastKnownCompletedAt` is a snapshot of it, and
 * the To Do page renders "you did this once" from that snapshot for a row whose
 * binding has since stopped resolving. A snapshot maintained by only one of the
 * two surfaces that write the value is not a snapshot — it is a second answer
 * that drifts the first time anyone alternates between them, and alternating is
 * ordinary use: the digest needs `PROJECT_READ`, the To Do page needs
 * organization membership and a row its visibility rule admits, and the same
 * people have both.
 *
 * So the digest's write is expressed here, beside `resolveBoundActionItem`,
 * which walks the identical partition in the opposite direction. Both
 * directions of one binding in one module is the same reason
 * `bind-action-items.ts` gives for being the only place that turns a live item
 * into `(transcriptId, itemKey, occurrenceIndex)` and back.
 *
 * WHAT IT GUARANTEES, and it must keep matching `setTodoCompletion` exactly:
 *
 *  - completing writes the snapshot, reopening CLEARS it, so a non-null
 *    `lastKnownCompletedAt` on a row that does not read as completed can only
 *    mean the binding stopped resolving — the contract `wasPreviouslyCompleted`
 *    on the page depends on;
 *  - the bound row's OWN `completedAt`/`completedById` are cleared with it,
 *    because a bound row's completion lives on the action item and a row
 *    completed while it was orphaned would otherwise keep reporting itself
 *    completed through the read's `COALESCE` once its binding re-resolved;
 *  - both writes land in ONE transaction, so no failure can leave a completion
 *    without its snapshot or a snapshot without its completion.
 *
 * WHAT IT DOES NOT DECIDE: who may write. The caller proves project access
 * first; `projectId` here is only the scope guard that a linked-meeting action
 * item — which has no `projectId` column of its own — can be refused through.
 */

import { db } from "../../client";

export interface ActionItemCompletionWrite {
	/**
	 * Did the scoped update address a real action item of this project?
	 *
	 * `false` covers "no such item" and "not this project's" together, on
	 * purpose: the caller reports one refusal for both, so naming an id never
	 * tells anyone whether it exists in someone else's project.
	 */
	matched: boolean;
	completedAt: Date | null;
	/**
	 * How many bound to-do rows took the snapshot — 0 or 1, since the binding
	 * triple is a unique constraint.
	 *
	 * Zero is the ordinary case for every transcript the to-do matcher has not
	 * run over, and for a digest-only organization it is the only case. It is
	 * never an error: the action item is still the truth, and a to-do that does
	 * not exist has nothing to remember.
	 */
	snapshotWrites: number;
}

/**
 * Sets or clears completion on one meeting action item, carrying the bound
 * to-do's snapshot with it.
 *
 * `organizationId` is the tenant the caller was resolved into, and it is the
 * SAME value the To Do read partitions on. That matters more than it looks: the
 * read numbers occurrences with `ROW_NUMBER() OVER (PARTITION BY transcriptId,
 * itemKey ORDER BY orderIndex)` over the items of THAT organization, so a write
 * that computed the position over a different set would address a different
 * commitment. When it is absent the snapshot is skipped rather than computed
 * over an unfiltered partition — no to-do is reachable without an organization
 * anyway (`listVisibleTodos` and `loadTodoForMutation` both require one), so
 * there is nothing to keep in step and guessing would be the only way to get it
 * wrong.
 */
export async function setActionItemCompletion(params: {
	actionItemId: string;
	/** The project the caller was authorized for — the scope guard, not a filter. */
	projectId: string;
	organizationId: string | null | undefined;
	/** Who ticked it. */
	userId: string;
	completed: boolean;
	/** One clock per request, passed in for the same reason the read takes one. */
	now?: Date;
}): Promise<ActionItemCompletionWrite> {
	const { organizationId, projectId } = params;
	const completedAt = params.completed ? (params.now ?? new Date()) : null;
	const completedById = params.completed ? params.userId : null;

	// Scoping goes through the `transcript` relation because a linked-meeting
	// action item has no direct `projectId` column, so a client-supplied id
	// belonging to another project can never match.
	const scope = {
		id: params.actionItemId,
		transcript: { projectId },
	};

	return db.$transaction(async (tx) => {
		const updated = await tx.projectMeetingActionItem.updateMany({
			where: scope,
			data: { completedAt, completedById },
		});
		if (updated.count === 0) {
			return { matched: false, completedAt, snapshotWrites: 0 };
		}

		if (!organizationId) {
			return { matched: true, completedAt, snapshotWrites: 0 };
		}

		// Re-read inside the transaction for the binding half of the row. The
		// caller names an action item id; the to-do is addressed by
		// `(transcriptId, itemKey, occurrenceIndex)` and none of the three is in
		// the input, because none of them is stable enough to be — extraction
		// deletes and recreates these rows on every run.
		const item = await tx.projectMeetingActionItem.findFirst({
			where: { ...scope, organizationId },
			select: { id: true, transcriptId: true, itemKey: true },
		});
		// A null `itemKey` is a row written before the to-do binding existed.
		// The read excludes those from its partition (`itemKey IS NOT NULL`), so
		// no to-do can be bound to one and there is no snapshot to maintain.
		if (!item || item.itemKey === null) {
			return { matched: true, completedAt, snapshotWrites: 0 };
		}

		// Exactly the window the read opens and `resolveBoundActionItem` indexes
		// into: the same partition columns, the same order, the same tenancy
		// filter. Narrowing it further — by project, by completion, by anything —
		// would shift every position in it and snapshot a different commitment.
		// (Narrowing by project would in fact be a no-op, since a transcript
		// belongs to one project, but writing it here would invite a narrowing
		// that is not.)
		const partition = await tx.projectMeetingActionItem.findMany({
			where: {
				transcriptId: item.transcriptId,
				itemKey: item.itemKey,
				organizationId,
			},
			orderBy: [{ orderIndex: "asc" }],
			select: { id: true },
		});
		const occurrenceIndex = partition.findIndex(
			(row) => row.id === item.id,
		);
		if (occurrenceIndex < 0) {
			return { matched: true, completedAt, snapshotWrites: 0 };
		}

		const snapshot = await tx.todoItem.updateMany({
			where: {
				transcriptId: item.transcriptId,
				itemKey: item.itemKey,
				occurrenceIndex,
				organizationId,
			},
			data: {
				lastKnownCompletedAt: completedAt,
				// Cleared with the snapshot, exactly as `setTodoCompletion` does
				// for a bound row. A row completed while it was orphaned carries
				// the completion in its OWN column, and the read's
				// `COALESCE(ai."completedAt", t."completedAt")` would fall through
				// to that stale value the moment the binding resolved again —
				// reporting the row completed however often it is reopened here.
				completedAt: null,
				completedById: null,
			},
		});

		return {
			matched: true,
			completedAt,
			snapshotWrites: snapshot.count,
		};
	});
}
