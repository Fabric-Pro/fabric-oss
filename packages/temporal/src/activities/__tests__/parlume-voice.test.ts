import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	requestParlumeMeetingStop,
	speakParlumeResponse,
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

describe("Parlume spoken responses", () => {
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
				}),
				body: expect.any(ArrayBuffer),
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
