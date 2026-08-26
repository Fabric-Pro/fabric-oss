/**
 * Pure decision helper for the destination-aware newsletter delivery branch
 * (patched("newsletter-chat-delivery-2026-07-08")). Workflow-safe: no imports,
 * no I/O, no non-deterministic calls — a plain function of its inputs so it can
 * be unit-tested outside the Temporal sandbox and safely called from workflow
 * code without affecting replay determinism.
 */
export interface DeliveryOutcomeInput {
	wantEmail: boolean;
	wantChat: boolean;
	email: {
		attempted: boolean;
		errored: boolean;
		recipientCount: number;
		sentCount: number;
		failedCount: number;
	};
	chat: {
		attempted: boolean;
		errored: boolean;
		targetCount: number;
		sentCount: number;
		failedCount: number;
		skippedCount: number;
	};
}
export interface DeliveryOutcome {
	status: "SENT" | "PARTIAL" | "FAILED" | "SKIPPED_EMPTY";
	skipReason: "NO_SUBSCRIBERS" | "NO_CHAT_TARGETS" | null;
	advanceLastSentAt: boolean;
}

export function computeDeliveryOutcome(
	i: DeliveryOutcomeInput,
): DeliveryOutcome {
	const totalSent = i.email.sentCount + i.chat.sentCount;
	const totalFailed = i.email.failedCount + i.chat.failedCount;
	const totalTargets = i.email.recipientCount + i.chat.targetCount;
	const anyErrored = i.email.errored || i.chat.errored; // F1: a thrown activity is a failure

	if (totalTargets === 0 && !anyErrored) {
		const skipReason: DeliveryOutcome["skipReason"] =
			i.wantChat && !i.wantEmail ? "NO_CHAT_TARGETS" : "NO_SUBSCRIBERS";
		return {
			status: "SKIPPED_EMPTY",
			skipReason,
			advanceLastSentAt: false,
		};
	}

	const clean = totalFailed === 0 && !anyErrored;
	const status: DeliveryOutcome["status"] = clean
		? "SENT"
		: totalSent > 0
			? "PARTIAL"
			: "FAILED";
	return { status, skipReason: null, advanceLastSentAt: totalSent > 0 };
}
