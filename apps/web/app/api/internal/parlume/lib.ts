import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const MAX_PARLUME_SEGMENT_CHARS = 20_000;

function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

export function constantTimeEqual(
	provided: string | null,
	expected: string | undefined,
): boolean {
	if (!provided || !expected) {
		return false;
	}
	return timingSafeEqual(digest(provided), digest(expected));
}

export function isParlumeServiceRequestAuthorized(
	provided: string | null,
): boolean {
	return constantTimeEqual(provided, process.env.AGENT_SERVICE_SECRET);
}

/** How a session's stream and webhook tokens are stored: only as this digest. */
export function sessionTokenDigest(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

// The JSON Attendee signs: keys sorted at every level, no spaces, text as is
// (Python's `json.dumps(sort_keys=True, ensure_ascii=False,
// separators=(",", ":"))`).
function attendeeCanonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(attendeeCanonicalJson).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const fields = Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(
				([key, field]) =>
					`${JSON.stringify(key)}:${attendeeCanonicalJson(field)}`,
			);
		return `{${fields.join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * Whether `X-Webhook-Signature` is Attendee's signature of this payload: the
 * base64 HMAC-SHA256 of its canonical JSON, keyed with the project's webhook
 * secret, which Attendee shows base64-encoded.
 */
export function isAttendeeWebhookSigned(
	payload: unknown,
	signature: string | null,
	webhookSecret: string,
): boolean {
	if (!signature) {
		return false;
	}
	const expected = createHmac("sha256", Buffer.from(webhookSecret, "base64"))
		.update(attendeeCanonicalJson(payload), "utf8")
		.digest("base64");
	return constantTimeEqual(signature, expected);
}

/**
 * A meeting chat message is one segment and at most one request, whatever its
 * text: Attendee redelivers webhooks and reports an edited message again
 * under the same id.
 */
export function chatMessageDedupeKey(
	sessionId: string,
	chatMessageId: string,
): string {
	return createHash("sha256")
		.update(JSON.stringify(["chat", sessionId, chatMessageId]))
		.digest("hex");
}

/**
 * A realtime voice job is one request, however often it is delivered. Job
 * numbers restart with the bridge, so the request itself keeps a new job
 * apart from an earlier one that had the same number.
 */
export function realtimeJobDedupeKey(input: {
	sessionId: string;
	voiceGeneration: number;
	job: string;
	text: string;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				"realtime",
				input.sessionId,
				input.voiceGeneration,
				input.job,
				input.text,
			]),
		)
		.digest("hex");
}

/** A pause or resume is one transcript marker, however often the bridge reports it. */
export function listeningEventDedupeKey(input: {
	sessionId: string;
	paused: boolean;
	at: number;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				"listening",
				input.sessionId,
				input.paused,
				input.at,
			]),
		)
		.digest("hex");
}

export function segmentDedupeKey(input: {
	sessionId: string;
	text: string;
	speakerName: string | null;
	speakerId: string | null;
	utteranceStartMs: number | null;
	utteranceEndMs: number | null;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				input.sessionId,
				input.text,
				input.speakerName,
				input.speakerId,
				input.utteranceStartMs,
				input.utteranceEndMs,
			]),
		)
		.digest("hex");
}
