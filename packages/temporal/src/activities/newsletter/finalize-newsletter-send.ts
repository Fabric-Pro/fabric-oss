import {
	advanceNewsletterLastSentAt,
	finalizeNewsletterSend,
	type NewsletterContent,
	type NewsletterSendStatus,
	type NewsletterSkipReason,
} from "@repo/database";
import { heartbeat } from "@temporalio/activity";

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
		content: input.content ?? undefined,
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
}
