import {
	coerceDeliveryDestination,
	coerceRemovedHighlightIndexes,
	getNewsletterSendForSendPhase,
	type NewsletterChatChannel,
	type NewsletterContent,
	type NewsletterDeliveryDestination,
	newsletterContentSchema,
} from "@repo/database";
import { heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";

export interface ApprovedSendData {
	sendId: string;
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	projectName: string;
	content: NewsletterContent;
	deliveryDestination: NewsletterDeliveryDestination;
	chatChannels: NewsletterChatChannel[];
	removedHighlightIndexes: number[];
	timeWindowEndIso: string;
}

/** Reads everything the approved send needs off the frozen row + project name.
 *  Fails (non-retryable) if the row is missing, not APPROVED, or has no content
 *  — those are logic errors the send phase can't recover from. */
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
	return {
		sendId: row.id,
		projectId: row.projectId,
		organizationId: row.organizationId,
		userId: row.userId,
		projectName: input.projectName,
		content,
		deliveryDestination: coerceDeliveryDestination(row.deliveryDestination),
		chatChannels: (row.chatChannels ?? []) as NewsletterChatChannel[],
		removedHighlightIndexes: coerceRemovedHighlightIndexes(
			row.removedHighlightIndexes,
		),
		timeWindowEndIso: row.timeWindowEnd.toISOString(),
	};
}
