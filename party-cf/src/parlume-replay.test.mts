import assert from "node:assert/strict";
import test from "node:test";
import { readReplayFixture, replayMeeting } from "./parlume-replay.mts";

const fixture = (name: string) =>
	readReplayFixture(
		new URL(`./fixtures/parlume-replay/${name}.json`, import.meta.url),
	);

// Recorded from real Flux: QA Example asks while Dev Example is finishing,
// and Flux hears both as one turn, with "Parlume" in the middle of it. Flux
// wrote F-12 as "f twelve", which the fixture's question expects.
test("a question asked over the end of another participant's sentence wakes Parlume for the one who asked, though Flux hears one turn", async () => {
	const recorded = fixture("two-speakers");
	const final = recorded.flux
		.filter(({ event }) => event.event === "EndOfTurn")
		.at(-1)?.event.transcript;
	assert.match(String(final), /call it done\. Parlume, what is the status/);

	const scorecard = await replayMeeting(recorded);

	assert.equal(scorecard.wakes, 1);
	assert.equal(scorecard.questions[0]?.speaker, "QA Example");
	assert.equal(
		scorecard.questions[0]?.text,
		"what is the status of f twelve?",
	);
	assert.equal(scorecard.questions[0]?.heardRight, true);
	assert.deepEqual(scorecard.falseWakes, []);
	assert.deepEqual(scorecard.missed, []);
	assert.equal(scorecard.interrupts, 0);
});

test("Parlume's own voice partway through another participant's turn does not wake it", async () => {
	const recorded = fixture("two-speakers");
	const scorecard = await replayMeeting({
		...recorded,
		speech: recorded.speech.map((update) =>
			update.name === "QA Example"
				? { ...update, name: "Fabric Parlume" }
				: update,
		),
		questions: [],
	});

	assert.equal(scorecard.wakes, 0);
	assert.equal(scorecard.interrupts, 0);
});

test("a question Flux hears as its own turn wakes Parlume once, for the one who asked", async () => {
	const scorecard = await replayMeeting(fixture("two-speakers-split-turns"));

	assert.equal(scorecard.wakes, 1);
	assert.equal(scorecard.questions[0]?.speaker, "QA Example");
	assert.match(scorecard.questions[0]?.text ?? "", /F-12/);
	assert.equal(scorecard.questions[0]?.heardRight, true);
	assert.deepEqual(scorecard.falseWakes, []);
	assert.deepEqual(scorecard.missed, []);
	assert.equal(
		scorecard.questions.some(
			(question) => question.speaker === "Dev Example",
		),
		false,
	);
	// It started on Flux's early end-of-turn, which the final one kept.
	assert.equal(scorecard.questions[0]?.trigger, "EagerEndOfTurn");
	assert.equal(scorecard.interrupts, 0);
});

// Parlume's speech plays in real time, so these replay slower: its 300 ms of
// lead-in silence is 1.2 s of meeting time.
const SPEAKING_SPEED = 4;

test("side talk over Parlume's answer, its requester's included, never stops it", async () => {
	const scorecard = await replayMeeting(fixture("side-talk-over-answer"), {
		speed: SPEAKING_SPEED,
	});

	assert.equal(scorecard.wakes, 1);
	assert.deepEqual(scorecard.falseWakes, []);
	assert.deepEqual(scorecard.replies, [{ played: true, interrupted: false }]);
	assert.deepEqual(scorecard.stops, []);
	assert.deepEqual(scorecard.falseStops, []);
	assert.equal(scorecard.holds, 0);
	assert.equal(scorecard.interrupts, 0);
});

test("a request made while Parlume answers another is asked of Fabric after that answer, and stops nothing", async () => {
	const scorecard = await replayMeeting(fixture("two-requests-overlap"), {
		speed: SPEAKING_SPEED,
	});

	assert.equal(scorecard.wakes, 2);
	assert.deepEqual(
		scorecard.questions.map(({ speaker, heardRight }) => ({
			speaker,
			heardRight,
		})),
		[
			{ speaker: "Dev Example", heardRight: true },
			{ speaker: "QA Example", heardRight: true },
		],
	);
	assert.deepEqual(scorecard.falseWakes, []);
	assert.deepEqual(scorecard.missed, []);
	assert.deepEqual(scorecard.replies, [
		{ played: true, interrupted: false },
		{ played: true, interrupted: false },
	]);
	assert.equal(scorecard.interrupts, 0);
});

test("'wait' and 'hold on' said to the room, without Parlume's name, leave its answer playing", async () => {
	const scorecard = await replayMeeting(fixture("wait-in-side-talk"), {
		speed: SPEAKING_SPEED,
	});

	assert.equal(scorecard.wakes, 1);
	assert.deepEqual(scorecard.replies, [{ played: true, interrupted: false }]);
	assert.deepEqual(scorecard.falseStops, []);
	assert.equal(scorecard.holds, 0);
	assert.equal(scorecard.interrupts, 0);
});

test("'Parlume, stop' from someone who did not ask holds the answer on its partial and stops it on its final, and is not asked as a request", async () => {
	const scorecard = await replayMeeting(fixture("addressed-stop"), {
		speed: SPEAKING_SPEED,
	});

	assert.equal(scorecard.wakes, 1);
	assert.deepEqual(scorecard.replies, [{ played: false, interrupted: true }]);
	assert.deepEqual(scorecard.stops, [{ by: "QA Example" }]);
	assert.deepEqual(scorecard.falseStops, []);
	assert.deepEqual(scorecard.missedStops, []);
	assert.equal(scorecard.holds, 1);
});

test("a bare 'Stop.' from someone who did not ask stops the answer on its final, and its partial holds nothing", async () => {
	const scorecard = await replayMeeting(fixture("bare-stop-other-speaker"), {
		speed: SPEAKING_SPEED,
	});

	assert.equal(scorecard.wakes, 1);
	assert.deepEqual(scorecard.replies, [{ played: false, interrupted: true }]);
	assert.deepEqual(scorecard.stops, [{ by: "QA Example" }]);
	assert.deepEqual(scorecard.falseStops, []);
	assert.deepEqual(scorecard.missedStops, []);
	assert.equal(scorecard.holds, 0);
});

test("a bare 'Stop.' from a speaker the meeting never names stops the answer too", async () => {
	const recorded = fixture("bare-stop-other-speaker");
	const scorecard = await replayMeeting(
		{
			...recorded,
			speech: [],
			questions: [],
			stops: [{ speaker: null }],
		},
		{ speed: SPEAKING_SPEED },
	);

	assert.deepEqual(scorecard.replies, [{ played: false, interrupted: true }]);
	assert.deepEqual(scorecard.stops, [{ by: null }]);
	assert.deepEqual(scorecard.falseStops, []);
	assert.deepEqual(scorecard.missedStops, []);
});
