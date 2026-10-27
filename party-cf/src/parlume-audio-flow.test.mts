import assert from "node:assert/strict";
import test from "node:test";
import {
	answeringMeeting,
	audio,
	type Bridge,
	connectedMeeting,
	control,
	flush,
	meeting,
	plain,
	STREAM_URL,
	say,
	sleep,
} from "./parlume-meeting-harness.mts";

test("the bot's audio is verified on its first chunk, transcribed, attributed, and a woken request reaches Fabric", async () => {
	const { bridge, bot, flux, requests, transcription } = meeting();
	await bridge.onStart();
	await bridge.onConnect(bot, { request: { url: STREAM_URL } });
	// Eight 10 ms chunks covering 1_000_000-1_000_080 on Attendee's clock.
	for (let end = 1_000_010; end <= 1_000_080; end += 10) {
		await bridge.onMessage(bot, audio(end));
	}
	const speakers = await bridge.onRequest(
		control("speakers", {
			updates: [
				{
					name: "Dev One",
					id: "participant-1",
					timestamp: 1_000_400,
					isSpeaking: true,
				},
			],
		}),
	);
	await flush();

	assert.equal(speakers.status, 200);
	assert.deepEqual(
		requests.find((r) => r.path.endsWith("/verify-stream"))?.body,
		{
			sessionId: "session-1",
			streamToken: "stream-token",
			botId: "bot_abc123",
		},
	);
	assert.equal(transcription.length, 1);
	assert.equal(transcription[0]?.model, "@cf/deepgram/flux");
	assert.deepEqual(plain(transcription[0]?.options), { websocket: true });
	assert.deepEqual(plain(transcription[0]?.inputs), {
		encoding: "linear16",
		sample_rate: "16000",
		keyterm: "Parlume",
		eager_eot_threshold: "0.5",
	});
	assert.equal(flux.accepted, true);
	assert.deepEqual(flux.sent, [2_560]);

	flux.turn({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.5,
		audio_window_end: 2.3456,
		transcript: "Hey Fabric, what is the name of the project?",
	});
	await flush();
	await flush();

	assert.deepEqual(requests.find((r) => r.path.endsWith("/segments"))?.body, {
		sessionId: "session-1",
		botId: "bot_abc123",
		text: "Hey Fabric, what is the name of the project?",
		speakerName: "Dev One",
		speakerId: "participant-1",
		utteranceStartMs: 500,
		utteranceEndMs: 2_346,
	});

	await sleep(700);
	const turn = requests.find((r) => r.path.endsWith("/turns"))?.body;
	assert.equal(turn?.text, "what is the name of the project?");
	assert.equal(turn?.speakerId, "participant-1");
	assert.equal(turn?.botId, "bot_abc123");
});

test("Flux word bounds attribute speech to the caller after another participant's long turn", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const { bridge, bot, flux, requests } = meeting();
	await bridge.onStart();
	await bridge.onConnect(bot, { request: { url: STREAM_URL } });
	t.after(() => bridge.onClose(bot));
	for (let end = 1_000_010; end <= 1_000_080; end += 10) {
		await bridge.onMessage(bot, audio(end));
	}
	await flush();
	await bridge.onRequest(
		control("speakers", {
			updates: [
				{
					name: "Previous speaker",
					id: "participant-1",
					timestamp: 1_000_000,
					isSpeaking: true,
				},
				{
					name: "Previous speaker",
					id: "participant-1",
					timestamp: 1_020_000,
					isSpeaking: false,
				},
				{
					name: "Caller",
					id: "participant-2",
					timestamp: 1_020_000,
					isSpeaking: true,
				},
				{
					name: "Caller",
					id: "participant-2",
					timestamp: 1_023_500,
					isSpeaking: false,
				},
			],
		}),
	);
	flux.turn({
		event: "Update",
		turn_index: 0,
		transcript: "",
		audio_window_start: 0,
		audio_window_end: 0.25,
	});
	flux.turn({
		event: "EndOfTurn",
		turn_index: 0,
		transcript: "Hey Fabric, hello",
		audio_window_start: 20,
		audio_window_end: 23.5,
		words: [
			{ word: "Hey", start: 20.1, end: 20.4 },
			{ word: "Fabric", start: 20.5, end: 21 },
			{ word: "hello", start: 22, end: 23.2 },
		],
	});
	await flush();
	assert.deepEqual(requests.find((r) => r.path.endsWith("/segments"))?.body, {
		sessionId: "session-1",
		botId: "bot_abc123",
		text: "Hey Fabric, hello",
		speakerName: "Caller",
		speakerId: "participant-2",
		utteranceStartMs: 20_100,
		utteranceEndMs: 23_200,
	});
	assert.equal(requests.filter((r) => r.path.endsWith("/turns")).length, 0);
	t.mock.timers.tick(1);
	await flush();
	const turn = requests.find((r) => r.path.endsWith("/turns"))?.body;
	assert.equal(turn?.speakerId, "participant-2");
	assert.equal(turn?.text, "hello");
});

test("a request that carries its own question is handed to Fabric at Flux's end of turn, with no extra wait", async () => {
	const { bridge, bot, flux, requests } = meeting();
	await bridge.onStart();
	await bridge.onConnect(bot, { request: { url: STREAM_URL } });
	for (let end = 1_000_010; end <= 1_000_080; end += 10) {
		await bridge.onMessage(bot, audio(end));
	}
	await flush();
	const dispatched = () => requests.some((r) => r.path.endsWith("/turns"));

	flux.turn({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.5,
		audio_window_end: 2.3,
		transcript: "Hey Fabric, what is the name of the project?",
	});
	await sleep(100);

	assert.equal(dispatched(), true, "dispatched well inside the old 600 ms");
	assert.equal(
		requests.find((r) => r.path.endsWith("/turns"))?.body.text,
		"what is the name of the project?",
	);
});

test("a request that follows a bare wake phrase is held briefly, and only words hold it open", async () => {
	const { bridge, bot, flux, requests } = meeting();
	await bridge.onStart();
	await bridge.onConnect(bot, { request: { url: STREAM_URL } });
	for (let end = 1_000_010; end <= 1_000_080; end += 10) {
		await bridge.onMessage(bot, audio(end));
	}
	await flush();
	const dispatched = () =>
		requests.filter((r) => r.path.endsWith("/turns")).length;

	flux.turn({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.5,
		audio_window_end: 1.2,
		transcript: "Hey Fabric.",
	});
	await sleep(100);
	assert.equal(dispatched(), 0, "a bare wake phrase has no request yet");

	flux.turn({
		event: "EndOfTurn",
		turn_index: 1,
		audio_window_start: 2,
		audio_window_end: 3,
		transcript: "How many items are on the roadmap?",
	});
	await sleep(150);
	flux.turn({
		event: "StartOfTurn",
		turn_index: 2,
		audio_window_start: 3.1,
		audio_window_end: 3.2,
		transcript: "",
	});
	await sleep(100);
	assert.equal(dispatched(), 0, "an empty start of turn does not hold it");
	await sleep(150);
	assert.equal(dispatched(), 1, "dispatched after the short quiet window");

	flux.turn({
		event: "EndOfTurn",
		turn_index: 3,
		audio_window_start: 5,
		audio_window_end: 5.5,
		transcript: "Hey Fabric.",
	});
	await sleep(50);
	flux.turn({
		event: "EndOfTurn",
		turn_index: 4,
		audio_window_start: 6,
		audio_window_end: 7,
		transcript: "And how many are done?",
	});
	await sleep(200);
	flux.turn({
		event: "Update",
		turn_index: 5,
		audio_window_start: 7.2,
		audio_window_end: 7.5,
		transcript: "and how many",
	});
	await sleep(200);
	assert.equal(dispatched(), 1, "a continuing speaker holds the request");
	await sleep(300);
	assert.equal(dispatched(), 2);
});

test("chunks that arrive while the stream is being verified are verified once and transcribed in order", async () => {
	let releaseVerification: () => void = () => {};
	const { bridge, bot, flux, requests, closed } = meeting({
		verify: () =>
			new Promise<Response>((resolve) => {
				releaseVerification = () =>
					resolve(
						Response.json({
							valid: true,
							hardStopAt: new Date(
								Date.now() + 3_600_000,
							).toISOString(),
							streamGeneration: 1,
						}),
					);
			}),
	});
	await bridge.onStart();
	await bridge.onConnect(bot, { request: { url: STREAM_URL } });

	const arrivals = [
		bridge.onMessage(bot, audio(1_000_080, { bytes: 2_560 })),
		bridge.onMessage(bot, audio(1_000_180, { bytes: 3_200 })),
		bridge.onMessage(bot, audio(1_000_300, { bytes: 3_840 })),
	];
	await flush();
	assert.equal(
		requests.filter((r) => r.path.endsWith("/verify-stream")).length,
		1,
	);
	assert.deepEqual(flux.sent, []);

	releaseVerification();
	await Promise.all(arrivals);
	await flush();
	// Held audio reaches Flux at three times real time: 300 ms in 100 ms.
	await new Promise((resolve) => setTimeout(resolve, 120));

	assert.equal(
		requests.filter((r) => r.path.endsWith("/verify-stream")).length,
		1,
	);
	assert.deepEqual(flux.sent, [2_560, 3_200, 3_840]);
	assert.deepEqual(closed, []);
});

test("a chunk from a bot Fabric does not recognise closes the stream and is never transcribed", async () => {
	const { bridge, bot, flux, closed, transcription } = meeting({
		verify: async () => new Response(null, { status: 403 }),
	});
	await bridge.onStart();
	await bridge.onConnect(bot, { request: { url: STREAM_URL } });

	await bridge.onMessage(bot, audio(1_000_010, { botId: "bot_other" }));
	await flush();

	assert.deepEqual(closed, [4001]);
	assert.deepEqual(flux.sent, []);
	assert.equal(transcription.length, 0);
});

test("a later chunk that names another bot closes the stream", async () => {
	const { bridge, bot, closed } = meeting();
	await bridge.onStart();
	await bridge.onConnect(bot, { request: { url: STREAM_URL } });
	await bridge.onMessage(bot, audio(1_000_010));

	await bridge.onMessage(bot, audio(1_000_020, { botId: "bot_other" }));

	assert.deepEqual(closed, [4001]);
});

test("a message that is not Attendee audio closes an unverified stream and is ignored once verified", async () => {
	const unverified = meeting();
	await unverified.bridge.onStart();
	await unverified.bridge.onConnect(unverified.bot, {
		request: { url: STREAM_URL },
	});
	await unverified.bridge.onMessage(unverified.bot, '{"event":"other"}');
	assert.deepEqual(unverified.closed, [4002]);

	const verified = meeting();
	await verified.bridge.onStart();
	await verified.bridge.onConnect(verified.bot, {
		request: { url: STREAM_URL },
	});
	await verified.bridge.onMessage(verified.bot, audio(1_000_010));
	await verified.bridge.onMessage(verified.bot, '{"event":"other"}');
	await verified.bridge.onMessage(verified.bot, "not json");
	assert.deepEqual(verified.closed, []);
});

test("binary frames are not the provider's audio and are never transcribed", async () => {
	const { bridge, bot, flux } = meeting();
	await bridge.onStart();
	await bridge.onConnect(bot, { request: { url: STREAM_URL } });
	await bridge.onMessage(bot, audio(1_000_080, { bytes: 2_560 }));
	await flush();

	await bridge.onMessage(bot, new ArrayBuffer(2_560));
	await bridge.onMessage(bot, new Uint8Array(2_560));
	await flush();

	assert.deepEqual(flux.sent, [2_560]);
});

test("the transcriber restarts at the rate the bot reports", async () => {
	const { bridge, bot, transcription } = meeting();
	await bridge.onStart();
	await bridge.onConnect(bot, { request: { url: STREAM_URL } });

	// 80 ms at 24 kHz, twice, then 80 ms at 16 kHz.
	await bridge.onMessage(
		bot,
		audio(1_000_080, { sampleRate: 24_000, bytes: 3_840 }),
	);
	await bridge.onMessage(
		bot,
		audio(1_000_160, { sampleRate: 24_000, bytes: 3_840 }),
	);
	await flush();
	assert.equal(transcription.length, 1);

	await bridge.onMessage(
		bot,
		audio(1_000_240, { sampleRate: 16_000, bytes: 2_560 }),
	);
	await flush();

	assert.deepEqual(
		transcription.map((call) => plain(call.inputs).sample_rate),
		["24000", "16000"],
	);
});

test("speaker updates need the service secret and a well-formed body", async () => {
	const { bridge } = meeting();
	await bridge.onStart();
	const update = {
		name: "Dev One",
		id: "participant-1",
		timestamp: 1_000_400,
		isSpeaking: true,
	};

	const unauthorized = await bridge.onRequest(
		control(
			"speakers",
			{ updates: [update] },
			{ Authorization: "Bearer wrong" },
		),
	);
	const malformed = await bridge.onRequest(
		control("speakers", { updates: [{ name: "Broken" }] }),
	);
	const missing = await bridge.onRequest(control("speakers", { update }));
	const accepted = await bridge.onRequest(
		control("speakers", { updates: [update] }),
	);

	assert.equal(unauthorized.status, 401);
	assert.equal(malformed.status, 400);
	assert.equal(missing.status, 400);
	assert.equal(accepted.status, 200);
	assert.deepEqual(plain(await accepted.json()), { accepted: 1 });
});

test("a reply is played as 100 ms JSON frames on the socket the bot streams from", async () => {
	const { bridge, bot, sent } = meeting();
	await bridge.onStart();
	await bridge.onConnect(bot, { request: { url: STREAM_URL } });
	await bridge.onMessage(bot, audio(1_000_010));
	await flush();

	// The bridge's outlet timers are unreferenced; this keeps the loop alive
	// while the reply plays out in real time.
	const keepAlive = setInterval(() => {}, 1_000);
	// 200 ms of 24 kHz speech at a steady non-zero level.
	const speech = new Uint8Array(new Int16Array(4_800).fill(1_000).buffer);
	const response = await bridge.onRequest(
		new Request(
			"https://bridge.example.com/parties/parlume/session-1?action=speak",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer service-secret",
					"content-type": "audio/pcm",
					"x-parlume-voice-generation": "0",
				},
				body: speech,
			},
		),
	);
	clearInterval(keepAlive);

	assert.equal(response.status, 200);
	const result = await response.json();
	assert.equal(result.played, true);
	assert.equal(result.interrupted, false);
	// 300 ms of silence for the bot's unmute, then the reply as two frames.
	const messages = sent.map((message) => JSON.parse(message));
	assert.equal(messages.length, 5);
	for (const message of messages) {
		assert.deepEqual(Object.keys(message), ["trigger", "data"]);
		assert.equal(message.trigger, "realtime_audio.bot_output");
		assert.equal(message.data.sample_rate, 24_000);
		assert.equal(Buffer.from(message.data.chunk, "base64").length, 4_800);
	}
	const silent = messages.map((message) =>
		Buffer.from(message.data.chunk, "base64").every((byte) => byte === 0),
	);
	assert.deepEqual(silent, [true, true, true, false, false]);
	await bridge.onClose(bot, 1000, "done");
});

test("a reply before the bot has streamed any meeting audio is refused", async () => {
	const { bridge, bot, sent } = meeting();
	await bridge.onStart();
	await bridge.onConnect(bot, { request: { url: STREAM_URL } });

	const response = await bridge.onRequest(
		new Request(
			"https://bridge.example.com/parties/parlume/session-1?action=speak",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer service-secret",
					"content-type": "audio/pcm",
					"x-parlume-voice-generation": "0",
				},
				body: new Uint8Array(4_800),
			},
		),
	);

	assert.equal(response.status, 409);
	assert.deepEqual(sent, []);
	await bridge.onClose(bot, 1000, "done");
});

test("sentences sent as text are synthesized by Aura and played as frames on the bot's socket", async () => {
	const { bridge, bot, sent, auraCalls } = await connectedMeeting();
	const keepAlive = setInterval(() => {}, 1_000);

	const response = await bridge.onRequest(
		say(["The plan is ready.", "Two items remain."]),
	);
	clearInterval(keepAlive);

	assert.equal(response.status, 200);
	const result = plain(await response.json());
	assert.equal(result.played, true);
	assert.equal(result.interrupted, false);
	assert.equal(typeof result.firstAudioAt, "number");
	assert.equal(result.failedAt, undefined);
	assert.deepEqual(
		result.sentences.map((s: { chars: number; ok: boolean }) => [
			s.chars,
			s.ok,
		]),
		[
			[18, true],
			[17, true],
		],
	);
	assert.deepEqual(
		auraCalls.map((call) => plain(call.inputs)),
		[
			{
				text: "The plan is ready.",
				speaker: "orpheus",
				encoding: "linear16",
				container: "none",
				sample_rate: 24_000,
			},
			{
				text: "Two items remain.",
				speaker: "orpheus",
				encoding: "linear16",
				container: "none",
				sample_rate: 24_000,
			},
		],
	);
	// 300 ms preroll, then two 100 ms clips (4,800 bytes each is 100 ms of
	// 24 kHz speech) as 100 ms frames.
	const frames = sent.map((message) => JSON.parse(message));
	assert.equal(frames.length, 3 + 2);
	for (const frame of frames) {
		assert.equal(frame.trigger, "realtime_audio.bot_output");
		assert.equal(frame.data.sample_rate, 24_000);
	}
	await bridge.onClose(bot, 1000, "done");
});

test("say is refused without the service secret, the right content type or a current voice generation", async () => {
	const { bridge, bot } = await connectedMeeting();

	const unauthorized = await bridge.onRequest(
		say(["Hi."], { Authorization: "Bearer wrong" }),
	);
	const wrongType = await bridge.onRequest(
		say(["Hi."], { "content-type": "audio/pcm" }),
	);
	const stale = await bridge.onRequest(say(["Hi."], {}, "7"));

	assert.equal(unauthorized.status, 401);
	assert.equal(wrongType.status, 400);
	assert.equal(stale.status, 200);
	assert.deepEqual(plain(await stale.json()), {
		played: false,
		interrupted: true,
		muted: false,
		heard: 0,
	});
	await bridge.onClose(bot, 1000, "done");
});

test("say before the bot has streamed any meeting audio is refused", async () => {
	const { bridge, bot, auraCalls } = meeting();
	await bridge.onStart();
	await bridge.onConnect(bot, { request: { url: STREAM_URL } });

	const response = await bridge.onRequest(say(["Hi."]));

	assert.equal(response.status, 409);
	assert.equal(auraCalls.length, 0);
	await bridge.onClose(bot, 1000, "done");
});

test("when Aura fails the bridge reports where, so the worker can speak the rest", async () => {
	const { bridge, bot, sent } = await connectedMeeting({
		aura: (_text, index) =>
			index === 1
				? new Response("unavailable", { status: 503 })
				: new Response(new Uint8Array(4_800)),
	});
	const keepAlive = setInterval(() => {}, 1_000);

	const response = await bridge.onRequest(
		say(["First sentence.", "Second sentence.", "Third sentence."]),
	);
	clearInterval(keepAlive);

	assert.equal(response.status, 200);
	const result = plain(await response.json());
	assert.equal(result.played, false);
	assert.equal(result.interrupted, false);
	assert.equal(result.failedAt, 1);
	assert.match(result.error, /HTTP 503/);
	assert.ok(sent.length > 0, "the sentence before the failure was played");
	await bridge.onClose(bot, 1000, "done");
});

test("a failed say leaves the reply pending for the worker's fallback on the same generation", async () => {
	const { bridge, bot } = await connectedMeeting({
		aura: () => new Response("unavailable", { status: 500 }),
	});
	const keepAlive = setInterval(() => {}, 1_000);

	const failed = plain(await (await bridge.onRequest(say(["Hi."]))).json());
	const speech = new Uint8Array(new Int16Array(2_400).fill(1_000).buffer);
	const fallback = await bridge.onRequest(
		new Request(
			"https://bridge.example.com/parties/parlume/session-1?action=speak",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer service-secret",
					"content-type": "audio/pcm",
					"x-parlume-voice-generation": "0",
				},
				body: speech,
			},
		),
	);
	clearInterval(keepAlive);

	assert.equal(failed.failedAt, 0);
	assert.equal(fallback.status, 200);
	assert.equal((await fallback.json()).played, true);
	await bridge.onClose(bot, 1000, "done");
});

test("speech from another participant mid-sentence silences a say reply and ends it as interrupted", async () => {
	const { bridge, bot, flux, sent } = await connectedMeeting({
		aura: () =>
			new Response(
				new ReadableStream<Uint8Array>({
					async start(controller) {
						for (let part = 0; part < 20; part++) {
							controller.enqueue(new Uint8Array(4_800));
							await sleep(40);
						}
						controller.close();
					},
				}),
			),
	});
	const keepAlive = setInterval(() => {}, 1_000);
	await bridge.onRequest(
		control("speakers", {
			updates: [
				{
					name: "Dev One",
					id: "participant-1",
					timestamp: 1_000_005,
					isSpeaking: true,
				},
			],
		}),
	);

	const playing = bridge.onRequest(say(["A rather long sentence."]));
	await sleep(250);
	const framesBefore = sent.length;
	flux.turn({
		event: "Update",
		turn_index: 9,
		audio_window_start: 0.02,
		audio_window_end: 0.05,
		transcript: "wait",
	});
	await flush();
	const response = await playing;
	clearInterval(keepAlive);

	const result = plain(await response.json());
	assert.equal(result.played, false);
	assert.equal(result.interrupted, true);
	assert.equal(result.failedAt, undefined);
	assert.ok(framesBefore > 0, "it was speaking when interrupted");
	assert.ok(sent.length < framesBefore + 6, "playback stopped");
	await bridge.onClose(bot, 1000, "done");
});

test("a chat post the bridge reads aloud itself is reported to Fabric as Aura usage", async () => {
	const { bridge, bot, requests, auraCalls } = await connectedMeeting();
	const keepAlive = setInterval(() => {}, 1_000);
	await bridge.onRequest(control("chat", { message: "Here is F-12." }));

	await bridge.onRequest(
		control("chat-message", {
			id: "msg_1",
			text: "say P1",
			senderName: "Dev One",
			senderId: "participant-1",
			toBot: false,
			timestampMs: null,
		}),
	);
	for (
		let waited = 0;
		waited < 2_000 &&
		!requests.some((r) => r.path.endsWith("/speech-usage"));
		waited += 20
	) {
		await sleep(20);
	}
	clearInterval(keepAlive);

	assert.equal(auraCalls.length, 1);
	const usage = requests.find((r) => r.path.endsWith("/speech-usage"));
	assert.equal(usage?.body.sessionId, "session-1");
	assert.equal(usage?.body.botId, "bot_abc123");
	assert.deepEqual(
		usage?.body.sentences.map((s: { chars: number }) => s.chars),
		[13],
	);
	await bridge.onClose(bot, 1000, "done");
});

test("a spoken reference to a chat post reads it aloud, or asks about it as a spoken request", async () => {
	const { bridge, bot, flux, requests, auraCalls } = await connectedMeeting();
	const keepAlive = setInterval(() => {}, 1_000);
	await bridge.onRequest(control("chat", { message: "Here is F-12." }));

	flux.turn({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.5,
		audio_window_end: 1.5,
		transcript: "Parlume, read P one.",
	});
	for (let waited = 0; waited < 2_000 && !auraCalls.length; waited += 20) {
		await sleep(20);
	}
	assert.deepEqual(
		auraCalls.map((call) => (call.inputs as { text: string }).text),
		["Here is F-12."],
	);

	flux.turn({
		event: "EndOfTurn",
		turn_index: 1,
		audio_window_start: 2,
		audio_window_end: 3.5,
		transcript: "Hey Parlume, tell me more about P1.",
	});
	for (
		let waited = 0;
		waited < 3_000 && !requests.some((r) => r.path.endsWith("/turns"));
		waited += 20
	) {
		await sleep(20);
	}
	clearInterval(keepAlive);

	const turns = requests.filter((r) => r.path.endsWith("/turns"));
	assert.deepEqual(
		turns.map((r) => [r.body.text, r.body.replyChannel]),
		[
			[
				"More detail on what Parlume posted in the meeting chat as P1 (the label of that chat message, not a work item ID): Here is F-12.",
				"VOICE",
			],
		],
	);
	await bridge.onClose(bot, 1000, "done");
});

const generationState = async (bridge: Bridge, voiceGeneration: number) =>
	plain(
		await (
			await bridge.onRequest(
				control("verify-generation", { voiceGeneration }),
			)
		).json(),
	);

test("an acknowledgement over Parlume does not interrupt it", async () => {
	const { bridge, bot, flux, requests } = await answeringMeeting();
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = bridge.onRequest(say(["The plan is ready."], {}, "1"));
	await sleep(250);
	for (const transcript of ["yeah", "mm-hmm", "got it"]) {
		flux.turn({
			event: "Update",
			turn_index: 1,
			audio_window_start: 0.06,
			audio_window_end: 0.08,
			transcript,
		});
		await flush();
	}
	const result = plain(await (await playing).json());
	clearInterval(keepAlive);

	assert.equal(result.played, true);
	assert.equal(result.muted, false);
	assert.equal(
		requests.filter((r) => r.path.endsWith("/interrupt")).length,
		0,
	);
	await bridge.onClose(bot, 1000, "done");
});

test("speech over Parlume mutes the reply but keeps its turn running and answering in the chat", async () => {
	const { bridge, bot, flux, requests } = await answeringMeeting();
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = bridge.onRequest(
		say(["The plan is ready.", "Two items remain."], {}, "1"),
	);
	await sleep(250);
	flux.turn({
		event: "Update",
		turn_index: 1,
		audio_window_start: 0.06,
		audio_window_end: 0.08,
		transcript: "I think we should",
	});
	await flush();
	const result = plain(await (await playing).json());
	const late = plain(
		await (await bridge.onRequest(say(["More."], {}, "1"))).json(),
	);
	clearInterval(keepAlive);

	assert.equal(result.played, false);
	assert.equal(result.interrupted, true);
	assert.equal(result.muted, true);
	assert.equal(result.heard, 0);
	assert.deepEqual(late, {
		played: false,
		interrupted: true,
		muted: true,
		heard: 0,
	});
	assert.deepEqual(
		requests
			.filter((r) => r.path.endsWith("/interrupt"))
			.map((r) => r.body),
		[
			{
				sessionId: "session-1",
				botId: "bot_abc123",
				voiceGeneration: 1,
				kind: "mute",
			},
		],
	);
	assert.deepEqual(await generationState(bridge, 1), {
		current: true,
		muted: true,
		chatAvailable: true,
	});
	await bridge.onClose(bot, 1000, "done");
});

test("a cancel phrase abandons the answer, and is never a request of its own", async () => {
	const { bridge, bot, flux, requests } = await answeringMeeting();

	flux.turn({
		event: "EndOfTurn",
		turn_index: 1,
		audio_window_start: 0.06,
		audio_window_end: 0.08,
		transcript: "Parlume, never mind.",
	});
	for (
		let waited = 0;
		waited < 2_000 && !requests.some((r) => r.path.endsWith("/interrupt"));
		waited += 20
	) {
		await sleep(20);
	}
	await sleep(400);

	assert.deepEqual(
		requests
			.filter((r) => r.path.endsWith("/interrupt"))
			.map((r) => r.body),
		[{ sessionId: "session-1", botId: "bot_abc123", voiceGeneration: 2 }],
	);
	assert.equal(requests.filter((r) => r.path.endsWith("/turns")).length, 1);
	assert.equal((await generationState(bridge, 1)).current, false);
	await bridge.onClose(bot, 1000, "done");
});
