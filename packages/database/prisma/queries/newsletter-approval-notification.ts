/**
 * Emits the NEWSLETTER_APPROVAL_PENDING in-app notification to a project's
 * admins/owners when a newsletter send parks for review (Fizzy 1869). Best-effort
 * and idempotent per (send, recipient) via a dedupeKey unique on Notification;
 * lives in @repo/database so the temporal newsletter activity can call it (the
 * @repo/api payload validator cannot be imported here — workspace cycle).
 */
import { db } from "../client";
import { resolveNewsletterReviewRecipients } from "./newsletter-review-recipients";

export interface ApprovalNotificationSend {
	id: string;
	projectId: string;
	organizationId: string | null;
	project: { name: string };
}

/**
 * Pure builder for the per-recipient `notification.create({ data })` payload.
 * Extracted out of the emit loop below so the title/snippet/link/payload/
 * dedupeKey shape is unit-testable without a live DB. Behavior-identical to
 * inlining it — callers must still gate on send.status === "PENDING_APPROVAL"
 * before invoking this.
 */
export function buildApprovalNotificationRow(
	send: ApprovalNotificationSend,
	userId: string,
) {
	const title = `Newsletter for "${send.project.name}" awaits review`;
	const snippet = "Review and approve the release notes before they're sent";
	// Context-relative deep link (resolveNotificationLink prepends /app or
	// /app/{slug} from organizationId). `?tab=settings` is honored by
	// ProjectDetails today; `settingsTab=newsletter` is honored by the
	// ProjectSettings deep-link added in Task 10 Step 0. A bare "settings/newsletter"
	// would NOT land on the review UI (Codex final-review finding).
	const link = `projects/${send.projectId}?tab=settings&settingsTab=newsletter`;
	const payload = { sendId: send.id, projectId: send.projectId };

	return {
		userId,
		organizationId: send.organizationId,
		type: "NEWSLETTER_APPROVAL_PENDING" as const,
		category: "SYSTEM" as const,
		title,
		snippet,
		link,
		projectId: send.projectId,
		payload,
		dedupeKey: `newsletter-approval:${send.id}:${userId}`,
	};
}

export async function emitNewsletterApprovalPendingNotification(input: {
	sendId: string;
}): Promise<void> {
	// Recipients come from the shared resolver so this channel and the reviewer
	// email cannot drift apart, and so both follow the real authorization rule
	// (Fizzy #2172). The previous query here was OWNER/PROJECT_ADMIN members
	// plus the creator, which both over- and under-notified: it missed an
	// organization owner who never joined the project but can approve, and it
	// told a plain-member creator about a review they would be refused.
	//
	// `reviewEmails` is deliberately ignored — that flag gates the EMAIL channel
	// only; the in-app bell for a pending review stays unconditional.
	const context = await resolveNewsletterReviewRecipients(input.sendId);
	if (!context || context.recipients.length === 0) {
		return;
	}
	const send = {
		id: context.sendId,
		projectId: context.projectId,
		organizationId: context.organizationId,
		project: { name: context.projectName },
	};

	for (const { userId } of context.recipients) {
		try {
			await db.notification.create({
				data: buildApprovalNotificationRow(send, userId),
			});
		} catch (error) {
			// P2002 = already notified this recipient for this send; best-effort.
			const code = (error as { code?: string } | null)?.code;
			if (code !== "P2002") {
				// Intentionally silent: notification is best-effort.
			}
		}
	}
}
