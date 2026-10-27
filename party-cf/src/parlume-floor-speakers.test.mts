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

const interrupts = (harness: Awaited<ReturnType<typeof askedByDevOne>>) =>
	harness.requests
		.filter((r) => r.path.endsWith("/interrupt"))
		.map((r) => r.body);

test("others talking over Parlume's answer, even saying stop, do not interrupt it", async () => {
	const harness = await askedByDevOne();
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = harness.bridge.onRequest(
		say(["The plan is ready."], {}, "1"),
	);
	await sleep(250);
	harness.flux.turn({
		event: "Update",
		turn_index: 1,
		audio_window_start: 2.2,
		audio_window_end: 2.8,
		transcript: "I think we should ship it",
	});
	await flush();
	harness.flux.turn({
		event: "EndOfTurn",
		turn_index: 1,
		audio_window_start: 3,
		audio_window_end: 3.4,
		transcript: "Stop.",
	});
	await flush();
	const result = plain(await (await playing).json());
	clearInterval(keepAlive);

	assert.equal(result.played, true);
	assert.equal(result.muted, false);
	assert.deepEqual(interrupts(harness), []);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("speech nobody has been named for yet does not interrupt it", async () => {
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
	harness.flux.turn({
		event: "Update",
		turn_index: 1,
		audio_window_start: 20,
		audio_window_end: 21,
		transcript: "I think we should move the release",
	});
	await flush();
	const result = plain(await (await playing).json());
	clearInterval(keepAlive);

	assert.equal(result.played, true);
	assert.deepEqual(interrupts(harness), []);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("the person Parlume is answering can still talk over it, once their words are final", async () => {
	const harness = await askedByDevOne();
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = harness.bridge.onRequest(
		say(["The plan is ready."], {}, "1"),
	);
	await sleep(250);
	// A partial is not trusted to be theirs: Teams names speakers late.
	harness.flux.turn({
		event: "Update",
		turn_index: 1,
		audio_window_start: 4.2,
		audio_window_end: 4.8,
		transcript: "Actually I meant the release plan",
	});
	await flush();
	assert.deepEqual(interrupts(harness), []);
	harness.flux.turn({
		event: "EndOfTurn",
		turn_index: 1,
		audio_window_start: 4.2,
		audio_window_end: 4.9,
		transcript: "Actually I meant the release plan",
	});
	await flush();
	const result = plain(await (await playing).json());
	clearInterval(keepAlive);

	assert.equal(result.muted, true);
	assert.deepEqual(interrupts(harness), [
		{
			sessionId: "session-1",
			botId: "bot_abc123",
			voiceGeneration: 1,
			kind: "mute",
		},
	]);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("anyone who addresses Parlume can still stop its answer", async () => {
	const harness = await askedByDevOne();

	harness.flux.turn({
		event: "EndOfTurn",
		turn_index: 1,
		audio_window_start: 2.2,
		audio_window_end: 3,
		transcript: "Parlume, never mind.",
	});
	for (
		let waited = 0;
		waited < 2_000 && interrupts(harness).length === 0;
		waited += 20
	) {
		await sleep(20);
	}

	assert.deepEqual(interrupts(harness), [
		{ sessionId: "session-1", botId: "bot_abc123", voiceGeneration: 2 },
	]);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});
