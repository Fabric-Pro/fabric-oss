import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export {
	cleanupParlumeProviderData,
	finalizeParlumeSession,
} from "@repo/api/modules/projects/lib/parlume-finalization";

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

export function streamTokenDigest(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function callbackSecret(sessionId: string): string | null {
	const serviceSecret = process.env.AGENT_SERVICE_SECRET;
	if (!serviceSecret) {
		return null;
	}
	return createHmac("sha256", serviceSecret)
		.update(`parlume-callback:${sessionId}`)
		.digest("base64url");
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
