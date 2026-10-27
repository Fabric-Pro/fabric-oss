import assert from "node:assert/strict";
import test from "node:test";
import {
	parseParlumeSpokenReference,
	parseParlumeWake,
} from "./parlume-wake.ts";

test("a spoken request can name a chat post however speech recognition writes the tag", () => {
	const parse = parseParlumeSpokenReference;
	assert.deepEqual(parse("go P3"), { kind: "go", tag: "P3" });
	assert.deepEqual(parse("Go ahead with P 3."), { kind: "go", tag: "P3" });
	assert.deepEqual(parse("read P. 12"), { kind: "say", tag: "P12" });
	assert.deepEqual(parse("say pee three"), { kind: "say", tag: "P3" });
	assert.deepEqual(parse("more on P3?"), { kind: "more", tag: "P3" });
	assert.deepEqual(parse("Tell me more about P-four"), {
		kind: "more",
		tag: "P4",
	});
	assert.equal(parse("go to the release plan"), null);
	assert.equal(parse("say P zero"), null);
	assert.equal(parse("what does P3 mean for the release?"), null);
});

test("an opening name before a chat post command wakes without punctuation", () => {
	assert.equal(parseParlumeWake("Parlume read p one"), "read p one");
	assert.equal(parseParlumeWake("Fabric go P3"), "go P3");
	assert.equal(parseParlumeWake("Parlume is slow today"), null);
	assert.equal(parseParlumeWake("Fabric read the spec"), null);
});

test("an opening Parlume wakes without punctuation unless the sentence describes it", () => {
	// Verbatim from a staging transcript on 2026-10-24.
	assert.equal(
		parseParlumeWake("Parlume post the list of open features to the chat."),
		"post the list of open features to the chat.",
	);
	assert.equal(
		parseParlumeWake("Parlume did you hear that?"),
		"did you hear that?",
	);
	for (const text of [
		"Parlume is slow today.",
		"Parlume said it twice.",
		"Parlume answered too early.",
		"Parlume's answers are long.",
		"Parlume and Fabric are the same thing.",
		"Fabric post the list.",
	]) {
		assert.equal(parseParlumeWake(text), null, text);
	}
});

for (const phrase of ["Hey Fabric", "Hey Parlume", "Hey Fabric Parlume"]) {
	test(`${phrase} removes the complete wake phrase from a request`, () => {
		assert.equal(
			parseParlumeWake(`${phrase}, summarize the meeting.`),
			"summarize the meeting.",
		);
		assert.equal(
			parseParlumeWake(`${phrase.toUpperCase()}! Confirm.`),
			"Confirm.",
		);
		assert.equal(parseParlumeWake(`Okay, ${phrase}: cancel.`), "cancel.");
	});

	test(`${phrase} can arm a request in the following segment`, () => {
		assert.equal(parseParlumeWake(phrase), "");
		assert.equal(parseParlumeWake(`${phrase}.`), "");
	});
}

test("accepts transcription punctuation after hey and variable spacing", () => {
	assert.equal(
		parseParlumeWake("Hey, Fabric Parlume, summarize."),
		"summarize.",
	);
	assert.equal(parseParlumeWake("hey   parlume — summarize."), "summarize.");
});

test("accepts the spellings live transcription produces for the names", () => {
	for (const text of [
		"Hey Fabrik, what is the name of the project?",
		"Hey Fabrique, what is the name of the project?",
		"Hey Fabrick what is the name of the project?",
		"Hey Parlum, what is the name of the project?",
		"Hey Parloom, what is the name of the project?",
		"Hey Fabrik Parlum, what is the name of the project?",
		// Verbatim from staging transcripts on 2026-10-01.
		"Hey, Perlman, what is the name of the project?",
		"Hey Pearlman, what is the name of the project?",
		"Hi Fabric, what is the name of the project?",
	]) {
		assert.equal(
			parseParlumeWake(text),
			"what is the name of the project?",
		);
	}
});

test("does not wake for partial words or ordinary mentions", () => {
	for (const text of [
		"Hey Fabrication",
		"Hey Parlumex",
		"They Fabric",
		"Fabric Parlume",
		"Please summarize.",
		"Hey Parliament, order please.",
		"Hey, problem with the build.",
		"Hey team, what is the name of the project?",
		"Hi everyone.",
		"Fabric is slow today.",
		"Fabric's roadmap looks fine.",
		"Efficient, as always.",
		"Use Fabric, it works.",
	]) {
		assert.equal(parseParlumeWake(text), null);
	}
});

test("wakes for the name opening a turn as an address", () => {
	assert.equal(
		parseParlumeWake("Fabric, what is the name of the project?"),
		"what is the name of the project?",
	);
	assert.equal(parseParlumeWake("Parlume: summarize."), "summarize.");
	assert.equal(parseParlumeWake("Fabric Parlume, summarize."), "summarize.");
	// A lone address arms the speaker's next segment.
	assert.equal(parseParlumeWake("Fabric."), "");
});

test("wakes when transcription hears the greeting as another short word", () => {
	// Verbatim from a staging transcript on 2026-10-26.
	assert.equal(
		parseParlumeWake(
			"A Parlume: How many open features does this project have?",
		),
		"How many open features does this project have?",
	);
	assert.equal(parseParlumeWake("Eh, Fabric, summarize."), "summarize.");
	assert.equal(parseParlumeWake("Uh Parlume read P one."), "read P one.");
	for (const text of [
		"A fabric issue came up.",
		"Uh, Fabric is slow today.",
		"A Parlume is a voice agent.",
	]) {
		assert.equal(parseParlumeWake(text), null);
	}
});

test("wakes when transcription fuses the greeting onto the name", () => {
	// Verbatim from a staging transcript on 2026-10-14.
	assert.equal(
		parseParlumeWake("Efabric described this project in three sentences."),
		"described this project in three sentences.",
	);
	assert.equal(parseParlumeWake("Heyfabric, summarize."), "summarize.");
});
