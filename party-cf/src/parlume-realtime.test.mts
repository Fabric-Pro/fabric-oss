import assert from "node:assert/strict";
import { test } from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

type Resampler = { push(pcm: Uint8Array): Uint8Array };
type Client = {
	configure(): void;
	appendAudio(pcm: Uint8Array, sampleRate: number): void;
	flushAudio(): void;
};

const realtime = loadParlumeModule("./parlume-realtime.ts", async () =>
	Response.json({}),
) as {
	ParlumeResampler: new (inputRate: number, outputRate: number) => Resampler;
	ParlumeRealtimeClient: new (
		socket: unknown,
		handlers: {
			onEvent(event: unknown): void;
			onClose(detail: string): void;
		},
	) => Client;
	parseParlumeRealtimeCredentials(value: unknown): unknown;
	parlumeRealtimeUpgrade(credentials: unknown): {
		url: string;
		headers: Record<string, string>;
	};
	parseParlumeRealtimeEvent(data: unknown): unknown;
};

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function pcm(samples: number[]): Uint8Array {
	return new Uint8Array(new Int16Array(samples).buffer);
}

function samples(bytes: Uint8Array): number[] {
	return [
		...new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2),
	];
}

function fakeSocket() {
	const sent: Array<Record<string, unknown>> = [];
	const listeners = new Map<string, Array<(event: unknown) => void>>();
	return {
		sent,
		socket: {
			send: (data: string) => sent.push(JSON.parse(data)),
			close() {},
			addEventListener(type: string, listener: (event: unknown) => void) {
				listeners.set(type, [...(listeners.get(type) ?? []), listener]);
			},
		},
		emit(type: string, event: unknown) {
			for (const listener of listeners.get(type) ?? []) {
				listener(event);
			}
		},
	};
}

test("16 kHz meeting audio becomes 24 kHz: three samples for every two", () => {
	const resampler = new realtime.ParlumeResampler(16_000, 24_000);
	const out: number[] = [];
	// One second of Attendee's 10 ms chunks.
	for (let chunk = 0; chunk < 100; chunk++) {
		out.push(...samples(resampler.push(pcm(new Array(160).fill(1_000)))));
	}
	// The last output sample waits for the next chunk to interpolate towards.
	assert.equal(out.length, 23_999);
	assert.ok(out.every((value) => value === 1_000));
});

test("the resampler interpolates linearly between input samples", () => {
	const resampler = new realtime.ParlumeResampler(16_000, 24_000);
	assert.deepEqual(
		samples(resampler.push(pcm([0, 300, 600, 900]))),
		[0, 200, 400, 600, 800],
	);
	// The next chunk picks up between the last sample and its own first one.
	assert.deepEqual(
		samples(resampler.push(pcm([1_200, 1_500]))),
		[1_000, 1_200, 1_400],
	);
});

test("chunk boundaries do not show in the resampled audio", () => {
	const ramp = Array.from({ length: 320 }, (_, index) => index * 10);
	const whole = samples(
		new realtime.ParlumeResampler(16_000, 24_000).push(pcm(ramp)),
	);
	const chunked = new realtime.ParlumeResampler(16_000, 24_000);
	const pieces: number[] = [];
	for (let start = 0; start < ramp.length; start += 160) {
		pieces.push(
			...samples(chunked.push(pcm(ramp.slice(start, start + 160)))),
		);
	}
	assert.deepEqual(pieces, whole);
	assert.ok(Math.abs(pieces.length - 480) <= 1);
});

test("credentials need a client secret and a plain model name", () => {
	assert.deepEqual(
		plain(
			realtime.parseParlumeRealtimeCredentials({
				clientSecret: "ek_test",
				model: "gpt-realtime-2.1",
				expiresAt: 1,
			}),
		),
		{
			clientSecret: "ek_test",
			model: "gpt-realtime-2.1",
			url: "https://api.openai.com/v1/realtime",
			provider: "OPENAI_DIRECT",
		},
	);
	for (const value of [
		{ accepted: true },
		{ engine: "classic" },
		{ clientSecret: "", model: "gpt-realtime-2.1" },
		{ clientSecret: "ek_test", model: "x?y" },
		null,
	]) {
		assert.equal(realtime.parseParlumeRealtimeCredentials(value), null);
	}
});

test("a secret minted on an Azure resource opens that resource, and no other host is trusted", () => {
	const azure =
		"https://example-resource.openai.azure.com/openai/v1/realtime";
	assert.deepEqual(
		plain(
			realtime.parseParlumeRealtimeCredentials({
				clientSecret: "ek_test",
				model: "gpt-realtime-2.1",
				realtimeUrl: azure,
			}),
		),
		{
			clientSecret: "ek_test",
			model: "gpt-realtime-2.1",
			url: azure,
			provider: "AZURE_AI_FOUNDRY",
		},
	);
	for (const realtimeUrl of [
		"https://example.com/openai/v1/realtime",
		"https://example-resource.openai.azure.com.example.com/openai/v1/realtime",
		"http://example-resource.openai.azure.com/openai/v1/realtime",
		"https://example-resource.openai.azure.com/openai/v1/realtime?api-key=x",
		7,
	]) {
		assert.equal(
			realtime.parseParlumeRealtimeCredentials({
				clientSecret: "ek_test",
				model: "gpt-realtime-2.1",
				realtimeUrl,
			}),
			null,
		);
	}
});

test("the upgrade carries the client secret as a bearer header only", () => {
	const upgrade = plain(
		realtime.parlumeRealtimeUpgrade({
			clientSecret: "ek_test",
			model: "gpt-realtime-2.1",
			url: "https://api.openai.com/v1/realtime",
			provider: "OPENAI_DIRECT",
		}),
	);
	assert.equal(
		upgrade.url,
		"https://api.openai.com/v1/realtime?model=gpt-realtime-2.1",
	);
	assert.deepEqual(upgrade.headers, {
		Upgrade: "websocket",
		Authorization: "Bearer ek_test",
	});
});

test("the session is told never to answer or interrupt on its own", () => {
	const { socket, sent } = fakeSocket();
	const client = new realtime.ParlumeRealtimeClient(socket, {
		onEvent() {},
		onClose() {},
	});
	client.configure();
	assert.deepEqual(sent, [
		{
			type: "session.update",
			session: {
				type: "realtime",
				audio: {
					input: {
						format: { type: "audio/pcm", rate: 24_000 },
						turn_detection: {
							type: "semantic_vad",
							eagerness: "auto",
							create_response: false,
							interrupt_response: false,
						},
						noise_reduction: { type: "far_field" },
						transcription: null,
					},
					output: { format: { type: "audio/pcm", rate: 24_000 } },
				},
			},
		},
	]);
});

test("meeting audio is appended in 100 ms batches", () => {
	const { socket, sent } = fakeSocket();
	const client = new realtime.ParlumeRealtimeClient(socket, {
		onEvent() {},
		onClose() {},
	});
	// Attendee's 10 ms chunks: 160 samples at 16 kHz.
	let chunks = 0;
	while (sent.length === 0 && chunks < 20) {
		client.appendAudio(pcm(new Array(160).fill(7)), 16_000);
		chunks++;
	}
	assert.equal(chunks, 11, "the first append waits for 100 ms of audio");
	assert.equal(sent[0].type, "input_audio_buffer.append");
	const audio = Buffer.from(String(sent[0].audio), "base64");
	assert.ok(
		audio.length >= 4_800 && audio.length < 4_800 + 480,
		"about 100 ms of 24 kHz 16-bit audio",
	);
	client.appendAudio(pcm(new Array(160).fill(7)), 16_000);
	client.flushAudio();
	assert.equal(sent.length, 2, "a flush sends what is still batched");
});

test("a finished response reports its usage split the way it is priced", () => {
	const event = plain(
		realtime.parseParlumeRealtimeEvent(
			JSON.stringify({
				type: "response.done",
				response: {
					id: "resp_1",
					status: "completed",
					output: [
						{
							type: "function_call",
							call_id: "call_1",
							name: "ask_fabric",
							arguments: '{"request":"Roadmap status"}',
						},
						{
							type: "message",
							content: [
								{
									type: "output_audio",
									transcript: "Checking now.",
								},
							],
						},
					],
					usage: {
						input_tokens: 1_200,
						output_tokens: 90,
						input_token_details: {
							audio_tokens: 1_000,
							text_tokens: 200,
							cached_tokens: 800,
							cached_tokens_details: {
								audio_tokens: 700,
								text_tokens: 100,
							},
						},
						output_token_details: {
							audio_tokens: 80,
							text_tokens: 10,
						},
					},
				},
			}),
		),
	);
	assert.deepEqual(event, {
		type: "response_done",
		responseId: "resp_1",
		status: "completed",
		usage: {
			inputTextTokens: 100,
			inputAudioTokens: 300,
			cachedTextTokens: 100,
			cachedAudioTokens: 700,
			outputTextTokens: 10,
			outputAudioTokens: 80,
		},
		functionCalls: [
			{
				callId: "call_1",
				name: "ask_fabric",
				arguments: '{"request":"Roadmap status"}',
			},
		],
		transcripts: ["Checking now."],
	});
});

test("audio deltas decode to PCM; unknown events are ignored", () => {
	const delta = realtime.parseParlumeRealtimeEvent(
		JSON.stringify({
			type: "response.output_audio.delta",
			response_id: "resp_1",
			item_id: "item_1",
			delta: Buffer.from([1, 2, 3, 4]).toString("base64"),
		}),
	) as { audio: Uint8Array; itemId: string };
	assert.equal(delta.itemId, "item_1");
	assert.deepEqual([...delta.audio], [1, 2, 3, 4]);
	assert.equal(
		realtime.parseParlumeRealtimeEvent(
			JSON.stringify({ type: "rate_limits.updated" }),
		),
		null,
	);
	assert.equal(realtime.parseParlumeRealtimeEvent("not json"), null);
});

test("an error keeps OpenAI's code, parameter and message for the log", () => {
	assert.deepEqual(
		plain(
			realtime.parseParlumeRealtimeEvent(
				JSON.stringify({
					type: "error",
					error: {
						type: "invalid_request_error",
						code: "invalid_parameter",
						param: "session.audio.input.noise_reduction",
						message: "Unsupported value.",
					},
				}),
			),
		),
		{
			type: "error",
			code: "invalid_parameter",
			param: "session.audio.input.noise_reduction",
			message: "Unsupported value.",
		},
	);
});
