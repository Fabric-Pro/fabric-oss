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
