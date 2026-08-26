import { createHash } from "node:crypto";

import { logger } from "@repo/logs";

const CONSENT_VERSION = "fabric-newsletter-double-opt-in-v1";

export async function captureConfirmedNewsletterLead({
	email,
	confirmedAt = new Date(),
}: {
	email: string;
	confirmedAt?: Date;
}): Promise<void> {
	const endpoint = process.env.GTM_BRAIN_WEBSITE_LEAD_URL?.trim();
	const secret = process.env.GTM_BRAIN_WEBSITE_LEAD_SECRET?.trim();
	if (!endpoint || !secret) {
		return;
	}

	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		logger.warn("Newsletter GTM lead delivery skipped", {
			event: "newsletter_gtm_lead_invalid_endpoint",
		});
		return;
	}
	if (url.protocol !== "https:") {
		logger.warn("Newsletter GTM lead delivery skipped", {
			event: "newsletter_gtm_lead_insecure_endpoint",
		});
		return;
	}

	const normalizedEmail = email.trim().toLowerCase();
	const occurredAt = confirmedAt.toISOString();
	const eventId = `newsletter-confirmed:${createHash("sha256")
		.update(normalizedEmail)
		.digest("hex")}`;

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-gtm-webhook-secret": secret,
			},
			body: JSON.stringify({
				source: "fabric_web",
				eventId,
				event: "fabric_updates_submitted",
				email: normalizedEmail,
				product: "suite",
				sourceUrl: "https://fabric.pro/",
				occurredAt,
				marketingConsent: true,
				consentVersion: CONSENT_VERSION,
				consentedAt: occurredAt,
			}),
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok) {
			logger.warn("Newsletter GTM lead delivery failed", {
				event: "newsletter_gtm_lead_delivery_failed",
				status: response.status,
			});
		}
	} catch (error) {
		logger.warn("Newsletter GTM lead delivery failed", {
			event: "newsletter_gtm_lead_delivery_failed",
			reason: error instanceof Error ? error.name : "unknown",
		});
	}
}
