import assert from "node:assert/strict";
import test from "node:test";
import {
	connectedMeeting,
	control,
	flush,
	plain,
	say,
	sleep,
	slowAura,
} from "./parlume-meeting-harness.mts";

// Dev One asks in the first two seconds of audio, Dev Two talks from the
// second to the fourth, and Dev One speaks again after that.
async function askedByDevOne() {
	const harness = await connectedMeeting({ aura: slowAura });
	await harness.bridge.onRequest(
		control("speakers", {
			updates: [
				{
					name: "Dev One",
					id: "participant-1",
					timestamp: 1_000_000,
					isSpeaking: true,
				},
				{
					name: "Dev One",
					id: "participant-1",
					timestamp: 1_002_000,
					isSpeaking: false,
				},
				{
					name: "Dev Two",
					id: "participant-2",
					timestamp: 1_002_000,
					isSpeaking: true,
				},
				{
					name: "Dev Two",
					id: "participant-2",
					timestamp: 1_004_000,
					isSpeaking: false,
				},
				{
					name: "Dev One",
					id: "participant-1",
					timestamp: 1_004_000,
					isSpeaking: true,
				},
			],
		}),
	);
	harness.flux.turn({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript: "Hey Fabric, what is the plan?",
	});
	for (
		let waited = 0;
		waited < 2_000 &&
		!harness.requests.some((r) => r.path.endsWith("/turns"));
		waited += 20
	) {
		await sleep(20);
	}
	assert.equal(
		harness.requests.find((r) => r.path.endsWith("/turns"))?.body.speakerId,
		"participant-1",
	);
	return harness;
}

type Harness = Awaited<ReturnType<typeof askedByDevOne>>;

const interrupts = (harness: Harness) =>
	harness.requests
		.filter((r) => r.path.endsWith("/interrupt"))
		.map((r) => r.body);

function heard(
	harness: Harness,
	event: "Update" | "EndOfTurn",
	window: [number, number],
	transcript: string,
) {
	harness.flux.turn({
		event,
		turn_index: 1,
		audio_window_start: window[0],
		audio_window_end: window[1],
		transcript,
	});
}

async function waitForInterrupt(harness: Harness) {
	for (
		let waited = 0;
		waited < 2_000 && interrupts(harness).length === 0;
		waited += 20
	) {
		await sleep(20);
	}
}

const frames = (harness: Harness) =>
	harness.sent.filter((message) =>
		message.includes('"realtime_audio.bot_output"'),
	).length;

/** Frames the bot got over the next 300 ms: three or more while it speaks. */
async function framesOver300Ms(harness: Harness): Promise<number> {
	const before = frames(harness);
	await sleep(300);
	return frames(harness) - before;
}

test("others talking over Parlume's answer do not stop it", async () => {
	const harness = await askedByDevOne();
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = harness.bridge.onRequest(
		say(["The plan is ready."], {}, "1"),
	);
	await sleep(250);
	heard(harness, "Update", [2.2, 2.8], "I think we should ship it");
	await flush();
	heard(
		harness,
		"EndOfTurn",
		[2.2, 3.4],
		"I think we should ship it Friday.",
	);
	await flush();
	const result = plain(await (await playing).json());
	clearInterval(keepAlive);

	assert.equal(result.played, true);
	assert.deepEqual(interrupts(harness), []);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("speech nobody has been named for yet does not stop it", async () => {
	const harness = await askedByDevOne();
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = harness.bridge.onRequest(
		say(["The plan is ready."], {}, "1"),
	);
	await sleep(250);
	// Dev One stopped being reported at four seconds; Teams has not yet said
	// who speaks at twenty.
	await harness.bridge.onRequest(
		control("speakers", {
			updates: [
				{
					name: "Dev One",
					id: "participant-1",
					timestamp: 1_004_500,
					isSpeaking: false,
				},
			],
		}),
	);
	heard(harness, "Update", [20, 21], "I think we should move the release");
	await flush();
	const result = plain(await (await playing).json());
	clearInterval(keepAlive);

	assert.equal(result.played, true);
	assert.deepEqual(interrupts(harness), []);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("the person Parlume is answering does not stop it by talking over it", async () => {
	const harness = await askedByDevOne();
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = harness.bridge.onRequest(
		say(["The plan is ready."], {}, "1"),
	);
	await sleep(250);
	heard(harness, "Update", [4.2, 4.8], "Actually I meant the release plan");
	await flush();
	assert.ok((await framesOver300Ms(harness)) >= 2, "the voice goes on");
	heard(
		harness,
		"EndOfTurn",
		[4.2, 4.9],
		"Actually I meant the release plan",
	);
	await flush();
	const result = plain(await (await playing).json());
	clearInterval(keepAlive);

	assert.equal(result.played, true);
	assert.deepEqual(interrupts(harness), []);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("anyone who addresses Parlume with a stop ends its answer, as a stop by voice named after them", async () => {
	const harness = await askedByDevOne();

	heard(harness, "EndOfTurn", [2.2, 3], "Parlume, never mind.");
	await waitForInterrupt(harness);

	assert.deepEqual(interrupts(harness), [
		{
			sessionId: "session-1",
			botId: "bot_abc123",
			voiceGeneration: 2,
			stop: { cause: "VOICE", by: "Dev Two" },
		},
	]);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

// Without its name, only a strong stop said as the whole utterance counts,
// and from anyone: Teams names speakers late, often as nobody.
for (const { name, window, transcript, by } of [
	{
		name: "a final bare 'stop' from someone who did not ask",
		window: [3, 3.4] as [number, number],
		transcript: "Stop.",
		by: "Dev Two",
	},
	{
		name: "a final 'okay stop' from someone who did not ask",
		window: [3, 3.4] as [number, number],
		transcript: "Okay, stop.",
		by: "Dev Two",
	},
	{
		name: "a final bare 'stop' from a speaker nobody named",
		window: [20, 20.4] as [number, number],
		transcript: "Stop talking.",
		by: null,
	},
]) {
	test(`${name} stops the answer`, async () => {
		const harness = await askedByDevOne();
		const keepAlive = setInterval(() => {}, 1_000);
		await harness.bridge.onRequest(
			control("speakers", {
				updates: [
					{
						name: "Dev One",
						id: "participant-1",
						timestamp: 1_004_500,
						isSpeaking: false,
					},
				],
			}),
		);

		const playing = harness.bridge.onRequest(
			say(["The plan is ready."], {}, "1"),
		);
		await sleep(250);
		heard(harness, "EndOfTurn", window, transcript);
		const result = plain(await (await playing).json());
		await waitForInterrupt(harness);
		clearInterval(keepAlive);

		assert.equal(result.played, false);
		assert.equal(result.interrupted, true);
		assert.deepEqual(interrupts(harness), [
			{
				sessionId: "session-1",
				botId: "bot_abc123",
				voiceGeneration: 2,
				stop: { cause: "VOICE", by },
			},
		]);
		await harness.bridge.onClose(harness.bot, 1000, "done");
	});
}

test("a bare 'stop' in a partial does not hold Parlume, and side talk that only says it stops nothing", async () => {
	const harness = await askedByDevOne();
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = harness.bridge.onRequest(
		say(["The plan is ready."], {}, "1"),
	);
	await sleep(250);
	heard(harness, "Update", [2.2, 2.6], "stop");
	await flush();
	assert.ok((await framesOver300Ms(harness)) >= 2, "the voice goes on");
	heard(harness, "EndOfTurn", [2.2, 3], "stop the deploy before Friday");
	await flush();
	const result = plain(await (await playing).json());
	clearInterval(keepAlive);

	assert.equal(result.played, true);
	assert.deepEqual(interrupts(harness), []);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a stop that names Parlume holds it within a tick of its partial, and a final that is not a stop lets the same speech go on", async () => {
	const harness = await askedByDevOne();
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = harness.bridge.onRequest(
		say(["The plan is ready."], {}, "1"),
	);
	await sleep(250);
	heard(harness, "Update", [2.2, 2.6], "Parlume, stop");
	await flush();
	assert.equal(await framesOver300Ms(harness), 0, "held at once");
	// Flux heard the words again, and they were not a stop to Parlume.
	heard(harness, "EndOfTurn", [2.2, 3], "Sam, stop the deploy.");
	await flush();
	assert.ok((await framesOver300Ms(harness)) >= 2, "the speech goes on");
	const result = plain(await (await playing).json());
	clearInterval(keepAlive);

	assert.equal(result.played, true);
	assert.equal(result.heard, 1);
	assert.deepEqual(interrupts(harness), []);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a stop that names Parlume, held on its partial, ends the answer on its final", async () => {
	const harness = await askedByDevOne();
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = harness.bridge.onRequest(
		say(["The plan is ready."], {}, "1"),
	);
	await sleep(250);
	heard(harness, "Update", [2.2, 2.6], "Parlume, stop");
	await flush();
	assert.equal(await framesOver300Ms(harness), 0, "held at once");
	heard(harness, "EndOfTurn", [2.2, 3], "Parlume, stop.");
	const result = plain(await (await playing).json());
	await waitForInterrupt(harness);
	clearInterval(keepAlive);

	assert.equal(result.played, false);
	assert.deepEqual(interrupts(harness), [
		{
			sessionId: "session-1",
			botId: "bot_abc123",
			voiceGeneration: 2,
			stop: { cause: "VOICE", by: "Dev Two" },
		},
	]);
	const stopped = harness.logs.find(
		(entry) =>
			entry.message === "[Parlume] speech.stopped" &&
			entry.meta.cause === "voice",
	);
	assert.equal(stopped?.meta.confirmed, true);
	assert.equal(typeof stopped?.meta.detectMs, "number");
	await harness.bridge.onClose(harness.bot, 1000, "done");
});
