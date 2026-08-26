import {
	computeActionItemKey,
	db,
	isFeatureEnabled,
	upsertPersonLink,
} from "@repo/database";

/**
 * #1902 FR7 / AC9: when a work item is created from a meeting action item, link
 * the two at creation time.
 *
 * The action item is identified by `sourceMetadata.actionItemId`, which
 * `proposeActionItemTicket` writes on the per-item proposal (and uses for its
 * own dedupe). Meeting-level auto-analyze proposals carry no `actionItemId`, so
 * they return null here — they get transcript-level provenance
 * (`sourceMeetingTranscriptId`) instead, which is a different, coarser link.
 *
 * `origin: CREATED` rather than MANUAL: the user asked for a ticket, not for a
 * link, so the link is a consequence of their action rather than the action
 * itself. It matters at read time — the digest presents CREATED links as fact
 * ("this ticket came from here") and AUTO links as suggestions.
 */
export function readActionItemIdFromMetadata(
	sourceMetadata: unknown,
): string | null {
	const meta = (sourceMetadata ?? {}) as Record<string, unknown>;
	return typeof meta.actionItemId === "string" ? meta.actionItemId : null;
}

export async function linkStoryToSourceActionItem(params: {
	projectId: string;
	sourceMetadata: unknown;
	storyId: string;
	createdById: string;
}): Promise<{ linkId: string } | null> {
	const actionItemId = readActionItemIdFromMetadata(params.sourceMetadata);
	if (!actionItemId) {
		return null;
	}
	if (!(await isFeatureEnabled("MEETING_ACTION_ITEM_LINKING"))) {
		return null;
	}

	const item = await db.projectMeetingActionItem.findFirst({
		where: {
			id: actionItemId,
			transcript: { projectId: params.projectId },
		},
		select: {
			text: true,
			transcriptId: true,
			// Tenancy copied from the parent transcript — same rule as the manual
			// link procedure, so a link always shares its meeting's RLS scope.
			transcript: { select: { userId: true, organizationId: true } },
		},
	});
	if (!item) {
		return null;
	}

	const link = await upsertPersonLink({
		transcriptId: item.transcriptId,
		projectId: params.projectId,
		itemKey: computeActionItemKey(item.text),
		itemTextSnapshot: item.text,
		storyId: params.storyId,
		origin: "CREATED",
		createdById: params.createdById,
		userId: item.transcript.userId,
		organizationId: item.transcript.organizationId,
	});
	return { linkId: link.id };
}
