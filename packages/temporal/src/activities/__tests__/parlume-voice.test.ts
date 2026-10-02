import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	postParlumeMeetingChat,
	requestParlumeMeetingStop,
	speakParlumeResponse,
	verifyParlumeVoiceGeneration,
} from "../parlume-voice";

const resolveOpenAiApiKey = vi.hoisted(() => vi.fn());
const logAiUsageAsync = vi.hoisted(() => vi.fn());
const getAISpeechModel = vi.hoisted(() => vi.fn());
const generateSpeech = vi.hoisted(() => vi.fn());

vi.mock("@repo/ai", () => ({
	getAISpeechModel,
	resolveOpenAiApiKey,
}));

vi.mock("ai", () => ({
	generateSpeech,
}));

// 24 kHz 16-bit mono WAV around the given samples, as gateway speech returns.
function wavOf(samples: number[]): Uint8Array {
	const pcm = new Uint8Array(new Int16Array(samples).buffer);
	const bytes = new Uint8Array(44 + pcm.length);
	const view = new DataView(bytes.buffer);
	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) {
			bytes[offset + i] = text.charCodeAt(i);
		}
	};
	ascii(0, "RIFF");
	view.setUint32(4, bytes.length - 8, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, 24_000, true);
	view.setUint32(28, 48_000, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ascii(36, "data");
	view.setUint32(40, pcm.length, true);
	bytes.set(pcm, 44);
	return bytes;
}

async function drain(body: unknown): Promise<number> {
	if (!(body instanceof ReadableStream)) {
		throw new Error("Expected streaming body");
	}
	const reader = body.getReader();
	let total = 0;
	for (
		let chunk = await reader.read();
		!chunk.done;
		chunk = await reader.read()
	) {
		total += chunk.value.byteLength;
	}
	return total;
}

vi.mock("@repo/database", () => ({
	logAiUsageAsync,
}));

vi.mock("../parlume-log", () => ({
	parlumeActivityLog: () => undefined,
}));

const originalHost = process.env.NEXT_PUBLIC_PARTYKIT_HOST;
const originalSecret = process.env.AGENT_SERVICE_SECRET;

const speaker = {
	sessionId: "session-1",
	userId: "user-1",
	organizationId: "org-1",
	projectId: "project-1",
};

beforeEach(() => {
	process.env.NEXT_PUBLIC_PARTYKIT_HOST = "bridge.example.com";
	process.env.AGENT_SERVICE_SECRET = "service-secret";
	resolveOpenAiApiKey.mockResolvedValue("voice-key");
	getAISpeechModel.mockResolvedValue(null);
});

describe("Parlume speech through the organization's AI Gateway", () => {
	const trackUsage = vi.fn();
	beforeEach(() => {
		getAISpeechModel.mockResolvedValue({
			model: { modelId: "openai/tts-1" },
			modelId: "openai/tts-1",
			configId: "gateway-config",
			trackUsage,
		});
	});

	it("speaks the gateway's WAV as PCM without touching the direct OpenAI key", async () => {
		generateSpeech.mockResolvedValue({
			audio: { uint8Array: wavOf([1, 2, 3, 4]) },
		});
		let played = 0;
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			played = await drain(init?.body);
			return Response.json({ played: true });
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			speakParlumeResponse({
				...speaker,
				response: "The project is Example.",
			}),
		).resolves.toEqual({ played: true, interrupted: false });

		expect(generateSpeech).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "The project is Example.",
				outputFormat: "wav",
			}),
		);
		expect(played).toBe(8);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toContain("action=speak");
		expect(resolveOpenAiApiKey).not.toHaveBeenCalled();
		expect(trackUsage).toHaveBeenCalled();
		expect(logAiUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "VERCEL_GATEWAY",
				providerModelId: "openai/tts-1",
				featureKey: "parlume",
				conversationId: "session-1",
				success: true,
			}),
		);
	});

	it("falls back to the direct OpenAI key when the gateway cannot speak", async () => {
		generateSpeech.mockRejectedValue(new Error("model not available"));
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.includes("api.openai.com")) {
				return new Response(new Uint8Array([0, 1]));
			}
			await drain(init?.body);
			return Response.json({ played: true });
		});
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			speakParlumeResponse({ ...speaker, response: "Hello" }),
		).resolves.toEqual({ played: true, interrupted: false });

		expect(logAiUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "VERCEL_GATEWAY",
				success: false,
				errorMessage: "model not available",
			}),
		);
		expect(fetchMock.mock.calls[0][0]).toBe(
			"https://api.openai.com/v1/audio/speech",
		);
	});

	it("reports the last route's error when every route fails", async () => {
		generateSpeech.mockRejectedValue(new Error("model not available"));
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 })),
		);

		await expect(
			speakParlumeResponse({ ...speaker, response: "Hello" }),
		).rejects.toThrow("HTTP 401");
	});
});

describe("Parlume meeting chat fallback", () => {
	it("asks the bridge to post the reply into the meeting chat", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(Response.json({ sent: true }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			postParlumeMeetingChat({
				sessionId: "session-1",
				message: "Answer",
			}),
		).resolves.toBe(true);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://bridge.example.com/parties/parlume/session-1?action=chat",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ message: "Answer" }),
			}),
		);
	});

	it("reports failure instead of throwing when the bridge is unreachable", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));

		await expect(
			postParlumeMeetingChat({
				sessionId: "session-1",
				message: "Answer",
			}),
		).resolves.toBe(false);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetAllMocks();
	if (originalHost === undefined) {
		delete process.env.NEXT_PUBLIC_PARTYKIT_HOST;
	} else {
		process.env.NEXT_PUBLIC_PARTYKIT_HOST = originalHost;
	}
	if (originalSecret === undefined) {
		delete process.env.AGENT_SERVICE_SECRET;
	} else {
		process.env.AGENT_SERVICE_SECRET = originalSecret;
	}
});

describe("Parlume dispatch generation", () => {
	it.each([true, false])(
		"uses the live bridge generation result: %s",
		async (current) => {
			const fetchMock = vi
				.fn()
				.mockResolvedValue(Response.json({ current }));
			vi.stubGlobal("fetch", fetchMock);
			await expect(
				verifyParlumeVoiceGeneration({
					sessionId: "session",
					voiceGeneration: 7,
				}),
			).resolves.toBe(current);
			expect(fetchMock).toHaveBeenCalledWith(
				"https://bridge.example.com/parties/parlume/session?action=verify-generation",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ voiceGeneration: 7 }),
				}),
			);
		},
	);

	it("blocks dispatch when the bridge cannot verify the generation", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new Error("Connection lost")),
		);
		await expect(
			verifyParlumeVoiceGeneration({
				sessionId: "session",
				voiceGeneration: 7,
			}),
		).resolves.toBe(false);
	});

	it("does not contact the bridge after cancellation", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			verifyParlumeVoiceGeneration({
				sessionId: "session",
				voiceGeneration: 7,
				signal: AbortSignal.abort(),
			}),
		).resolves.toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("Parlume spoken responses", () => {
	it("forwards the first PCM bytes before speech synthesis finishes", async () => {
		let finish: (() => void) | undefined;
		let synthesisFinished = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([0, 1]));
				finish = () => {
					synthesisFinished = true;
					controller.enqueue(new Uint8Array([2, 3]));
					controller.close();
				};
			},
		});
		const fetchMock = vi.fn(async (url: string, request?: RequestInit) => {
			if (url.includes("api.openai.com")) {
				return new Response(body);
			}
			if (!(request?.body instanceof ReadableStream)) {
				throw new Error("Expected streaming body");
			}
			const reader = request.body.getReader();
			expect(await reader.read()).toEqual({
				done: false,
				value: new Uint8Array([0, 1]),
			});
			expect(synthesisFinished).toBe(false);
			finish?.();
			expect(await reader.read()).toEqual({
				done: false,
				value: new Uint8Array([2, 3]),
			});
			expect((await reader.read()).done).toBe(true);
			return Response.json({
				played: true,
				interrupted: false,
				firstAudioAt: 123,
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			speakParlumeResponse({
				...speaker,
				response: "Hello",
				voiceGeneration: 3,
			}),
		).resolves.toEqual({
			played: true,
			interrupted: false,
			firstAudioAt: 123,
		});
	});

	it("preserves an interrupted playback result instead of claiming speech was delivered", async () => {
		const controller = new AbortController();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(new Uint8Array([0, 1])))
			.mockResolvedValueOnce(
				Response.json({ played: false, interrupted: true }),
			);
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			speakParlumeResponse({
				...speaker,
				response: "Hello",
				voiceGeneration: 3,
				signal: controller.signal,
			}),
		).resolves.toEqual({ played: false, interrupted: true });
		controller.abort();
		for (const [, init] of fetchMock.mock.calls) {
			expect(init.signal.aborted).toBe(true);
		}
	});
	it("sends bounded 24 kHz PCM through the authenticated meeting bridge", async () => {
		const pcm = new Uint8Array([0, 0, 1, 0]);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(pcm, {
					status: 200,
					headers: { "content-length": String(pcm.byteLength) },
				}),
			)
			.mockResolvedValueOnce(
				new Response('{"played":true}', { status: 200 }),
			);
		vi.stubGlobal("fetch", fetchMock);

		await speakParlumeResponse({
			...speaker,
			response: "The project decision is recorded.",
			voiceGeneration: 3,
		});

		expect(resolveOpenAiApiKey).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(fetchMock).toHaveBeenNthCalledWith(
			1,
			"https://api.openai.com/v1/audio/speech",
			expect.objectContaining({
				body: expect.stringContaining('"response_format":"pcm"'),
			}),
		);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"https://bridge.example.com/parties/parlume/session-1?action=speak",
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: "Bearer service-secret",
					"content-type": "audio/pcm",
					"x-parlume-voice-generation": "3",
				}),
				body: expect.any(ReadableStream),
			}),
		);
	});

	it("records synthesized speech as Parlume usage priced by text and audio length", async () => {
		// 48,000 bytes = one second of 24 kHz 16-bit mono audio. The bridge
		// consumes the whole stream before answering, which is when the byte
		// count the usage row is priced from becomes final.
		const pcm = new Uint8Array(48_000);
		const fetchMock = vi.fn(async (url: string, request?: RequestInit) => {
			if (url.includes("api.openai.com")) {
				return new Response(pcm, { status: 200 });
			}
			if (!(request?.body instanceof ReadableStream)) {
				throw new Error("Expected streaming body");
			}
			const reader = request.body.getReader();
			while (!(await reader.read()).done) {
				// drain
			}
			return new Response('{"played":true}', { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const response = "x".repeat(40);

		await speakParlumeResponse({
			...speaker,
			response,
			voiceGeneration: 3,
		});

		const audioTokens = Math.round((1 / 60) * 1_250);
		expect(logAiUsageAsync).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				projectId: "project-1",
				provider: "OPENAI_DIRECT",
				providerModelId: "gpt-4o-mini-tts",
				taskType: "AUDIO",
				featureKey: "parlume",
				conversationId: "session-1",
				inputTokens: 10,
				outputTokens: audioTokens,
				totalTokens: 10 + audioTokens,
				success: true,
			}),
		);
		const { costUsd } = logAiUsageAsync.mock.calls[0][0];
		expect(costUsd).toBeCloseTo(
			10 * (0.6 / 1_000_000) + (1 / 60) * 0.015,
			9,
		);
	});

	it("records a failed synthesis so the attempt is still visible in usage", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce(new Response(null, { status: 429 })),
		);

		await expect(
			speakParlumeResponse({ ...speaker, response: "Hello" }),
		).rejects.toThrow("HTTP 429");
		expect(logAiUsageAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				success: false,
				errorMessage: "HTTP 429",
				outputTokens: 0,
			}),
		);
	});

	it("does not generate speech without a voice key", async () => {
		resolveOpenAiApiKey.mockResolvedValue(null);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			speakParlumeResponse({
				...speaker,
				response: "Hello",
				voiceGeneration: 3,
			}),
		).rejects.toThrow("voice is not configured");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(logAiUsageAsync).not.toHaveBeenCalled();
	});

	it("asks the durable bridge to stop capture when the inviter loses access", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response('{"accepted":true}', { status: 200 }),
			);
		vi.stubGlobal("fetch", fetchMock);

		await requestParlumeMeetingStop({ sessionId: "session-1" });

		expect(fetchMock).toHaveBeenCalledWith(
			"https://bridge.example.com/parties/parlume/session-1?action=stop",
			expect.objectContaining({
				method: "POST",
				headers: { Authorization: "Bearer service-secret" },
			}),
		);
	});
});
