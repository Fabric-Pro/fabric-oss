/**
 * Shared helpers for the notification delivery-channel preferences feature.
 *
 * Kept separate from the procedures so the same validation + secret-generation
 * logic is reused by get/update/rotate and covered directly by unit tests.
 */

import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Webhook endpoint URL validation. Per product decision, BOTH `http://` and
 * `https://` are permitted (http is convenient for local/test receivers), and
 * URLs that embed credentials (`https://user:pass@host`) are rejected as a
 * basic SSRF/credential-leak guard. Empty string is allowed by callers as a
 * sentinel meaning "clear the stored URL" and is handled before this schema.
 */
export const webhookUrlSchema = z
	.string()
	.trim()
	.url("Enter a valid URL.")
	.refine((value) => /^https?:\/\//i.test(value), {
		message: "Webhook URL must start with http:// or https://.",
	})
	.refine(
		(value) => {
			try {
				const parsed = new URL(value);
				return !parsed.username && !parsed.password;
			} catch {
				return false;
			}
		},
		{ message: "Webhook URL must not contain embedded credentials." },
	);

/** Prefix mirrors the de-facto webhook-secret convention (e.g. Stripe `whsec_`). */
export const WEBHOOK_SECRET_PREFIX = "whsec_";

/**
 * Generate a fresh webhook signing secret. 32 random bytes (256 bits) encoded
 * base64url, prefixed for recognizability. Shown to the user exactly once at
 * creation/rotation; only the encrypted form is persisted.
 */
export function generateWebhookSecret(): string {
	return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}
