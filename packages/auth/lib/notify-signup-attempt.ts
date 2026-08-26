/**
 * Signup Enumeration Notice (B2)
 *
 * Sends a silent notification email when someone attempts to register with an
 * email address that already belongs to an existing account. This ensures the
 * legitimate account owner is informed without leaking any information to the
 * prober on the wire or in the UI.
 *
 * Throttling — per-email, one notice per hour:
 *   The bucket key is SHA-256(normalize(email)), not the raw address, so the
 *   Redis key itself does not expose PII and an attacker cannot enumerate
 *   which addresses are registered by watching key creation patterns. The
 *   normalized form (lowercased, trimmed) collapses case variants to the same
 *   bucket, preventing trivial throttle bypass via capitalisation.
 *
 *   The throttle uses an atomic `SET key 1 NX EX TTL_SEC`: a single round-trip
 *   that both creates the key and sets its TTL, so there is no window where
 *   the key can persist without an expiry. A non-atomic `INCR` + conditional
 *   `EXPIRE` would leave an orphan key with no TTL if the second call failed
 *   after the first succeeded, permanently throttling that email until the
 *   key was manually evicted.
 *
 * Fail-open on Redis errors:
 *   If Redis is unavailable (e.g. dev without credentials, or a transient
 *   outage) the function falls through and sends the email anyway. The risk of
 *   a duplicate notice within the hour window is much smaller than silently
 *   dropping the notification entirely.
 */

import { createHash } from "node:crypto";
import { logger } from "@repo/logs";
import { sendEmail } from "@repo/mail";
import { getBaseUrl } from "@repo/utils";
import { getAuthRedisClient } from "./redis-client";

const TTL_SEC = 3600;
const KEY_PREFIX = "signup-notice:";

function bucketKey(email: string): string {
	const h = createHash("sha256")
		.update(email.trim().toLowerCase())
		.digest("hex");
	return `${KEY_PREFIX}${h}`;
}

export async function notifySignupAttempt(email: string): Promise<void> {
	const redis = getAuthRedisClient();
	if (redis) {
		try {
			// Atomic acquire: SET key 1 NX EX TTL_SEC. Returns "OK" on first
			// caller within the window, null when NX fails because the key
			// already exists. Both creating the key and setting the TTL
			// happen in a single round-trip — no orphan-key risk.
			const acquired = await redis.set(bucketKey(email), 1, {
				ex: TTL_SEC,
				nx: true,
			});
			if (acquired !== "OK") {
				// Already notified within the throttle window — skip.
				return;
			}
		} catch (err) {
			// Redis hiccup — fall through and send anyway. The risk of a
			// duplicate notice is preferable to silently dropping it.
			logger.warn({ event: "notify_signup_attempt.redis_error", err });
		}
	}

	const baseUrl = getBaseUrl();
	const loginUrl = `${baseUrl}/auth/login`;
	const resetUrl = `${baseUrl}/auth/forgot-password`;

	try {
		await sendEmail({
			to: email,
			templateId: "signupAttemptNotice",
			context: { loginUrl, resetUrl },
		});
	} catch (err) {
		logger.warn({ event: "notify_signup_attempt.send_failed", err });
	}
}
