import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	requestParlumeMeetingStop,
	speakParlumeResponse,
	verifyParlumeVoiceGeneration,
} from "../parlume-voice";

const resolveOpenAiApiKey = vi.hoisted(() => vi.fn());

vi.mock("@repo/ai", () => ({
	resolveOpenAiApiKey,
}));

const originalHost = process.env.NEXT_PUBLIC_PARTYKIT_HOST;
const originalSecret = process.env.AGENT_SERVICE_SECRET;

beforeEach(() => {
	process.env.NEXT_PUBLIC_PARTYKIT_HOST = "bridge.example.com";
	process.env.AGENT_SERVICE_SECRET = "service-secret";
	resolveOpenAiApiKey.mockResolvedValue("voice-key");
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
				sessionId: "session",
				userId: "user",
				organizationId: "org",
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
				sessionId: "session",
				userId: "user",
				organizationId: "org",
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
			sessionId: "session-1",
			userId: "user-1",
			organizationId: "org-1",
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

	it("does not generate speech without a voice key", async () => {
		resolveOpenAiApiKey.mockResolvedValue(null);
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			speakParlumeResponse({
				sessionId: "session-1",
				userId: "user-1",
				organizationId: "org-1",
				response: "Hello",
				voiceGeneration: 3,
			}),
		).rejects.toThrow("voice is not configured");
		expect(fetchMock).not.toHaveBeenCalled();
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
