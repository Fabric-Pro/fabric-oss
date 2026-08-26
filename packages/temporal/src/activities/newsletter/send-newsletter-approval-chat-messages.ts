import {
	buildReleaseNotesUrl,
	getNewsletterSendForSendPhase,
	getNewsletterSendStatus,
	getNewsletterSettings,
	isFeatureEnabled,
	isProjectReadOnly,
	newsletterApprovalChatChannelSchema,
	newsletterContentSchema,
	resolveNewsletterReviewRecipients,
} from "@repo/database";
import { logger } from "@repo/logs";
import { renderNewsletterApprovalChatMessage } from "@repo/utils";
import { heartbeat } from "@temporalio/activity";
import { deliverChatMessages } from "./chat-delivery-engine";

export interface SendNewsletterApprovalChatMessagesInput {
	sendId: string;
}

/**
 * Post the "release notes await review" alert to a project's configured chat
 * channels (Fizzy #2203) — the third alert channel beside the in-app bell and
 * the reviewer email.
 *
 * Four gates run before anything is claimed, cheapest first: the master flag,
 * the send's status, the project's read-only mode, and an empty channel list.
 * The master flag is no longer a free env read — it resolves through the
 * DB-backed registry — but one cached lookup is still cheaper than the three
 * queries behind it, so it stays first.
 * Each returns without writing a ledger row, so "feature off" and "nothing
 * configured" leave no trace to interpret later. A fifth guard — an
 * organization with no slug — runs right after those, also before any claim.
 */
export async function sendNewsletterApprovalChatMessagesActivity(
	input: SendNewsletterApprovalChatMessagesInput,
): Promise<void> {
	heartbeat("sendNewsletterApprovalChatMessages");

	if (!(await isFeatureEnabled("NEWSLETTER_APPROVAL_CHAT"))) {
		return;
	}

	// Shared with the reviewer email (Fizzy #2172): returns null when the send
	// is gone or has moved past PENDING_APPROVAL, which doubles as this
	// activity's status gate. Also carries projectName and organizationSlug,
	// which only this and the email channel need — the in-app bell's link is
	// context-relative and never interpolates a slug.
	const context = await resolveNewsletterReviewRecipients(input.sendId);
	if (!context) {
		return;
	}

	if (await isProjectReadOnly(context.projectId)) {
		return;
	}

	const settings = await getNewsletterSettings(context.projectId);
	const rawChannels = settings.approvalChatChannels ?? [];
	const channels = newsletterApprovalChatChannelSchema
		.array()
		.catch([])
		.parse(rawChannels);
	// `.catch([])` sits on the ARRAY, not the element, so ONE malformed entry
	// discards the WHOLE list and the guard below returns as "nothing
	// configured". That all-or-nothing fail-safe is deliberate — posting a
	// half-understood selection is worse than posting nothing — but without this
	// line a corrupt configuration is indistinguishable from an absent one, and
	// an admin who ticked channels gets silence with nothing to look at.
	const rawWasEmpty = Array.isArray(rawChannels) && rawChannels.length === 0;
	if (channels.length === 0 && !rawWasEmpty) {
		logger.warn(
			"[Newsletter] reviewer chat alert skipped: approvalChatChannels failed validation and was treated as empty",
			{
				sendId: input.sendId,
				projectId: context.projectId,
				configuredCount: Array.isArray(rawChannels)
					? rawChannels.length
					: null,
			},
		);
	}
	if (channels.length === 0) {
		return;
	}

	// Organization.slug is nullable and the workspace route is /app/{slug}/…, so
	// without it no correct link exists: interpolating null sends a reviewer to
	// /app/null/…, and buildReleaseNotesUrl's personal-path fallback is worse — a
	// URL in the wrong tenant context. Post nothing rather than summon someone to
	// a route that cannot load. Verbatim the guard sendNewsletterApprovalEmails
	// applies, and placed BEFORE any claim so no
	// ledger row is written for an alert that was never attempted.
	if (context.organizationId && !context.organizationSlug) {
		logger.warn(
			"[Newsletter] reviewer chat alert skipped: organization has no slug",
			{ sendId: input.sendId, projectId: context.projectId },
		);
		return;
	}

	// Frozen send row, reusing the same send-phase query the approved-send path
	// uses, for the two fields resolveNewsletterReviewRecipients does not carry:
	// the send's actor (deliverChatMessages needs it for the ledger's tenant
	// columns) and the curated content (to count highlights). Nothing has been
	// removed from it yet at this point — removal happens at approve time — so
	// every curated highlight counts.
	const send = await getNewsletterSendForSendPhase(input.sendId);
	if (!send) {
		return; // raced away between the two reads above
	}
	const content = newsletterContentSchema.parse(send.content);
	const highlightCount = content.highlights.length;

	const link = await buildReleaseNotesUrl({
		projectId: context.projectId,
		organizationId: context.organizationId,
	});

	const outcome = await deliverChatMessages({
		sendId: input.sendId,
		projectId: context.projectId,
		organizationId: context.organizationId,
		userId: send.userId,
		kind: "APPROVAL",
		channels,
		renderText: (platform) =>
			renderNewsletterApprovalChatMessage({
				projectName: context.projectName,
				highlightCount,
				link,
				platform,
			}),
		// Re-read per target: the review can conclude while this fan-out is in
		// flight, and a "needs review" ping arriving after the decision is noise
		// at best. The engine records a terminal SKIPPED row for each target this
		// stops, so cancellation stays distinguishable from a failed send.
		//
		// Deliberately the NARROW status query, not the send-phase one used
		// above: this runs once per target and the targets fan out concurrently,
		// so the wide query would drag the curated content JSON up to 50 times
		// over to compare one string.
		stillWanted: async () =>
			(await getNewsletterSendStatus(input.sendId)) ===
			"PENDING_APPROVAL",
	});

	// Report the outcome; do NOT throw on a partial or total failure.
	//
	// Throwing would be the reflex — the reviewer EMAIL activity throws on a
	// mixed outcome so Temporal retries it. That is right for mail, where the
	// provider deduplicates on idempotencyKey and a retry genuinely re-attempts
	// the unreached recipient. It is WRONG here: a failed channel already holds
	// its ledger claim, so a retry's claim insert conflicts, returns
	// claimed:false, and the target is skipped fail-closed
	// (chat-delivery-engine.ts, deliverOne's claim check). The retry provably
	// cannot reach it. Throwing would burn the retry budget, emit a workflow
	// error for something already terminal, and re-attempt nothing.
	//
	// So a failed alert post is terminal for this cycle. That is the tail the
	// spec defers by name under Out of Scope: closing it needs retryable lease
	// semantics on the ledger, which is the outbox, not a throw. The bell and the
	// email have already reached the reviewer. Log it so a total outage is
	// visible rather than looking like success.
	if (outcome.failedCount > 0) {
		logger.warn("[Newsletter] reviewer chat alert partially failed", {
			sendId: input.sendId,
			projectId: context.projectId,
			...outcome,
		});
	}
}
