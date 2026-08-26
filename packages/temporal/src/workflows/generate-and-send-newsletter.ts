import type {
	NewsletterChatChannel,
	NewsletterContent,
	NewsletterDeliveryDestination,
	NewsletterDetailLevel,
	NewsletterSkipReason,
} from "@repo/database";
import {
	ApplicationFailure,
	log,
	patched,
	proxyActivities,
} from "@temporalio/workflow";
import type {
	collectGitHubPullRequestsActivity as CollectPrsFn,
	collectGitHubReleasesActivity as CollectReleasesFn,
} from "../activities/daily-brief";
import type {
	curateStakeholderReleaseNotesActivity as CurateFn,
	curateNewsletterFromReleasesActivity as CurateReleasesFn,
	finalizeNewsletterSendActivity as FinalizeFn,
	holdNewsletterForApprovalActivity as HoldFn,
	loadActiveSubscribersActivity as LoadSubsFn,
	sendNewsletterApprovalChatMessagesActivity as SendApprovalChatFn,
	sendNewsletterApprovalEmailsActivity as SendApprovalEmailsFn,
	sendNewsletterChatMessagesActivity as SendChatFn,
	sendNewsletterEmailsActivity as SendEmailsFn,
} from "../activities/newsletter";
import { APPROVAL_CHAT_RETRY } from "./newsletter-approval-chat-retry";
import { APPROVAL_EMAIL_RETRY } from "./newsletter-approval-email-retry";
import { computeDeliveryOutcome } from "./newsletter-delivery-outcome";
import { selectNewsletterReleases } from "./newsletter-release-select";
import { splitReleasePrs } from "./newsletter-release-split";

export interface GenerateAndSendNewsletterInput {
	sendId: string;
	projectId: string;
	organizationId: string | null;
	userId: string | null; // tenant userId (null in org context)
	triggeredByUserId: string; // AI attribution + audit
	projectName: string;
	trigger: "MANUAL" | "SCHEDULED";
	detailLevel: NewsletterDetailLevel;
	// Optional: populated at send creation (Task 8). Undefined (un-threaded /
	// legacy history) safely falls back to email-only delivery.
	deliveryDestination?: NewsletterDeliveryDestination;
	chatChannels?: NewsletterChatChannel[];
	// Optional: frozen onto the send row at creation (Fizzy 1869 approval gate).
	// Undefined (un-threaded / legacy history) safely falls back to straight-to-
	// delivery — the park branch below is additionally gated by patched().
	requireApproval?: boolean;
	timeWindowStart: string; // ISO
	timeWindowEnd: string; // ISO
}
export interface GenerateAndSendNewsletterOutput {
	status:
		| "SENT"
		| "PARTIAL"
		| "FAILED"
		| "SKIPPED_EMPTY"
		| "PENDING_APPROVAL";
	sentCount: number;
}

const PROGRAMMING_ERROR_TYPES = [
	"TypeError",
	"ReferenceError",
	"SyntaxError",
] as const;

const { collectGitHubPullRequestsActivity } = proxyActivities<{
	collectGitHubPullRequestsActivity: typeof CollectPrsFn;
}>({
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "1 minute",
	retry: {
		maximumAttempts: 2,
		initialInterval: "3s",
		nonRetryableErrorTypes: [...PROGRAMMING_ERROR_TYPES],
	},
});

const { curateStakeholderReleaseNotesActivity } = proxyActivities<{
	curateStakeholderReleaseNotesActivity: typeof CurateFn;
}>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "1 minute",
	retry: {
		maximumAttempts: 2,
		initialInterval: "5s",
		nonRetryableErrorTypes: [...PROGRAMMING_ERROR_TYPES],
	},
});

// Release-based source (patched() branch). Dedicated proxies so the legacy PR
// proxies above stay untouched. The activities heartbeat at a 30s cadence, which
// stays below these 1-minute heartbeatTimeouts.
const { collectGitHubReleasesActivity } = proxyActivities<{
	collectGitHubReleasesActivity: typeof CollectReleasesFn;
}>({
	startToCloseTimeout: "3 minutes",
	heartbeatTimeout: "1 minute",
	retry: {
		maximumAttempts: 2,
		initialInterval: "3s",
		nonRetryableErrorTypes: [...PROGRAMMING_ERROR_TYPES],
	},
});

const { curateNewsletterFromReleasesActivity } = proxyActivities<{
	curateNewsletterFromReleasesActivity: typeof CurateReleasesFn;
}>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "1 minute",
	retry: {
		maximumAttempts: 2,
		initialInterval: "5s",
		nonRetryableErrorTypes: [...PROGRAMMING_ERROR_TYPES],
	},
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

const { holdNewsletterForApprovalActivity } = proxyActivities<{
	holdNewsletterForApprovalActivity: typeof HoldFn;
}>({
	startToCloseTimeout: "30 seconds",
	heartbeatTimeout: "15 seconds",
	retry: { maximumAttempts: 5, initialInterval: "1s" },
});

// The reviewer email fans out over project administrators, which does not fit
// the hold's 30-second budget, so it gets its own proxy. Its failure is caught
// at the call site — see the note there. The retry policy lives in its own
// module because it has to outlast the Resend breaker's half-open window; that
// module explains why, and a test asserts it against the breaker's own constant.
const { sendNewsletterApprovalEmailsActivity } = proxyActivities<{
	sendNewsletterApprovalEmailsActivity: typeof SendApprovalEmailsFn;
}>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "1 minute",
	retry: APPROVAL_EMAIL_RETRY,
});

// The review-alert chat post (Fizzy #2203) fans out over a project's linked
// Teams/Slack channels, same shape as the reviewer email above. Its failure is
// caught at the call site — see the note there. The retry policy lives in its
// own module because it is sized to ride out a rolling worker deployment, not
// a provider breaker's window; that module explains why.
const { sendNewsletterApprovalChatMessagesActivity } = proxyActivities<{
	sendNewsletterApprovalChatMessagesActivity: typeof SendApprovalChatFn;
}>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "1 minute",
	retry: APPROVAL_CHAT_RETRY,
});

const { sendNewsletterEmailsActivity } = proxyActivities<{
	sendNewsletterEmailsActivity: typeof SendEmailsFn;
}>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "1 minute",
	retry: {
		maximumAttempts: 3,
		initialInterval: "5s",
		nonRetryableErrorTypes: [...PROGRAMMING_ERROR_TYPES],
	},
});

const { sendNewsletterChatMessagesActivity } = proxyActivities<{
	sendNewsletterChatMessagesActivity: typeof SendChatFn;
}>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "1 minute",
	retry: {
		maximumAttempts: 3,
		initialInterval: "5s",
		nonRetryableErrorTypes: [...PROGRAMMING_ERROR_TYPES],
	},
});

export async function generateAndSendNewsletterWorkflow(
	input: GenerateAndSendNewsletterInput,
): Promise<GenerateAndSendNewsletterOutput> {
	const {
		sendId,
		projectId,
		organizationId,
		userId,
		triggeredByUserId,
		projectName,
		timeWindowStart,
		timeWindowEnd,
		detailLevel,
		deliveryDestination,
		chatChannels,
		requireApproval,
	} = input;

	try {
		let content: NewsletterContent;
		let aiUsageTokens: number | null;
		// Reason recorded if the run ends with nothing to mail. Each branch refines it.
		let noContentReason: NewsletterSkipReason = "NO_MAJOR_FEATURES";

		if (patched("newsletter-release-based-collection-2026-06-15")) {
			// NEW: published-release source. New activity TYPES → only ever scheduled
			// under patched()===true, so the else branch's recorded command sequence
			// is provably untouched for pre-patch histories.
			const collected = await collectGitHubReleasesActivity({
				projectId,
				organizationId,
				userId: triggeredByUserId,
				timeWindowStart: new Date(timeWindowStart),
				timeWindowEnd: new Date(timeWindowEnd),
			});
			const sel = selectNewsletterReleases(
				{ items: collected.items, failures: collected.failures },
				timeWindowStart,
			);
			if (sel.incomplete) {
				// Incomplete scan: do NOT email a partial set and do NOT advance the
				// cursor — the full window is retried next send. Emailing a
				// partial set + withholding the cursor would re-query the same window
				// and duplicate-announce.
				await finalizeNewsletterSendActivity({
					sendId,
					projectId,
					status: "SKIPPED_EMPTY",
					skipReason: "INCOMPLETE_SCAN",
					aiUsageTokens: null,
				});
				return { status: "SKIPPED_EMPTY", sentCount: 0 };
			}
			// Distinguish "no active repos" (reconnect) from "no in-window releases".
			// STRICT === 0: a MISSING activeRepoCount (pre-change collector result on
			// replay/version-skew, or the tenant-mismatch early return which never emits
			// it) must fall through to the neutral NO_RELEASES, never a false
			// NO_ACTIVE_REPOS that wrongly tells users to reconnect. (Codex findings 1 & 2.)
			if (sel.releases.length === 0) {
				noContentReason =
					collected.activeRepoCount === 0
						? "NO_ACTIVE_REPOS"
						: "NO_RELEASES";
			}
			({ content, aiUsageTokens } =
				await curateNewsletterFromReleasesActivity({
					projectId,
					organizationId,
					userId: triggeredByUserId,
					projectName,
					releases: sel.releases, // [] → curate returns hasMajorFeatures=false → SKIPPED_EMPTY below
					detailLevel,
				}));
		} else {
			// LEGACY PR-based branch — preserved VERBATIM for replay of pre-patch
			// histories (same activity NAMES, COUNT, ORDER). Do NOT edit.
			const collected = await collectGitHubPullRequestsActivity({
				projectId,
				organizationId,
				userId: triggeredByUserId,
				timeWindowStart: new Date(timeWindowStart),
				timeWindowEnd: new Date(timeWindowEnd),
			});

			// External release notes = PRODUCTION merges only (adversarial-review #1).
			// PRs targeting `production` are usually `main → production` wrapper merges;
			// the shipped features are the staging PRs merged at/before the latest prod
			// merge, which `splitReleasePrs` reconstructs as `prodPrs`. We deliberately
			// DROP `stagingPrs`: a project with a `production` branch but no prod merge
			// this window has only unreleased staging/main work — emailing that to
			// EXTERNAL stakeholders would leak unshipped features. When `prodPrs` is
			// empty the curate activity returns hasMajorFeatures=false → SKIPPED_EMPTY,
			// so we never send. (Projects that deploy from main with no `production`
			// branch simply won't produce a newsletter; a future per-project "treat
			// main as production" setting can extend this — out of scope.)
			const merged = collected.items.filter(
				(i) => i.kind === "pr_merged",
			);
			const { prodPrs } = splitReleasePrs(merged);

			({ content, aiUsageTokens } =
				await curateStakeholderReleaseNotesActivity({
					projectId,
					organizationId,
					userId: triggeredByUserId,
					projectName,
					prodPrs,
				}));
		}

		if (!content.hasMajorFeatures) {
			await finalizeNewsletterSendActivity({
				sendId,
				projectId,
				status: "SKIPPED_EMPTY",
				skipReason: noContentReason,
				content,
				aiUsageTokens,
			});
			return { status: "SKIPPED_EMPTY", sentCount: 0 };
		}

		// Approval gate (Fizzy 1869): hold the curated content for reviewer
		// sign-off instead of sending. Behind its own patched() gate so pre-patch
		// histories replay the unchanged straight-to-delivery sequence.
		if (patched("newsletter-approval-gate-2026-07-09") && requireApproval) {
			await holdNewsletterForApprovalActivity({
				sendId,
				content,
				aiUsageTokens,
			});
			// Reviewer email (Fizzy #2172), behind its own patch so pre-patch
			// histories replay the hold-only sequence unchanged.
			//
			// The catch is load-bearing, not defensive habit: the outer catch
			// below finalizes the send as FAILED without expectStatus, which
			// overwrites PENDING_APPROVAL. Letting a mail failure reach it
			// would trade a reviewable draft for a dead one over a missing API
			// key. The in-app notification and the pending-review list are
			// unaffected either way, so the reviewer keeps a working channel.
			if (patched("newsletter-approval-email-2026-08-10")) {
				try {
					await sendNewsletterApprovalEmailsActivity({ sendId });
				} catch (e) {
					log.error("[Newsletter] reviewer email failed", {
						sendId,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}
			// Review-alert chat delivery (Fizzy #2203), behind its own patch so
			// pre-patch histories replay the hold-plus-email sequence unchanged.
			//
			// The catch is load-bearing for the same reason the email's is: the
			// outer catch below finalizes the send FAILED without expectStatus,
			// which overwrites PENDING_APPROVAL. A Slack outage must not cost the
			// reviewer their draft. The bell and the email have already landed.
			if (patched("newsletter-approval-chat-2026-08-20")) {
				try {
					await sendNewsletterApprovalChatMessagesActivity({
						sendId,
					});
				} catch (e) {
					log.error("[Newsletter] reviewer chat alert failed", {
						sendId,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}
			// Held for reviewer sign-off — not "skipped empty". The row is
			// PENDING_APPROVAL; report that so callers/telemetry aren't misled
			// (result is not persisted; row status is authoritative). Copilot PR review.
			return { status: "PENDING_APPROVAL", sentCount: 0 };
		}

		if (patched("newsletter-chat-delivery-2026-07-08")) {
			// NEW: destination-aware delivery (email / chat / both). undefined
			// (un-threaded / legacy) falls back to email-only.
			const wantEmail = deliveryDestination !== "CHAT";
			const wantChat =
				deliveryDestination === "CHAT" ||
				deliveryDestination === "BOTH";

			const email = {
				attempted: false,
				errored: false,
				recipientCount: 0,
				sentCount: 0,
				failedCount: 0,
			};
			if (wantEmail) {
				const { subscribers } = await loadActiveSubscribersActivity({
					projectId,
				});
				if (subscribers.length > 0) {
					email.attempted = true;
					email.recipientCount = subscribers.length;
					try {
						const r = await sendNewsletterEmailsActivity({
							sendId,
							projectId,
							organizationId,
							userId,
							projectName,
							content,
							subscribers,
						});
						email.sentCount = r.sentCount;
						email.failedCount = r.failedCount;
					} catch (e) {
						email.errored = true;
						email.failedCount = subscribers.length; // F1: a thrown activity is a failure
						log.error("[Newsletter] email delivery failed", {
							sendId,
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
						sendId,
						projectId,
						organizationId,
						userId,
						projectName,
						content,
						chatChannels: chatChannels ?? [],
					});
					chat.targetCount = r.targetCount;
					chat.sentCount = r.sentCount;
					chat.failedCount = r.failedCount;
					chat.skippedCount = r.skippedCount;
				} catch (e) {
					chat.errored = true;
					log.error("[Newsletter] chat delivery failed", {
						sendId,
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
				sendId,
				projectId,
				status: outcome.status,
				skipReason: outcome.skipReason,
				recipientCount: email.recipientCount + chat.targetCount,
				sentCount: email.sentCount + chat.sentCount,
				failedCount: email.failedCount + chat.failedCount,
				content,
				aiUsageTokens,
				advanceLastSentAt: outcome.advanceLastSentAt,
				lastSentAtIso: timeWindowEnd,
			});
			return {
				status: outcome.status,
				sentCount: email.sentCount + chat.sentCount,
			};
		}
		// LEGACY email-only delivery — preserved VERBATIM for replay of
		// pre-patch histories (same activity NAMES, COUNT, ORDER). Do NOT edit.
		const { subscribers } = await loadActiveSubscribersActivity({
			projectId,
		});
		if (subscribers.length === 0) {
			await finalizeNewsletterSendActivity({
				sendId,
				projectId,
				status: "SKIPPED_EMPTY",
				skipReason: "NO_SUBSCRIBERS",
				content,
				aiUsageTokens,
			});
			return { status: "SKIPPED_EMPTY", sentCount: 0 };
		}

		const { sentCount, failedCount } = await sendNewsletterEmailsActivity({
			sendId,
			projectId,
			organizationId,
			userId,
			projectName,
			content,
			subscribers,
		});

		const status: GenerateAndSendNewsletterOutput["status"] =
			failedCount === 0 ? "SENT" : sentCount > 0 ? "PARTIAL" : "FAILED";

		await finalizeNewsletterSendActivity({
			sendId,
			projectId,
			status,
			recipientCount: subscribers.length,
			sentCount,
			failedCount,
			content,
			aiUsageTokens,
			advanceLastSentAt: sentCount > 0,
			lastSentAtIso: timeWindowEnd,
		});

		return { status, sentCount };
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		log.error("[Newsletter] generation failed", { sendId, error: errMsg });
		try {
			await finalizeNewsletterSendActivity({
				sendId,
				projectId,
				status: "FAILED",
				errorMessage: errMsg,
			});
		} catch {}
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		throw ApplicationFailure.nonRetryable(
			errMsg,
			"NEWSLETTER_GENERATION_FAILED",
		);
	}
}
