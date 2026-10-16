import { beforeEach, describe, expect, it, vi } from "vitest";
import { ParlumeSentenceQueue } from "../parlume-spoken-text";
import { speakParlumeResponse } from "../parlume-voice";
import { TurnTimings, withTurnTimings } from "../shared/turn-timing";

const resolveOpenAiApiKey = vi.hoisted(() => vi.fn());
const getAISpeechModel = vi.hoisted(() => vi.fn());
const generateSpeech = vi.hoisted(() => vi.fn());

vi.mock("@repo/ai", () => ({
	AUDIO_PROVIDER_REQUIRED: { parlumeVoice: "voice required" },
	getAISpeechModel,
	resolveOpenAiApiKey,
}));
vi.mock("ai", () => ({ generateSpeech }));
vi.mock("@repo/database", () => ({ logAiUsageAsync: vi.fn() }));
vi.mock("../parlume-log", () => ({ parlumeActivityLog: () => undefined }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function drain(body: unknown): Promise<void> {
	if (!(body instanceof ReadableStream)) {
		throw new Error("Expected streaming body");
	}
	const reader = body.getReader();
	while (!(await reader.read()).done) {
		// Playing it out.
	}
}

// These tests exercise the PCM routes, which carry a reply when Aura cannot
// speak it: the bridge's `say` endpoint is made to refuse.
function stubPcmFetch(
	handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) =>
			String(url).includes("action=say")
				? new Response("unavailable", { status: 503 })
				: handler(String(url), init),
		),
	);
}

const speaker = {
	sessionId: "session-1",
	userId: "user-1",
	organizationId: "org-1",
	projectId: "project-1",
};

beforeEach(() => {
	vi.resetAllMocks();
	process.env.NEXT_PUBLIC_PARTYKIT_HOST = "bridge.example.com";
	process.env.AGENT_SERVICE_SECRET = "service-secret";
	resolveOpenAiApiKey.mockResolvedValue("voice-key");
	getAISpeechModel.mockResolvedValue(null);
});

async function speakAndMeasure(text: string) {
	const timings = new TurnTimings();
	await withTurnTimings(timings, () =>
		speakParlumeResponse({
			...speaker,
			sentences: ParlumeSentenceQueue.fromText(text, 800),
		}),
	);
	return timings.snapshot().speech;
}

describe("Parlume speech timing", () => {
	it("measures the gateway's whole-clip synthesis as both first byte and total", async () => {
		getAISpeechModel.mockResolvedValue({
			model: { modelId: "openai/tts-1" },
			modelId: "openai/tts-1",
			trackUsage: vi.fn(),
		});
		generateSpeech.mockImplementation(async () => {
			await sleep(60);
			return { audio: { uint8Array: wavOf([1, 2, 3, 4]) } };
		});
		stubPcmFetch(async (_url: string, init?: RequestInit) => {
			await drain(init?.body);
			return Response.json({ played: true });
		});

		const [sentence] = await speakAndMeasure("The project is Example.");

		expect(sentence).toMatchObject({
			chars: "The project is Example.".length,
			route: "gateway",
		});
		expect(sentence?.firstByteMs).toBeGreaterThanOrEqual(55);
		expect(sentence?.firstByteMs).toBe(sentence?.totalMs);
		expect(sentence?.startedAtMs).toBeLessThan(50);
	});

	it("measures the direct route's first byte apart from the end of the clip", async () => {
		const stream = new ReadableStream<Uint8Array>({
			async start(controller) {
				await sleep(40);
				controller.enqueue(new Uint8Array([1, 0]));
				await sleep(80);
				controller.enqueue(new Uint8Array([2, 0]));
				controller.close();
			},
		});
		stubPcmFetch(async (url: string, init?: RequestInit) => {
			if (url.includes("api.openai.com")) {
				return new Response(stream);
			}
			await drain(init?.body);
			return Response.json({ played: true });
		});

		const [sentence] = await speakAndMeasure("Short answer.");

		expect(sentence?.route).toBe("openai-direct");
		expect(sentence?.firstByteMs).toBeGreaterThanOrEqual(35);
		expect(sentence?.totalMs).toBeGreaterThanOrEqual(
			(sentence?.firstByteMs ?? 0) + 70,
		);
	});

	it("records each sentence, the second starting after the first", async () => {
		getAISpeechModel.mockResolvedValue({
			model: { modelId: "openai/tts-1" },
			modelId: "openai/tts-1",
			trackUsage: vi.fn(),
		});
		generateSpeech.mockImplementation(async () => {
			await sleep(30);
			return { audio: { uint8Array: wavOf([1, 2]) } };
		});
		stubPcmFetch(async (_url: string, init?: RequestInit) => {
			await drain(init?.body);
			return Response.json({ played: true });
		});

		const sentences = await speakAndMeasure(
			"The roadmap has two hundred items. Forty of them are done.",
		);

		expect(sentences.map((entry) => entry.chars)).toEqual([34, 23]);
		expect(sentences[1]?.startedAtMs).toBeGreaterThanOrEqual(
			sentences[0]?.startedAtMs ?? 0,
		);
	});

	it("is silent about timing when no turn is collecting it", async () => {
		getAISpeechModel.mockResolvedValue({
			model: { modelId: "openai/tts-1" },
			modelId: "openai/tts-1",
			trackUsage: vi.fn(),
		});
		generateSpeech.mockResolvedValue({
			audio: { uint8Array: wavOf([1, 2]) },
		});
		stubPcmFetch(async (_url: string, init?: RequestInit) => {
			await drain(init?.body);
			return Response.json({ played: true });
		});
		await expect(
			speakParlumeResponse({
				...speaker,
				sentences: ParlumeSentenceQueue.fromText("Hello.", 800),
			}),
		).resolves.toEqual({ played: true, interrupted: false });
	});
});
