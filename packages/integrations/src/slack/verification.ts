/**
 * Slack Signature Verification
 *
 * Verifies incoming Slack webhook requests using the signing secret.
 * Implements Slack's recommended verification method:
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * Signature format: v0=<hex_hash>
 * Base string: v0:<timestamp>:<body>
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Slack webhook request signature
 *
 * @param signingSecret - The Slack app signing secret (from SLACK_SIGNING_SECRET env var)
 * @param signature - The X-Slack-Signature header value
 * @param timestamp - The X-Slack-Request-Timestamp header value
 * @param body - The raw request body (not parsed JSON)
 * @returns boolean indicating if the signature is valid
 */
export function verifySlackSignature(
	signingSecret: string,
	signature: string,
	timestamp: string,
	body: string,
): boolean {
	// Check for required parameters
	if (!signingSecret || !signature || !timestamp || !body) {
		return false;
	}

	// Check timestamp to prevent replay attacks (5 minute window)
	const requestTimestamp = Number.parseInt(timestamp, 10);
	const currentTimestamp = Math.floor(Date.now() / 1000);
	const fiveMinutes = 5 * 60;

	if (
		Number.isNaN(requestTimestamp) ||
		Math.abs(currentTimestamp - requestTimestamp) > fiveMinutes
	) {
		return false;
	}

	// Construct the base string
	const baseString = `v0:${timestamp}:${body}`;

	// Compute HMAC-SHA256
	const hmac = createHmac("sha256", signingSecret);
	hmac.update(baseString);
	const computedSignature = `v0=${hmac.digest("hex")}`;

	// Constant-time comparison to prevent timing attacks
	try {
		const sigBuffer = Buffer.from(signature);
		const computedBuffer = Buffer.from(computedSignature);

		if (sigBuffer.length !== computedBuffer.length) {
			return false;
		}

		return timingSafeEqual(sigBuffer, computedBuffer);
	} catch {
		return false;
	}
}

/**
 * Extract retry information from Slack headers
 *
 * Slack sends retry headers when retrying failed event deliveries:
 * - X-Slack-Retry-Num: The retry attempt number (1, 2, 3...)
 * - X-Slack-Retry-Reason: The reason for retry (e.g., "http_timeout")
 *
 * @param headers - Request headers object
 * @returns Retry info or null if not a retry
 */
export function getSlackRetryInfo(headers: {
	get(name: string): string | null;
}): {
	isRetry: boolean;
	retryNum?: number;
	retryReason?: string;
} {
	const retryNum = headers.get("x-slack-retry-num");
	const retryReason = headers.get("x-slack-retry-reason");

	if (retryNum) {
		return {
			isRetry: true,
			retryNum: Number.parseInt(retryNum, 10),
			retryReason: retryReason || undefined,
		};
	}

	return { isRetry: false };
}

/**
 * Clean text by removing @Fabric mention
 *
 * @param text - The original message text
 * @param botUserId - The bot's user ID (for mention cleanup)
 * @returns Cleaned text without the mention
 */
export function cleanMentionText(text: string, botUserId?: string): string {
	if (!text) {
		return "";
	}

	let cleaned = text.trim();

	// Remove @Fabric or @fabric
	cleaned = cleaned.replace(/@fabric\b/gi, "").trim();

	// Remove Slack-style mention if botUserId provided
	// Format: <@U12345678> or <@U12345678|fabric>
	if (botUserId) {
		const mentionRegex = new RegExp(`<@${botUserId}(\\|[^>]+)?>`, "gi");
		cleaned = cleaned.replace(mentionRegex, "").trim();
	}

	return cleaned;
}

/**
 * Normalize thread identifier from Slack event
 *
 * @param event - Slack event object
 * @returns Thread identifier object
 */
export function normalizeThreadId(event: {
	channel: string;
	ts: string;
	thread_ts?: string;
	channel_type?: string;
}): {
	channelId: string;
	threadTs: string;
	isDm: boolean;
} {
	// For threads: use the parent message ts (thread_ts if exists, else ts)
	// For top-level messages: use the message ts
	const threadTs = event.thread_ts || event.ts;

	return {
		channelId: event.channel,
		threadTs,
		isDm: event.channel_type === "im",
	};
}

/**
 * Check if event should be processed
 *
 * Filters out:
 * - Bot messages (bot_id present)
 * - Edited messages (subtype present)
 * - Messages from the bot itself
 * - Unsupported event types
 *
 * @param event - Slack event object
 * @param botUserId - The bot's user ID
 * @returns boolean indicating if event should be processed
 */
export function shouldProcessEvent(
	event: {
		type?: string;
		bot_id?: string;
		user?: string;
		subtype?: string;
		text?: string;
	},
	botUserId?: string,
): boolean {
	// Skip bot messages
	if (event.bot_id) {
		return false;
	}

	// Skip edited/deleted messages (have subtype)
	if (event.subtype) {
		return false;
	}

	// Skip messages from the bot itself
	if (botUserId && event.user === botUserId) {
		return false;
	}

	// Skip messages without text
	if (!event.text || event.text.trim().length === 0) {
		return false;
	}

	// Only process app_mention or message types
	if (event.type !== "app_mention" && event.type !== "message") {
		return false;
	}

	return true;
}
