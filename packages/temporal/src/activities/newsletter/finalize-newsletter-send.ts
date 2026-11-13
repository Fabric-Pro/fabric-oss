import {
	advanceNewsletterLastSentAt,
	finalizeNewsletterSend,
	type NewsletterContent,
	type NewsletterSendStatus,
	type NewsletterSkipReason,
	withoutCaptureHints,
} from "@repo/database";
import { heartbeat } from "@temporalio/activity";
import {
	clearNewsletterSendFolder,
	discardExpiredReviewImages,
} from "./discard-expired-review-images";

export interface FinalizeNewsletterSendInput {
	sendId: string;
	projectId: string;
	status: "SENT" | "PARTIAL" | "FAILED" | "SKIPPED_EMPTY";
	skipReason?: NewsletterSkipReason | null;
	recipientCount?: number;
	sentCount?: number;
	failedCount?: number;
	content?: NewsletterContent | null;
	aiUsageTokens?: number | null;
	errorMessage?: string | null;
	advanceLastSentAt?: boolean;
	lastSentAtIso?: string;
	// Guarded finalize (Fizzy 1869): when set, the DB update is conditional on
	// the row still being in this status. Omitted ⇒ unconditional legacy update
	// (existing generate-phase / manual FAILED callers), unchanged behaviour.
	expectStatus?: NewsletterSendStatus;
}

export async function finalizeNewsletterSendActivity(
	input: FinalizeNewsletterSendInput,
): Promise<void> {
	heartbeat("finalizeNewsletterSend");
	const { finalized } = await finalizeNewsletterSend({
		sendId: input.sendId,
		status: input.status,
		skipReason: input.skipReason ?? null,
		recipientCount: input.recipientCount,
		sentCount: input.sentCount,
		failedCount: input.failedCount,
		// The capture hints served the review; the archive and the embed read
		// this row, so they never carry them.
		content: input.content ? withoutCaptureHints(input.content) : undefined,
		aiUsageTokens: input.aiUsageTokens,
		errorMessage: input.errorMessage,
		expectStatus: input.expectStatus,
	});
	// Only advance the cadence cursor if THIS finalize actually updated the row.
	// A guarded finalize (expectStatus) that matched 0 rows must not advance
	// lastSentAt. Non-guarded callers get finalized:true unconditionally, so their
	// behaviour is unchanged.
	if (finalized && input.advanceLastSentAt && input.lastSentAtIso) {
		await advanceNewsletterLastSentAt(
			input.projectId,
			new Date(input.lastSentAtIso),
		);
	}
	// A send that failed or was skipped never goes out, so neither do the
	// screenshots captured for it. Best-effort; never fails the finalize.
	if (
		finalized &&
		(input.status === "FAILED" || input.status === "SKIPPED_EMPTY")
	) {
		await discardExpiredReviewImages(input.projectId, input.sendId);
	}
	// A delivered send's review folder is read by nothing: the email points at
	// the public copies, and the rows keep their public keys for a takedown.
	if (finalized && (input.status === "SENT" || input.status === "PARTIAL")) {
		await clearNewsletterSendFolder(input.projectId, input.sendId);
	}
}
