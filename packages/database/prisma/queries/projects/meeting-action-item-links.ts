/**
 * Database queries for links between meeting action items and work items (#1902).
 *
 * Identity note: rows key on `itemKey` (see meeting-action-item-keys.ts), never
 * on ProjectMeetingActionItem.id, because extraction deletes and recreates those
 * rows. Every read therefore joins by (transcriptId, itemKey) rather than by a
 * foreign key to the item row.
 *
 * Removal is a tombstone (`status: DISMISSED`), not a delete. A matching run
 * must never re-suggest a link the user has already rejected, which a hard
 * delete could not express — the same reason StoryDuplicateLink keeps DISMISSED
 * rows and the scan reads `listDismissedDuplicatePairKeys`.
 *
 * Tenant isolation: like the sibling meeting helpers, these are always reached
 * through a procedure that has already validated project access, and every query
 * is scoped by `transcriptId` or `storyId` whose parent was resolved under that
 * check. RLS (`meeting_action_item_link`, user_owned) is the second layer.
 */

import { db } from "../../client";

export type ActionItemLinkRow = {
	id: string;
	itemKey: string;
	storyId: string;
	origin: "AUTO" | "MANUAL" | "CREATED";
	confidence: number | null;
	similarity: number | null;
	reasoning: string | null;
	identifier: string | null;
	title: string;
	statusName: string | null;
	isDone: boolean;
};

export type StoryMeetingReference = {
	linkId: string;
	itemKey: string;
	itemText: string;
	origin: "AUTO" | "MANUAL" | "CREATED";
	meetingSubject: string | null;
	meetingDate: Date | null;
	/** The Graph transcript id the digest deep link needs — NOT the row cuid. */
	transcriptRef: string;
	projectId: string;
};

/** Composite key for "is this (item, work item) pair already decided?". */
export function linkStateKey(itemKey: string, storyId: string): string {
	return `${itemKey}:${storyId}`;
}

/**
 * Active links for one meeting.
 *
 * Ordering is people first, then machine suggestions by descending confidence.
 * MANUAL and CREATED links carry no confidence, so `nulls: "first"` is what puts
 * them at the top — a link somebody deliberately made should outrank one the
 * matcher merely proposed.
 *
 * The nulls placement is stated explicitly rather than left to the database
 * default (Postgres already sorts NULLs first on DESC, so this is not a change
 * in behaviour) — relying on that default silently is how the ordering ends up
 * inverted the day this query moves or the column becomes non-null.
 */
export async function listActionItemLinks(
	transcriptId: string,
): Promise<ActionItemLinkRow[]> {
	const rows = await db.meetingActionItemLink.findMany({
		where: { transcriptId, status: "ACTIVE" },
		select: {
			id: true,
			itemKey: true,
			storyId: true,
			origin: true,
			confidence: true,
			similarity: true,
			reasoning: true,
			story: {
				select: {
					identifier: true,
					title: true,
					status: { select: { name: true, isFinal: true } },
				},
			},
		},
		orderBy: [
			{ confidence: { sort: "desc", nulls: "first" } },
			{ createdAt: "asc" },
		],
	});
	return rows.map((r) => ({
		id: r.id,
		itemKey: r.itemKey,
		storyId: r.storyId,
		origin: r.origin,
		confidence: r.confidence,
		similarity: r.similarity,
		reasoning: r.reasoning,
		identifier: r.story.identifier,
		title: r.story.title,
		statusName: r.story.status?.name ?? null,
		isDone: r.story.status?.isFinal ?? false,
	}));
}

/**
 * Pairs a matching run must leave alone: every pair that already has a row,
 * whatever its status. DISMISSED means the user rejected it; ACTIVE means it
 * already exists (and if it is MANUAL or CREATED, a machine suggestion must not
 * overwrite the person's provenance).
 */
export async function listDecidedLinkKeys(
	transcriptId: string,
): Promise<Set<string>> {
	const rows = await db.meetingActionItemLink.findMany({
		where: { transcriptId },
		select: { itemKey: true, storyId: true },
	});
	return new Set(rows.map((r) => linkStateKey(r.itemKey, r.storyId)));
}

export type AutoLinkRow = {
	itemKey: string;
	itemTextSnapshot: string;
	storyId: string;
	similarity: number;
	confidence: number;
	reasoning: string | null;
};

/**
 * Persist a matching run's accepted verdicts.
 *
 * `skipDuplicates` plus the caller's `listDecidedLinkKeys` filter is belt and
 * braces: the filter is the intent (never touch a decided pair), the constraint
 * is the guarantee against a concurrent run racing between the read and write.
 * Returns the number of rows actually inserted.
 */
export async function insertAutoLinks(params: {
	transcriptId: string;
	projectId: string;
	userId: string | null;
	organizationId: string | null;
	rows: AutoLinkRow[];
}): Promise<number> {
	if (params.rows.length === 0) {
		return 0;
	}
	const result = await db.meetingActionItemLink.createMany({
		data: params.rows.map((row) => ({
			transcriptId: params.transcriptId,
			projectId: params.projectId,
			itemKey: row.itemKey,
			itemTextSnapshot: row.itemTextSnapshot,
			storyId: row.storyId,
			origin: "AUTO" as const,
			status: "ACTIVE" as const,
			similarity: row.similarity,
			confidence: row.confidence,
			reasoning: row.reasoning,
			userId: params.userId,
			organizationId: params.organizationId,
		})),
		skipDuplicates: true,
	});
	return result.count;
}

/**
 * Create a person-made link, or revive one they had previously dismissed.
 *
 * The upsert IS the revive path: re-adding a dismissed pair clears the tombstone
 * and restores the row rather than failing on the unique constraint.
 */
export async function upsertPersonLink(params: {
	transcriptId: string;
	projectId: string;
	itemKey: string;
	itemTextSnapshot: string;
	storyId: string;
	origin: "MANUAL" | "CREATED";
	createdById: string;
	userId: string | null;
	organizationId: string | null;
}): Promise<{ id: string }> {
	return db.meetingActionItemLink.upsert({
		where: {
			transcriptId_itemKey_storyId: {
				transcriptId: params.transcriptId,
				itemKey: params.itemKey,
				storyId: params.storyId,
			},
		},
		create: {
			transcriptId: params.transcriptId,
			projectId: params.projectId,
			itemKey: params.itemKey,
			itemTextSnapshot: params.itemTextSnapshot,
			storyId: params.storyId,
			origin: params.origin,
			status: "ACTIVE",
			createdById: params.createdById,
			userId: params.userId,
			organizationId: params.organizationId,
		},
		update: {
			status: "ACTIVE",
			origin: params.origin,
			// Refresh the snapshot: the item may have been reworded since the
			// dismissed row was written, and the back-reference should show what
			// the person is linking now.
			itemTextSnapshot: params.itemTextSnapshot,
			dismissedAt: null,
			dismissedById: null,
			createdById: params.createdById,
		},
		select: { id: true },
	});
}

/**
 * Tombstone one link. `projectId` in the WHERE is the scope guard — it makes a
 * link id from another project unmatchable rather than merely unauthorized, so
 * the check cannot be bypassed by a caller who knows a valid id.
 *
 * Returns false when nothing matched, so the caller can answer NOT_FOUND instead
 * of reporting a success that did nothing. Also false for an already-dismissed
 * link, which keeps the operation honest rather than idempotent-by-accident.
 */
export async function dismissActionItemLink(params: {
	linkId: string;
	projectId: string;
	dismissedById: string;
}): Promise<boolean> {
	const result = await db.meetingActionItemLink.updateMany({
		where: {
			id: params.linkId,
			projectId: params.projectId,
			status: "ACTIVE",
		},
		data: {
			status: "DISMISSED",
			dismissedAt: new Date(),
			dismissedById: params.dismissedById,
		},
	});
	return result.count > 0;
}

/** Back-references for one work item, newest meeting first (FR5/FR6). */
export async function listMeetingReferencesForStory(
	storyId: string,
): Promise<StoryMeetingReference[]> {
	const rows = await db.meetingActionItemLink.findMany({
		where: { storyId, status: "ACTIVE" },
		select: {
			id: true,
			itemKey: true,
			itemTextSnapshot: true,
			origin: true,
			projectId: true,
			transcript: {
				select: {
					transcriptId: true,
					meetingSubject: true,
					meetingDate: true,
					linkedMeeting: { select: { subject: true } },
				},
			},
		},
		orderBy: [
			{ transcript: { meetingDate: "desc" } },
			{ createdAt: "desc" },
		],
	});
	return rows.map((r) => ({
		linkId: r.id,
		itemKey: r.itemKey,
		itemText: r.itemTextSnapshot,
		origin: r.origin,
		// The linked-meeting subject is the series name and is the more stable
		// label; the per-instance subject is the fallback. Same precedence
		// getMeeting uses.
		meetingSubject:
			r.transcript.linkedMeeting?.subject ??
			r.transcript.meetingSubject ??
			null,
		meetingDate: r.transcript.meetingDate,
		transcriptRef: r.transcript.transcriptId,
		projectId: r.projectId,
	}));
}

/** Stamp a meeting as matched at the given link version. */
export async function markActionItemsLinked(params: {
	transcriptCuid: string;
	version: number;
}): Promise<void> {
	await db.projectMeetingTranscript.update({
		where: { id: params.transcriptCuid },
		data: {
			actionItemsLinkedAt: new Date(),
			actionItemsLinkVersion: params.version,
		},
	});
}
