import {
	emitNewsletterApprovalPendingNotification,
	holdNewsletterForApproval,
	type NewsletterContent,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";

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
	await holdNewsletterForApproval({
		sendId: input.sendId,
		content: input.content,
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
