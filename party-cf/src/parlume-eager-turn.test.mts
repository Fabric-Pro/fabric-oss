import assert from "node:assert/strict";
import test from "node:test";
import { connectedMeeting, flush, sleep } from "./parlume-meeting-harness.mts";

const request = "Hey Fabric, what is the plan?";

async function settle() {
	await sleep(20);
	await flush();
}

async function heard(
	harness: Awaited<ReturnType<typeof connectedMeeting>>,
	event: string,
	transcript: string,
) {
	harness.flux.turn({
		event,
		turn_index: 0,
		audio_window_start: 0.01,
		audio_window_end: 0.05,
		transcript,
	});
	await settle();
}

const turns = (harness: Awaited<ReturnType<typeof connectedMeeting>>) =>
	harness.requests.filter((r) => r.path.endsWith("/turns"));
const interrupts = (harness: Awaited<ReturnType<typeof connectedMeeting>>) =>
	harness.requests.filter((r) => r.path.endsWith("/interrupt"));

test("a request starts on Flux's early end-of-turn and is not started again by its final transcript", async () => {
	const harness = await connectedMeeting();
	await heard(harness, "EagerEndOfTurn", request);
	assert.equal(turns(harness).length, 1);
	assert.equal(turns(harness)[0]?.body.text, "what is the plan?");

	await heard(harness, "EndOfTurn", "Hey Fabric what is the plan");
	assert.equal(turns(harness).length, 1);
	assert.equal(interrupts(harness).length, 0);
	assert.ok(
		harness.requests.some(
			(r) => r.path.endsWith("/segments") || r.path.endsWith("/segment"),
		),
		"the final transcript is still kept as a meeting segment",
	);
});

test("a guess Flux takes back stops the early request, and the final one is asked instead", async () => {
	const harness = await connectedMeeting();
	await heard(harness, "EagerEndOfTurn", request);
	const early = turns(harness)[0];
	await heard(harness, "TurnResumed", "");
	assert.equal(interrupts(harness).length, 1);

	await heard(
		harness,
		"EndOfTurn",
		"Hey Fabric, what is the plan for the release?",
	);
	assert.equal(turns(harness).length, 2);
	assert.equal(
		turns(harness)[1]?.body.text,
		"what is the plan for the release?",
	);
	assert.ok(
		Number(turns(harness)[1]?.body.voiceGeneration) >
			Number(early?.body.voiceGeneration),
	);
});

test("a final transcript that differs from the early one replaces its request", async () => {
	const harness = await connectedMeeting();
	await heard(harness, "EagerEndOfTurn", request);
	await heard(harness, "EndOfTurn", "Hey Fabric, what is the plan today?");
	assert.equal(interrupts(harness).length, 1);
	assert.deepEqual(
		turns(harness).map((turn) => turn.body.text),
		["what is the plan?", "what is the plan today?"],
	);
});

test("a cancel phrase with nothing to cancel never starts an early request", async () => {
	const harness = await connectedMeeting();
	await heard(harness, "EagerEndOfTurn", "Parlume, stop.");
	await heard(harness, "EndOfTurn", "Parlume, stop.");
	assert.equal(turns(harness).length, 0);
});

test("chat post commands and dictation wait for the final transcript", async () => {
	const harness = await connectedMeeting();
	await heard(harness, "EagerEndOfTurn", "Hey Fabric, go P1");
	await heard(harness, "EagerEndOfTurn", "Hey Fabric, write in the chat");
	assert.equal(turns(harness).length, 0);
});

test("a request is handed to Fabric without waiting for the transcript segments still being posted", async () => {
	let releaseSegments = () => {};
	const segmentsHeld = new Promise<void>((resolve) => {
		releaseSegments = resolve;
	});
	const harness = await connectedMeeting({
		fabricDelay: (path) =>
			path.endsWith("/segments") ? segmentsHeld : Promise.resolve(),
	});
	await heard(harness, "EndOfTurn", "Hey Fabric, what is the plan?");
	assert.equal(turns(harness).length, 1);
	releaseSegments();
});

test("an early end-of-turn without a wake phrase starts nothing", async () => {
	const harness = await connectedMeeting();
	await heard(harness, "EagerEndOfTurn", "what is the plan?");
	await heard(harness, "EndOfTurn", "what is the plan?");
	assert.equal(turns(harness).length, 0);
});
