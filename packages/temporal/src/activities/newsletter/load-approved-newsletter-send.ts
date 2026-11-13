import {
	coerceDeliveryDestination,
	coerceRemovedHighlightIndexes,
	getNewsletterSendForSendPhase,
	type NewsletterChatChannel,
	type NewsletterContent,
	type NewsletterDeliveryDestination,
	newsletterContentSchema,
} from "@repo/database";
import { orderNewsletterHighlights } from "@repo/utils/newsletter-highlight-order";
import { heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";

export interface ApprovedSendData {
	sendId: string;
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	projectName: string;
	/** The highlights that go out, already in the reviewer's order and without
	 *  the removed ones. */
	content: NewsletterContent;
	deliveryDestination: NewsletterDeliveryDestination;
	chatChannels: NewsletterChatChannel[];
	/** Always empty: removals are already applied to `content`. Kept for the
	 *  workflow's `applyRemovedHighlights` call, which a run recorded before
	 *  the activity applied them still needs (its history replays the old
	 *  result, with the indexes). */
	removedHighlightIndexes: number[];
	timeWindowEndIso: string;
}

/** Reads everything the approved send needs off the frozen row + project name.
 *  Fails (non-retryable) if the row is missing, not APPROVED, or has no content
 *  — those are logic errors the send phase can't recover from.
 *
 *  The reviewer's order and removals are applied here, through the shared
 *  `orderNewsletterHighlights`, rather than in the workflow: the result is
 *  recorded in history, so workflow code (replay-sensitive) does not change. */
export async function loadApprovedNewsletterSendActivity(input: {
	sendId: string;
	projectName: string;
}): Promise<ApprovedSendData> {
	heartbeat("loadApprovedNewsletterSend");
	const row = await getNewsletterSendForSendPhase(input.sendId);
	if (!row || row.status !== "APPROVED" || !row.content) {
		throw ApplicationFailure.nonRetryable(
			`Approved send ${input.sendId} not in a sendable state`,
			"InvalidApprovedSend",
		);
	}
	const content = newsletterContentSchema.parse(row.content);
	const highlights = orderNewsletterHighlights(
		content.highlights,
		coerceRemovedHighlightIndexes(row.removedHighlightIndexes),
		row.highlightOrder,
	);
	return {
		sendId: row.id,
		projectId: row.projectId,
		organizationId: row.organizationId,
		userId: row.userId,
		projectName: input.projectName,
		content: {
			...content,
			highlights,
			hasMajorFeatures: content.hasMajorFeatures && highlights.length > 0,
		},
		deliveryDestination: coerceDeliveryDestination(row.deliveryDestination),
		chatChannels: (row.chatChannels ?? []) as NewsletterChatChannel[],
		removedHighlightIndexes: [],
		timeWindowEndIso: row.timeWindowEnd.toISOString(),
	};
}
