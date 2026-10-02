import assert from "node:assert/strict";
import test from "node:test";
import { ParlumeSpeakerTimeline } from "./parlume-speakers.ts";

const at = (
	name: string,
	id: number,
	timestamp: number,
	isSpeaking: boolean,
) => ({
	name,
	id: String(id),
	timestamp,
	isSpeaking,
});

test("a turn belongs to the participant who spoke longest during it", () => {
	const timeline = new ParlumeSpeakerTimeline();
	timeline.update([at("Dev One", 1, 10_000, true)]);
	timeline.update([
		at("Dev One", 1, 11_000, false),
		at("Dev Two", 2, 11_000, true),
	]);
	timeline.update([at("Dev Two", 2, 15_000, false)]);

	assert.deepEqual(timeline.attribute(11_200, 14_800), {
		name: "Dev Two",
		id: "2",
	});
	assert.deepEqual(timeline.attribute(9_000, 10_900), {
		name: "Dev One",
		id: "1",
	});
});

test("a speaker still talking counts until now", () => {
	const timeline = new ParlumeSpeakerTimeline();
	timeline.update([at("Dev One", 1, 10_000, true)]);
	assert.deepEqual(timeline.attribute(12_000, 13_000), {
		name: "Dev One",
		id: "1",
	});
});

test("a short turn between updates goes to whoever last started speaking", () => {
	const timeline = new ParlumeSpeakerTimeline();
	timeline.update([at("Dev One", 1, 10_000, true)]);
	timeline.update([at("Dev One", 1, 10_400, false)]);
	assert.deepEqual(timeline.attribute(13_000, 13_300), {
		name: "Dev One",
		id: "1",
	});
	// Too long after anyone spoke, the speaker is unknown.
	assert.equal(timeline.attribute(40_000, 40_500), null);
});

test("Parlume's own speech is attributed to it, so it never interrupts itself", () => {
	const timeline = new ParlumeSpeakerTimeline();
	timeline.update([at("Dev One", 1, 10_000, true)]);
	timeline.update([at("Dev One", 1, 11_000, false)]);
	timeline.update([at("Fabric Parlume", 2, 12_000, true)]);
	assert.equal(timeline.attribute(12_100, 14_000)?.name, "Fabric Parlume");
});
