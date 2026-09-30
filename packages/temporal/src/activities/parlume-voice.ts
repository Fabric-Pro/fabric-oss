import { resolveOpenAiApiKey } from "@repo/ai";
import { z } from "zod";

const MAX_SPOKEN_CHARS = 800;
const MAX_PCM_BYTES = 6 * 1024 * 1024;

function bridgeControlUrl(
	sessionId: string,
	action: "speak" | "stop" | "verify-generation",
): string {
	const host = process.env.NEXT_PUBLIC_PARTYKIT_HOST;
	if (!host) {
		throw new Error("Parlume media host is not configured.");
	}
	const base = new URL(
		host.includes("://")
			? host
			: (host.startsWith("localhost") ? "http://" : "https://") + host,
	);
	if (base.protocol !== "https:" && base.hostname !== "localhost") {
		throw new Error("Parlume media host must use HTTPS.");
	}
	base.pathname = `/parties/parlume/${encodeURIComponent(sessionId)}`;
	base.search = `?action=${action}`;
	return base.toString();
}

export async function verifyParlumeVoiceGeneration(input: {
	sessionId: string;
	voiceGeneration: number;
	signal?: AbortSignal;
}): Promise<boolean> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret || input.signal?.aborted) {
		return false;
	}
	try {
		const response = await fetch(
			bridgeControlUrl(input.sessionId, "verify-generation"),
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${secret}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					voiceGeneration: input.voiceGeneration,
				}),
				signal: input.signal
					? AbortSignal.any([
							input.signal,
							AbortSignal.timeout(5_000),
						])
					: AbortSignal.timeout(5_000),
			},
		);
		if (!response.ok) {
			return false;
		}
		return z.object({ current: z.boolean() }).parse(await response.json())
			.current;
	} catch {
		return false;
	}
}

export async function speakParlumeResponse(input: {
	sessionId: string;
	userId: string;
	organizationId: string;
	response: string;
	voiceGeneration?: number;
	confirmationSpeakerId?: string;
	signal?: AbortSignal;
}): Promise<{ played: boolean; interrupted: boolean; firstAudioAt?: number }> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		throw new Error("Parlume media service secret is not configured.");
	}
	const key = await resolveOpenAiApiKey({
		userId: input.userId,
		organizationId: input.organizationId,
	});
	if (!key) {
		throw new Error("Parlume voice is not configured.");
	}
	const tts = await fetch("https://api.openai.com/v1/audio/speech", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: "gpt-4o-mini-tts",
			voice: "alloy",
			response_format: "pcm",
			input: input.response.slice(0, MAX_SPOKEN_CHARS),
		}),
		signal: input.signal
			? AbortSignal.any([input.signal, AbortSignal.timeout(60_000)])
			: AbortSignal.timeout(60_000),
	});
	if (!tts.ok) {
		throw new Error(
			`Parlume speech generation failed (HTTP ${tts.status}).`,
		);
	}
	const declaredLength = Number(tts.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_PCM_BYTES) {
		throw new Error("Parlume speech exceeded the audio limit.");
	}
	if (!tts.body) {
		throw new Error("Parlume speech returned no audio.");
	}
	let bytes = 0;
	const pcm = tts.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				bytes += chunk.byteLength;
				if (bytes > MAX_PCM_BYTES) {
					throw new Error("Parlume speech exceeded the audio limit.");
				}
				controller.enqueue(chunk);
			},
			flush() {
				if (bytes === 0 || bytes % 2 !== 0) {
					throw new Error(
						"Parlume speech returned invalid PCM audio.",
					);
				}
			},
		}),
	);
	const playbackRequest: RequestInit & { duplex: "half" } = {
		method: "POST",
		headers: {
			Authorization: `Bearer ${secret}`,
			"content-type": "audio/pcm",
			"x-parlume-voice-generation": String(input.voiceGeneration ?? 0),
			...(input.confirmationSpeakerId
				? {
						"x-parlume-confirmation-speaker":
							input.confirmationSpeakerId,
					}
				: {}),
		},
		body: pcm,
		duplex: "half",
		signal: input.signal
			? AbortSignal.any([input.signal, AbortSignal.timeout(90_000)])
			: AbortSignal.timeout(90_000),
	};
	const playback = await fetch(
		bridgeControlUrl(input.sessionId, "speak"),
		playbackRequest,
	);
	if (!playback.ok) {
		throw new Error(
			`Parlume audio playback failed (HTTP ${playback.status}).`,
		);
	}
	return z
		.object({
			played: z.boolean(),
			interrupted: z.boolean().default(false),
			firstAudioAt: z.number().optional(),
		})
		.parse(await playback.json());
}

/**
 * The bridge owns durable provider-stop retries. Activities call this only
 * after an active meeting loses its inviter's project access.
 */
export async function requestParlumeMeetingStop(input: {
	sessionId: string;
}): Promise<void> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		throw new Error("Parlume media service secret is not configured.");
	}
	const response = await fetch(bridgeControlUrl(input.sessionId, "stop"), {
		method: "POST",
		headers: { Authorization: `Bearer ${secret}` },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) {
		throw new Error("Parlume meeting stop request failed.");
	}
}
