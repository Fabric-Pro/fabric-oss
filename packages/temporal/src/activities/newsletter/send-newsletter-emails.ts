import { createHash } from "node:crypto";
import {
	claimDelivery,
	markDelivery,
	type NewsletterContent,
} from "@repo/database";
import { sendEmail } from "@repo/mail";
import { getBaseUrl } from "@repo/utils";
import { heartbeat } from "@temporalio/activity";
import type { NewsletterRecipient } from "./load-active-subscribers";

export interface SendNewsletterEmailsInput {
	sendId: string;
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	projectName: string;
	content: NewsletterContent;
	subscribers: NewsletterRecipient[];
}
export interface SendNewsletterEmailsOutput {
	sentCount: number;
	failedCount: number;
}

/**
 * Canonical app base URL for unsubscribe links. Uses @repo/utils `getBaseUrl`,
 * the same source the API invitation emails use; in the Temporal worker
 * (Azure Container App) it resolves from `APP_URL` (NEXT_PUBLIC_* is not
 * present there), matching the daily-brief activity convention.
 */
function newsletterBaseUrl(): string {
	return getBaseUrl();
}

export async function sendNewsletterEmailsActivity(
	input: SendNewsletterEmailsInput,
): Promise<SendNewsletterEmailsOutput> {
	const {
		sendId,
		projectId,
		organizationId,
		userId,
		projectName,
		content,
		subscribers,
	} = input;
	const root = newsletterBaseUrl();

	const attempt = async (
		sub: NewsletterRecipient,
	): Promise<"sent" | "failed"> => {
		const claim = await claimDelivery({
			sendId,
			projectId,
			organizationId,
			userId,
			recipientEmail: sub.email,
		});
		if (claim.alreadySent) {
			return "sent"; // idempotent: never re-mail a SENT recipient
		}
		const idempotencyKey = `newsletter-${sendId}-${createHash("sha1")
			.update(sub.email)
			.digest("hex")}`;
		const ok = await sendEmail({
			to: sub.email,
			templateId: "releaseNotesNewsletter",
			idempotencyKey,
			context: {
				projectName,
				headline: content.headline,
				intro: content.intro,
				highlights: content.highlights,
				unsubscribeUrl: `${root}/unsubscribe/${sub.unsubscribeToken}`,
				appUrl: root, // app origin used for the "Open Fabric" CTA (same base as unsubscribe links)
			},
		});
		if (ok) {
			await markDelivery(sendId, sub.email, "SENT");
			return "sent";
		}
		await markDelivery(
			sendId,
			sub.email,
			"FAILED",
			"provider returned false",
		);
		return "failed";
	};

	// Pass 1.
	const failed: NewsletterRecipient[] = [];
	for (const sub of subscribers) {
		heartbeat(`sendNewsletterEmails: ${sub.email}`);
		if ((await attempt(sub)) === "failed") {
			failed.push(sub);
		}
	}
	// Pass 2 — one retry for transient failures. claim-before-send keeps
	// already-SENT recipients idempotent, so this re-attempts ONLY the failed
	// ones.
	const stillFailed: NewsletterRecipient[] = [];
	for (const sub of failed) {
		heartbeat(`sendNewsletterEmails(retry): ${sub.email}`);
		if ((await attempt(sub)) === "failed") {
			stillFailed.push(sub);
		}
	}

	return {
		sentCount: subscribers.length - stillFailed.length,
		failedCount: stillFailed.length,
	};
}
