import { beforeEach, describe, expect, it, vi } from "vitest";
import { ParlumeSentenceQueue } from "../parlume-spoken-text";
import { speakParlumeResponse } from "../parlume-voice";
import { TurnTimings, withTurnTimings } from "../shared/turn-timing";

const resolveOpenAiApiKey = vi.hoisted(() => vi.fn());
const logAiUsageAsync = vi.hoisted(() => vi.fn());
const getAISpeechModel = vi.hoisted(() => vi.fn());
const generateSpeech = vi.hoisted(() => vi.fn());

vi.mock("@repo/ai", () => ({
	AUDIO_PROVIDER_REQUIRED: { parlumeVoice: "voice required" },
	getAISpeechModel,
	resolveOpenAiApiKey,
}));
vi.mock("ai", () => ({ generateSpeech }));
vi.mock("@repo/database", () => ({ logAiUsageAsync }));
vi.mock("../parlume-log", () => ({ parlumeActivityLog: () => undefined }));

const speaker = {
	sessionId: "session-1",
	userId: "user-1",
	organizationId: "org-1",
	projectId: "project-1",
};
const spoken = (text: string) => ParlumeSentenceQueue.fromText(text, 800);

function readLines(body: unknown): string[] {
	if (typeof body !== "string") {
		throw new Error("Expected a whole reply part as text");
	}
	return body
		.split("\n")
		.filter(Boolean)
		.map((line) => (JSON.parse(line) as { text: string }).text);
}

function header(call: Call, name: string): string | undefined {
	const headers = call.init?.headers;
	return headers && !Array.isArray(headers) && !(headers instanceof Headers)
		? headers[name]
		: undefined;
}

async function drain(body: unknown): Promise<void> {
	if (!(body instanceof ReadableStream)) {
		throw new Error("Expected a streaming body");
	}
	const reader = body.getReader();
	while (!(await reader.read()).done) {
		// Playing it out.
	}
}

function auraResult(overrides: Record<string, unknown> = {}) {
	return {
		played: true,
		interrupted: false,
		firstAudioAt: Date.now(),
		sentences: [
			{
				chars: 18,
				startedAtMs: 5,
				firstByteMs: 290,
				totalMs: 600,
				ok: true,
			},
		],
		...overrides,
	};
}

type Call = { url: string; init?: RequestInit };

// Later parts of a reply sent in parts, apart from the calls that start it.
let parts: Call[] = [];

function stubBridge(handlers: {
	/** The first part of a reply: answered with its whole playback. */
	say: (call: Call) => Promise<Response> | Response;
	part?: (call: Call) => Promise<Response> | Response;
	speak?: (call: Call) => Promise<Response> | Response;
	openai?: () => Response;
}) {
	const calls: Call[] = [];
	parts = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const call = { url: String(url), init };
			if (
				String(url).includes("action=say") &&
				header(call, "x-parlume-reply-part") !== "0"
			) {
				parts.push(call);
				return (
					(await handlers.part?.(call)) ??
					Response.json({ accepted: true })
				);
			}
			calls.push(call);
			if (String(url).includes("action=say")) {
				return handlers.say(call);
			}
			if (new URL(String(url)).origin === "https://api.openai.com") {
				return (
					handlers.openai?.() ?? new Response(new Uint8Array([1, 0]))
				);
			}
			await drain(init?.body);
			return (
				(await handlers.speak?.({ url: String(url), init })) ??
				Response.json({ played: true })
			);
		}),
	);
	return calls;
}

beforeEach(() => {
	vi.resetAllMocks();
	process.env.NEXT_PUBLIC_PARTYKIT_HOST = "bridge.example.com";
	process.env.AGENT_SERVICE_SECRET = "service-secret";
	resolveOpenAiApiKey.mockResolvedValue("voice-key");
	getAISpeechModel.mockResolvedValue(null);
});

describe("Parlume speech through Deepgram Aura in the bridge", () => {
	it("sends the sentences as text to the bridge and plays nothing through the worker", async () => {
		const calls = stubBridge({
			say: async ({ init }) => {
				expect(readLines(init?.body)).toEqual(["The plan is ready."]);
				return Response.json(auraResult());
			},
		});

		const result = await speakParlumeResponse({
			...speaker,
			sentences: spoken("The plan is ready."),
			voiceGeneration: 4,
		});

		expect(result).toMatchObject({ played: true, interrupted: false });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(
			"https://bridge.example.com/parties/parlume/session-1?action=say",
		);
		expect(calls[0]?.init?.headers).toMatchObject({
			Authorization: "Bearer service-secret",
			"content-type": "application/x-ndjson",
			"x-parlume-voice-generation": "4",
			"x-parlume-reply": expect.any(String),
			"x-parlume-reply-part": "0",
			// A reply that already exists whole is one request.
			"x-parlume-reply-last": "1",
		});
		expect(parts).toEqual([]);
		expect(calls[0]?.init?.headers).not.toHaveProperty(
			"x-parlume-confirmation-speaker",
		);
		expect(generateSpeech).not.toHaveBeenCalled();
		expect(resolveOpenAiApiKey).not.toHaveBeenCalled();
	});

	it("sends the first sentence before the rest of the answer is written, and the rest as a later part", async () => {
		const sentences = new ParlumeSentenceQueue(800);
		let lastPart: () => void = () => {};
		const lastPartSent = new Promise<void>((resolve) => {
			lastPart = resolve;
		});
		let first: string[] = [];
		const calls = stubBridge({
			say: async ({ init }) => {
				first = readLines(init?.body);
				// Only now does the rest of the answer exist.
				sentences.push(" of them are done.");
				sentences.end();
				await lastPartSent;
				return Response.json(auraResult());
			},
			part: (call) => {
				if (header(call, "x-parlume-reply-last") === "1") {
					lastPart();
				}
				return Response.json({ accepted: true });
			},
		});

		sentences.push("The roadmap has two hundred items. Forty");
		await speakParlumeResponse({ ...speaker, sentences });

		expect(first).toEqual(["The roadmap has two hundred items."]);
		expect(
			header(calls[0] as Call, "x-parlume-reply-last"),
		).toBeUndefined();
		expect(
			parts.map((part) => ({
				reply: header(part, "x-parlume-reply"),
				part: header(part, "x-parlume-reply-part"),
				last: header(part, "x-parlume-reply-last"),
				sentences: readLines(part.init?.body),
			})),
		).toEqual([
			{
				reply: header(calls[0] as Call, "x-parlume-reply"),
				part: "1",
				last: "1",
				sentences: ["Forty of them are done."],
			},
		]);
	});

	it("speaks the sentences the bridge stopped waiting for through another route", async () => {
		const sentences = new ParlumeSentenceQueue(800);
		stubBridge({
			// The bridge gave up waiting after the first part and played it.
			say: () => {
				sentences.push("Forty of them are done.");
				sentences.end();
				return Response.json(auraResult());
			},
			part: () => Response.json({ accepted: false }),
		});
		const openaiFetch = vi.mocked(fetch);

		sentences.push("The roadmap has two hundred items. ");
		const result = await speakParlumeResponse({ ...speaker, sentences });

		expect(
			openaiFetch.mock.calls
				.filter(
					([url]) =>
						new URL(String(url)).origin ===
						"https://api.openai.com",
				)
				.map(([, init]) => JSON.parse(String(init?.body)).input),
		).toEqual(["Forty of them are done."]);
		expect(result.played).toBe(true);
	});

	it("withdraws a reply the turn gave up on, so the bridge drops what it queued", async () => {
		const abort = new AbortController();
		const sentences = new ParlumeSentenceQueue(800);
		stubBridge({
			say: async () => {
				abort.abort();
				throw new Error("aborted");
			},
		});

		sentences.push("The roadmap has two hundred items. ");
		await expect(
			speakParlumeResponse({
				...speaker,
				sentences,
				signal: abort.signal,
			}),
		).rejects.toThrow("aborted");

		expect(
			parts.map((part) => header(part, "x-parlume-reply-cancel")),
		).toEqual(["1"]);
	});

	it("records each synthesized sentence as Workers AI usage, priced per character", async () => {
		stubBridge({
			say: () =>
				Response.json(
					auraResult({
						sentences: [
							{
								chars: 1_000,
								startedAtMs: 0,
								firstByteMs: 300,
								totalMs: 900,
								ok: true,
							},
							{
								chars: 500,
								startedAtMs: 100,
								firstByteMs: 250,
								totalMs: 700,
								ok: true,
							},
						],
					}),
				),
		});

		await speakParlumeResponse({ ...speaker, sentences: spoken("Hello.") });

		expect(logAiUsageAsync).toHaveBeenCalledTimes(2);
		expect(logAiUsageAsync).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				projectId: "project-1",
				taskType: "AUDIO",
				featureKey: "parlume",
				conversationId: "session-1",
				provider: "CLOUDFLARE_AI",
				providerModelId: "@cf/deepgram/aura-2-en",
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				latencyMs: 900,
				success: true,
			}),
		);
		expect(logAiUsageAsync.mock.calls[0]?.[0].costUsd).toBeCloseTo(
			0.03,
			10,
		);
		expect(logAiUsageAsync.mock.calls[1]?.[0].costUsd).toBeCloseTo(
			0.015,
			10,
		);
	});

	it("records no usage for a sentence that produced no audio", async () => {
		stubBridge({
			say: () =>
				Response.json(
					auraResult({
						played: false,
						failedAt: 1,
						error: "Aura returned HTTP 503",
						sentences: [
							{
								chars: 20,
								startedAtMs: 0,
								firstByteMs: 300,
								totalMs: 500,
								ok: true,
							},
							{
								chars: 30,
								startedAtMs: 50,
								firstByteMs: null,
								totalMs: null,
								ok: false,
							},
						],
					}),
				),
			openai: () => new Response(new Uint8Array([1, 0])),
		});

		await speakParlumeResponse({
			...speaker,
			sentences: spoken(
				"First sentence is here. Second sentence follows it.",
			),
		});

		const aura = logAiUsageAsync.mock.calls.filter(
			([row]) => row.provider === "CLOUDFLARE_AI",
		);
		expect(aura).toHaveLength(1);
		expect(aura[0]?.[0].costUsd).toBeCloseTo(20 * 0.00003, 10);
	});

	it("reports each sentence's synthesis time in the turn timing, on the aura route", async () => {
		stubBridge({ say: () => Response.json(auraResult()) });
		const timings = new TurnTimings();

		await withTurnTimings(timings, () =>
			speakParlumeResponse({
				...speaker,
				sentences: spoken("The plan."),
			}),
		);

		expect(timings.snapshot().speech).toEqual([
			{
				chars: 18,
				route: "aura",
				startedAtMs: 5,
				firstByteMs: 290,
				totalMs: 600,
			},
		]);
	});

	it("returns an interruption as it is and does not speak the reply a second way", async () => {
		const calls = stubBridge({
			say: () =>
				Response.json(auraResult({ played: false, interrupted: true })),
		});

		await expect(
			speakParlumeResponse({ ...speaker, sentences: spoken("Hello.") }),
		).resolves.toMatchObject({ played: false, interrupted: true });
		expect(calls).toHaveLength(1);
	});
});

describe("when Aura cannot speak", () => {
	it.each([
		[
			"the bridge refuses the request",
			() => new Response("no", { status: 503 }),
		],
		[
			"the bridge sends an unreadable answer",
			() => new Response("not json"),
		],
	])(
		"falls back to the PCM routes for the whole reply when %s",
		async (_name, say) => {
			const calls = stubBridge({ say });

			const result = await speakParlumeResponse({
				...speaker,
				sentences: spoken("The plan is ready."),
			});

			expect(result).toMatchObject({ played: true });
			expect(calls.map((call) => call.url)).toEqual([
				"https://bridge.example.com/parties/parlume/session-1?action=say",
				"https://api.openai.com/v1/audio/speech",
				"https://bridge.example.com/parties/parlume/session-1?action=speak",
			]);
			expect(logAiUsageAsync).toHaveBeenCalledWith(
				expect.objectContaining({ provider: "OPENAI_DIRECT" }),
			);
		},
	);

	it("falls back when the request itself fails", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push(String(url));
				if (String(url).includes("action=say")) {
					throw new Error("network down");
				}
				if (new URL(String(url)).origin === "https://api.openai.com") {
					return new Response(new Uint8Array([1, 0]));
				}
				await drain(init?.body);
				return Response.json({ played: true });
			}),
		);

		await expect(
			speakParlumeResponse({ ...speaker, sentences: spoken("Hello.") }),
		).resolves.toMatchObject({ played: true });
		expect(calls).toHaveLength(3);
	});

	it("tries the AI Gateway route before the direct OpenAI key, as before", async () => {
		getAISpeechModel.mockResolvedValue({
			model: { modelId: "openai/tts-1" },
			modelId: "openai/tts-1",
			trackUsage: vi.fn(),
		});
		generateSpeech.mockRejectedValue(new Error("gateway unavailable"));
		const calls = stubBridge({
			say: () => new Response("no", { status: 503 }),
		});

		await speakParlumeResponse({ ...speaker, sentences: spoken("Hello.") });

		expect(generateSpeech).toHaveBeenCalledTimes(1);
		expect(calls.map((call) => call.url)).toContain(
			"https://api.openai.com/v1/audio/speech",
		);
	});

	it("speaks only the sentences the bridge did not, and keeps the first audio time", async () => {
		const first = Date.now() - 500;
		let synthesized: string[] = [];
		const calls = stubBridge({
			say: () =>
				Response.json(
					auraResult({
						played: false,
						firstAudioAt: first,
						failedAt: 1,
						error: "Aura returned HTTP 503",
						sentences: [
							{
								chars: 25,
								startedAtMs: 0,
								firstByteMs: 300,
								totalMs: 500,
								ok: true,
							},
						],
					}),
				),
			openai: () => {
				return new Response(new Uint8Array([2, 0]));
			},
		});
		const openaiFetch = vi.mocked(fetch);
		const sentences = new ParlumeSentenceQueue(800);
		sentences.push("First sentence is spoken. Second sentence is not. ");
		sentences.end();

		const result = await speakParlumeResponse({ ...speaker, sentences });

		synthesized = openaiFetch.mock.calls
			.filter(
				([url]) =>
					new URL(String(url)).origin === "https://api.openai.com",
			)
			.map(([, init]) => JSON.parse(String(init?.body)).input);
		expect(synthesized).toEqual(["Second sentence is not."]);
		expect(result.firstAudioAt).toBe(first);
		expect(result.played).toBe(true);
		expect(calls.at(-1)?.url).toContain("action=speak");
	});

	it("does not speak anything twice when the failure was in the last sentence", async () => {
		const calls = stubBridge({
			say: () =>
				Response.json(
					auraResult({
						played: false,
						failedAt: 1,
						error: "connection reset",
					}),
				),
		});

		const result = await speakParlumeResponse({
			...speaker,
			sentences: spoken("Only one sentence."),
		});

		expect(result).toMatchObject({ played: false, interrupted: false });
		expect(calls).toHaveLength(1);
	});

	it("passes a cancelled request on instead of falling back", async () => {
		const abort = new AbortController();
		stubBridge({
			say: async () => {
				abort.abort();
				throw new Error("aborted");
			},
		});

		await expect(
			speakParlumeResponse({
				...speaker,
				sentences: spoken("Hello."),
				signal: abort.signal,
			}),
		).rejects.toThrow("aborted");
		expect(resolveOpenAiApiKey).not.toHaveBeenCalled();
	});
});
