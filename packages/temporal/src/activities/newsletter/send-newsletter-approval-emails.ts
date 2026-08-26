import { resolveNewsletterReviewRecipients } from "@repo/database";
import { logger } from "@repo/logs";
import { isMailConfigured, sendEmail } from "@repo/mail";
import { getBaseUrl } from "@repo/utils";
import { heartbeat } from "@temporalio/activity";

export interface SendNewsletterApprovalEmailsInput {
	sendId: string;
}

/**
 * Email everyone who can approve a parked release-notes draft (Fizzy #2172).
 *
 * ## Why this is its own activity
 *
 * Anything that throws out of `holdNewsletterForApprovalActivity` reaches the
 * workflow's outer catch, which finalizes the send as FAILED **unconditionally**
 * — it calls `finalizeNewsletterSend` without `expectStatus`, so it overwrites
 * PENDING_APPROVAL. Mail living there would let a missing RESEND_API_KEY turn a
 * perfectly reviewable parked draft into a dead one. The workflow swallows this
 * activity's failure instead, the same way it already does for the subscriber
 * email and chat delivery.
 *
 * ## Why there is no claim
 *
 * A batch claim would permanently skip every recipient not reached before a
 * crash, and no provider key can rescue a request that was never made.
 * `idempotencyKey` genuinely reaches Resend, so retrying the whole batch is
 * safe: delivered recipients are suppressed and unreached ones finally go out.
 *
 * That is exactly why a partial failure must still throw. Returning success on
 * a mixed outcome would mean Temporal never retries and the failed reviewer is
 * never told — nothing else re-drives this.
 *
 * ## What this does not promise
 *
 * A mail outage lasting past the retry budget loses that cycle's email. The
 * in-app notification and the pending-review list are unaffected, so the
 * reviewer is left where today's in-app-only behaviour leaves them. Closing
 * that tail needs a per-recipient outbox, deliberately deferred.
 *
 * The retry budget is sized against the Resend breaker's half-open window, so
 * that a provider outage costs the email only if it outlasts the breaker rather
 * than merely tripping it — see `newsletter-approval-email-retry.ts`.
 */
export async function sendNewsletterApprovalEmailsActivity(
	input: SendNewsletterApprovalEmailsInput,
): Promise<void> {
	heartbeat("sendNewsletterApprovalEmails");

	// Before anything is attempted, so the throw is retry-safe: a Temporal
	// retry after the key is supplied still reaches every recipient.
	if (!isMailConfigured()) {
		throw new Error(
			"Mail is not configured (RESEND_API_KEY missing); retrying reviewer email.",
		);
	}

	const context = await resolveNewsletterReviewRecipients(input.sendId);
	if (!context) {
		return; // decided or expired in the interim — the email would be noise
	}

	// Organization.slug is nullable and the workspace route is /app/{slug}/…,
	// so without it no correct link exists. Interpolating the null would send an
	// authorized reviewer to /app/null/…, and falling back to the personal path
	// would be worse still — a URL in the wrong tenant context. Send nothing;
	// the in-app notification is unaffected and its link carries no slug.
	if (context.organizationId && !context.organizationSlug) {
		logger.warn(
			"[Newsletter] reviewer email skipped: organization has no slug",
			{ sendId: input.sendId, projectId: context.projectId },
		);
		return;
	}

	const eligible = context.recipients.filter(
		(r) => r.reviewEmails && r.email,
	);
	if (eligible.length === 0) {
		return;
	}

	// Trailing slashes stripped so APP_URL="https://example.com/" does not
	// produce a doubled separator — the same defect already fixed once in the
	// report-execution email.
	const base = getBaseUrl().replace(/\/+$/, "");
	const workspace = context.organizationSlug
		? `/app/${context.organizationSlug}`
		: "/app";
	const url = `${base}${workspace}/projects/${context.projectId}?tab=settings&settingsTab=newsletter`;

	// The logs below carry `userId` and nothing else about the recipient on
	// purpose. `sendEmail` already records the address, the provider error and
	// its stack ("Email send failed"), so repeating them here would only put a
	// second copy of the address in the logs. `userId` is the one field that
	// layer cannot know, and it is what ties a failure back to a reviewer —
	// which matters more here than in the subscriber path, because this
	// activity deliberately keeps no per-recipient row to read afterwards.
	const failed: string[] = [];
	for (const recipient of eligible) {
		heartbeat("sendNewsletterApprovalEmails: recipient");
		try {
			const ok = await sendEmail({
				to: recipient.email as string,
				templateId: "newsletterApprovalPending",
				idempotencyKey: `newsletter-approval-${input.sendId}-${recipient.userId}`,
				context: { projectName: context.projectName, url },
			});
			// sendEmail reports a provider rejection as `false` rather than
			// throwing, so both shapes have to count as a failure.
			if (!ok) {
				failed.push(recipient.userId);
				logger.warn(
					"[Newsletter] reviewer email rejected by the provider",
					{ sendId: input.sendId, userId: recipient.userId },
				);
			}
		} catch (e) {
			failed.push(recipient.userId);
			logger.warn("[Newsletter] reviewer email failed for a recipient", {
				sendId: input.sendId,
				userId: recipient.userId,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	if (failed.length > 0) {
		// One recipient's failure never aborts the loop above — everybody is
		// attempted — but any failure fails the activity so Temporal retries.
		throw new Error(
			`Reviewer email failed for ${failed.length} of ${eligible.length} recipients`,
		);
	}
}
