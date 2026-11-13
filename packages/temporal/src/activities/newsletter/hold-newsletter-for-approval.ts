import {
	emitNewsletterApprovalPendingNotification,
	getNewsletterSendProjectId,
	holdNewsletterForApproval,
	type NewsletterContent,
	withoutCaptureHints,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { reconcileOrganizationSubscribers } from "./reconcile-organization-subscribers";

export interface HoldNewsletterForApprovalInput {
	sendId: string;
	content: NewsletterContent;
	aiUsageTokens: number | null;
}

/** Park a curated send at PENDING_APPROVAL and notify reviewers. The park itself
 *  is durable; the notification is best-effort (a failure must not fail the
 *  activity — the draft is still visible in the review UI). */
export async function holdNewsletterForApprovalActivity(
	input: HoldNewsletterForApprovalInput,
): Promise<void> {
	heartbeat("holdNewsletterForApproval");
	// Reviewers approve a recipient list, so it has to be current before they
	// see it. Read from the send rather than passed in: the activity's input is
	// part of recorded histories.
	const projectId = await getNewsletterSendProjectId(input.sendId);
	if (projectId) {
		await reconcileOrganizationSubscribers(projectId);
	}
	await holdNewsletterForApproval({
		sendId: input.sendId,
		// The capture hints served the capture rows, which keep the brief.
		content: withoutCaptureHints(input.content),
		aiUsageTokens: input.aiUsageTokens,
	});
	try {
		await emitNewsletterApprovalPendingNotification({
			sendId: input.sendId,
		});
	} catch (e) {
		logger.warn("[Newsletter] approval-pending notification failed", {
			sendId: input.sendId,
			error: e instanceof Error ? e.message : String(e),
		});
	}
}
