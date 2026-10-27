import { db, tenantWhere } from "@repo/database";

/**
 * The earlier transcripts of one linked meeting series, newest first, with
 * their open action items. Shared by the pre-meeting agenda and Parlume's
 * "Since last time" recap, so both read a series' history the same way.
 *
 * Kept out of this directory's barrel: every export of the activities barrel
 * is registered as a Temporal activity, and this is a query, not one.
 */

/**
 * Transcripts of the series in the half-open window [`since`, `before`).
 *
 * The exclusive upper bound is what stops a meeting being fed its OWN
 * transcript as history: generateAgenda allows generation up to an hour after
 * the occurrence starts, by which point that transcript may already have
 * synced. Both bounds also exclude rows with a NULL meetingDate — which matters
 * more than it looks, because Postgres sorts NULLs FIRST on
 * `ORDER BY meetingDate DESC`, so without them three undated transcripts could
 * displace every real occurrence.
 *
 * UserStory and ProjectMeetingActionItem carry no userId/organizationId columns
 * of their own, so tenancy is applied under the `project` relation.
 */
export function findPriorSeriesTranscripts(input: {
	projectId: string;
	organizationId: string | null;
	userId: string;
	linkedMeetingId: string;
	since: Date;
	before: Date;
	take: number;
	/** Open action items kept per transcript; one more is read so a cut shows. */
	actionItemCap: number;
}) {
	return db.projectMeetingTranscript.findMany({
		where: {
			projectId: input.projectId,
			linkedMeetingId: input.linkedMeetingId,
			project: tenantWhere(input.userId, input.organizationId),
			meetingDate: { gte: input.since, lt: input.before },
		},
		orderBy: { meetingDate: "desc" },
		take: input.take,
		select: {
			id: true,
			meetingSubject: true,
			meetingDate: true,
			summary: true,
			extractedDecisions: true,
			extractedQuestions: true,
			// Old business. Nested rather than a separate query: the
			// index path is already there — @@index([linkedMeetingId]) on the
			// transcript, @@index([transcriptId]) on the item. Tenancy comes from
			// the parent's `project` filter.
			actionItems: {
				where: { completedAt: null },
				orderBy: { orderIndex: "asc" },
				// Bound the READ, not just the flattened result: one pathological
				// meeting must not pull thousands of rows.
				take: input.actionItemCap + 1,
				select: {
					id: true,
					text: true,
					tentativeOwnerName: true,
					dueHint: true,
				},
			},
		},
	});
}

/**
 * Meeting insight columns are Json, written by extract-meeting-insights against
 * meetingDecisionSchema / meetingOpenQuestionSchema. They predate any runtime
 * validation on read, so treat them as untrusted: a malformed blob must degrade
 * to an empty list, never abort the reader.
 */
export function readTextItems(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((item) =>
			item && typeof item === "object" && "text" in item
				? (item as { text?: unknown }).text
				: undefined,
		)
		.filter(
			(text): text is string =>
				typeof text === "string" && text.length > 0,
		);
}
