import type {
	NewsletterContent,
	NewsletterDeliveryDestination,
} from "@repo/database";
import { ApplicationFailure, log, proxyActivities } from "@temporalio/workflow";
import type {
	finalizeNewsletterSendActivity as FinalizeFn,
	loadApprovedNewsletterSendActivity as LoadApprovedFn,
	loadActiveSubscribersActivity as LoadSubsFn,
	sendNewsletterChatMessagesActivity as SendChatFn,
	sendNewsletterEmailsActivity as SendEmailsFn,
} from "../activities/newsletter";
import { computeDeliveryOutcome } from "./newsletter-delivery-outcome";
import { applyRemovedHighlights } from "./newsletter-highlight-filter";

export interface SendApprovedNewsletterInput {
	sendId: string;
	projectId: string; // for the outer-catch FAILED finalize when the load step throws
	projectName: string;
}
export interface SendApprovedNewsletterOutput {
	status: "SENT" | "PARTIAL" | "FAILED" | "SKIPPED_EMPTY";
	sentCount: number;
}

const { loadApprovedNewsletterSendActivity } = proxyActivities<{
	loadApprovedNewsletterSendActivity: typeof LoadApprovedFn;
}>({
	startToCloseTimeout: "30 seconds",
	retry: { maximumAttempts: 5, initialInterval: "1s" },
});
const { loadActiveSubscribersActivity, finalizeNewsletterSendActivity } =
	proxyActivities<{
		loadActiveSubscribersActivity: typeof LoadSubsFn;
		finalizeNewsletterSendActivity: typeof FinalizeFn;
	}>({
		startToCloseTimeout: "30 seconds",
		heartbeatTimeout: "15 seconds",
		retry: { maximumAttempts: 5, initialInterval: "1s" },
	});
const { sendNewsletterEmailsActivity } = proxyActivities<{
	sendNewsletterEmailsActivity: typeof SendEmailsFn;
}>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "1 minute",
	retry: { maximumAttempts: 3, initialInterval: "5s" },
});
const { sendNewsletterChatMessagesActivity } = proxyActivities<{
	sendNewsletterChatMessagesActivity: typeof SendChatFn;
}>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "1 minute",
	retry: { maximumAttempts: 3, initialInterval: "5s" },
});

export async function sendApprovedNewsletterWorkflow(
	input: SendApprovedNewsletterInput,
): Promise<SendApprovedNewsletterOutput> {
	// Outer catch mirrors generate-and-send-newsletter.ts:409-427 — ANY uncaught
	// error (load, subscriber load, schema parse, finalize) must move the row off
	// APPROVED, or it wedges the active-send slot forever behind a "Sending…" UI
	// (Codex final-review finding). Guarded on APPROVED so it never clobbers a
	// row a concurrent supersede already terminalized; never advances lastSentAt.
	try {
		const data = await loadApprovedNewsletterSendActivity(input);
		const content: NewsletterContent = applyRemovedHighlights(
			data.content,
			data.removedHighlightIndexes,
		);

		// FR4: reviewer removed everything → no user-visible changes, no mail.
		if (!content.hasMajorFeatures) {
			await finalizeNewsletterSendActivity({
				sendId: data.sendId,
				projectId: data.projectId,
				status: "SKIPPED_EMPTY",
				skipReason: "NO_MAJOR_FEATURES",
				content,
				aiUsageTokens: null,
				expectStatus: "APPROVED",
			});
			return { status: "SKIPPED_EMPTY", sentCount: 0 };
		}

		// Mirror the generate workflow's delivery block EXACTLY (generate-and-send-
		// newsletter.ts:263-362): build mutable email/chat outcome objects with
		// per-channel try/catch, then computeDeliveryOutcome. The only differences
		// are the frozen-row source and the expectStatus:"APPROVED" guard on finalize.
		const destination: NewsletterDeliveryDestination =
			data.deliveryDestination;
		const wantEmail = destination !== "CHAT";
		const wantChat = destination === "CHAT" || destination === "BOTH";

		const email = {
			attempted: false,
			errored: false,
			recipientCount: 0,
			sentCount: 0,
			failedCount: 0,
		};
		if (wantEmail) {
			// loadActiveSubscribersActivity input is { projectId } ONLY; returns
			// { subscribers }.
			const { subscribers } = await loadActiveSubscribersActivity({
				projectId: data.projectId,
			});
			if (subscribers.length > 0) {
				email.attempted = true;
				email.recipientCount = subscribers.length;
				try {
					const r = await sendNewsletterEmailsActivity({
						sendId: data.sendId,
						projectId: data.projectId,
						organizationId: data.organizationId,
						userId: data.userId,
						projectName: data.projectName,
						content,
						subscribers,
					});
					email.sentCount = r.sentCount;
					email.failedCount = r.failedCount;
				} catch (e) {
					email.errored = true;
					email.failedCount = subscribers.length;
					log.error("[Newsletter] approved email delivery failed", {
						sendId: data.sendId,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}
		}

		const chat = {
			attempted: false,
			errored: false,
			targetCount: 0,
			sentCount: 0,
			failedCount: 0,
			skippedCount: 0,
		};
		if (wantChat) {
			chat.attempted = true;
			try {
				const r = await sendNewsletterChatMessagesActivity({
					sendId: data.sendId,
					projectId: data.projectId,
					organizationId: data.organizationId,
					userId: data.userId,
					projectName: data.projectName,
					content,
					chatChannels: data.chatChannels,
				});
				chat.targetCount = r.targetCount;
				chat.sentCount = r.sentCount;
				chat.failedCount = r.failedCount;
				chat.skippedCount = r.skippedCount;
			} catch (e) {
				chat.errored = true;
				log.error("[Newsletter] approved chat delivery failed", {
					sendId: data.sendId,
					error: e instanceof Error ? e.message : String(e),
				});
			}
		}

		const outcome = computeDeliveryOutcome({
			wantEmail,
			wantChat,
			email,
			chat,
		});
		await finalizeNewsletterSendActivity({
			sendId: data.sendId,
			projectId: data.projectId,
			status: outcome.status,
			skipReason: outcome.skipReason,
			recipientCount: email.recipientCount + chat.targetCount,
			sentCount: email.sentCount + chat.sentCount,
			failedCount: email.failedCount + chat.failedCount,
			content,
			aiUsageTokens: null,
			expectStatus: "APPROVED", // guarded: no-op if the row was superseded
			advanceLastSentAt: outcome.advanceLastSentAt,
			lastSentAtIso: data.timeWindowEndIso,
		});
		log.info("[Newsletter] approved send finalized", {
			sendId: data.sendId,
			status: outcome.status,
		});
		return {
			status: outcome.status,
			sentCount: email.sentCount + chat.sentCount,
		};
	} catch (error) {
		// Uncaught send-phase failure. Move the row OFF APPROVED so it can't wedge
		// the active-send slot. Guarded on APPROVED (a concurrent supersede may have
		// already terminalized it); never advances lastSentAt. Then rethrow so
		// Temporal records the failure (mirrors the generate workflow).
		const errMsg = error instanceof Error ? error.message : String(error);
		log.error("[Newsletter] approved send failed", {
			sendId: input.sendId,
			error: errMsg,
		});
		try {
			await finalizeNewsletterSendActivity({
				sendId: input.sendId,
				projectId: input.projectId,
				status: "FAILED",
				errorMessage: errMsg,
				expectStatus: "APPROVED",
			});
		} catch {}
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		throw ApplicationFailure.nonRetryable(
			errMsg,
			"NEWSLETTER_APPROVED_SEND_FAILED",
		);
	}
}
