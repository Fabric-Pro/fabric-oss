import assert from "node:assert/strict";
import test from "node:test";
import { parseParlumeWake } from "./parlume-wake.ts";

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

test("does not wake for partial words or ordinary mentions", () => {
	for (const text of [
		"Hey Fabrication",
		"Hey Parlumex",
		"They Fabric",
		"Fabric Parlume",
		"Please summarize.",
	]) {
		assert.equal(parseParlumeWake(text), null);
	}
});
