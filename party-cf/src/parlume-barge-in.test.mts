import assert from "node:assert/strict";
import test from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

const stops = loadParlumeModule("./parlume-barge-in.ts", async () =>
	Response.json({}),
) as {
	classifyParlumeStop(text: string, final: boolean): string;
	parlumeRequestAfterStop(text: string): string | null;
	isParlumeEcho(text: string, saying: readonly string[]): boolean;
};
const { classifyParlumeStop, parlumeRequestAfterStop, isParlumeEcho } = stops;

// Every stop phrase Parlume takes once someone addresses it, heard in a
// partial transcript or a final one.
for (const text of [
	"Parlume stop",
	"Parlume, stop.",
	"Fabric, stop.",
	"Fabric stop",
	"stop, Parlume",
	"Parlume, stop talking",
	"Parlume, stop speaking.",
	"Parlume, wait",
	"Parlume, wait, wait.",
	"Parlume, hold on a second.",
	"Hey Parlume, hang on",
	"Hey Fabric, never mind.",
	"Parlume, nevermind!",
	"Parlume, not that",
	"Parlume, cancel that.",
	"Fabric, that's enough.",
	"Parlume, enough",
	"Parlume, be quiet",
	"Parlume, quiet please",
	"Parlume, shut up",
	"Parlume, no, stop it please.",
]) {
	test(`"${text}" stops Parlume, in a partial and in a final`, () => {
		assert.equal(classifyParlumeStop(text, false), "stop");
		assert.equal(classifyParlumeStop(text, true), "stop");
		assert.equal(parlumeRequestAfterStop(text), null);
	});
}

// Without the name, only a strong stop that is the whole utterance counts,
// and only once Flux has made it final.
for (const text of [
	"stop",
	"Stop.",
	"stop talking",
	"Stop speaking.",
	"please stop",
	"Please, stop!",
	"okay stop",
	"Okay, stop.",
	"OK stop please",
]) {
	test(`"${text}" without the name stops Parlume in a final only`, () => {
		assert.equal(classifyParlumeStop(text, true), "stop");
		assert.equal(classifyParlumeStop(text, false), "none");
	});
}

// Side talk: stop words said to someone else, or in a sentence of their own.
for (const text of [
	"wait",
	"Wait, wait.",
	"hold on",
	"Hold on a second.",
	"hang on",
	"never mind",
	"cancel",
	"Cancel that.",
	"not that",
	"that's enough",
	"enough",
	"be quiet",
	"stop the deploy",
	"Stop the deploy before Friday.",
	"wait for the numbers",
	"stop sharing your screen",
	"I said stop.",
	"Don't stop now.",
]) {
	test(`"${text}" without the name does not stop Parlume`, () => {
		assert.equal(classifyParlumeStop(text, true), "none");
		assert.equal(classifyParlumeStop(text, false), "none");
	});
}

// Talk over Parlume that is not a stop, addressed to it or not.
for (const text of [
	"",
	"yeah",
	"Okay!",
	"mm-hmm",
	"Got it, thanks.",
	"Thanks, Parlume.",
	"I think we should",
	"Yeah, but what about the release?",
	"Actually I meant the release plan",
	"Hey Fabric",
	"Hey Fabric, what is the plan?",
	"Parlume, stop the deploy.",
	"Parlume, wait for the numbers",
	"Fabric, stop sharing the screen.",
]) {
	test(`"${text}" is not a stop`, () => {
		assert.equal(classifyParlumeStop(text, true), "none");
		assert.equal(classifyParlumeStop(text, false), "none");
	});
}

// A pause stops Parlume listening, which is not a stop of its answer.
for (const text of [
	"Parlume, pause",
	"Parlume, pause.",
	"Hey Fabric, stop listening.",
	"Parlume, please stop listening",
]) {
	test(`"${text}" is a pause, not a stop`, () => {
		assert.equal(classifyParlumeStop(text, true), "none");
		assert.equal(classifyParlumeStop(text, false), "none");
	});
}

for (const { text, request } of [
	{ text: "Parlume, stop. What is next?", request: /^What is next\??$/ },
	{
		text: "Hey Fabric, never mind, what is the plan for Friday?",
		request: /^what is the plan for Friday\??$/,
	},
	{
		text: "Parlume, wait. Read the release note.",
		request: /^Read the release note\.?$/,
	},
]) {
	test(`"${text}" stops Parlume and then asks it something`, () => {
		assert.equal(classifyParlumeStop(text, true), "stop-then-request");
		assert.equal(classifyParlumeStop(text, false), "stop-then-request");
		assert.match(parlumeRequestAfterStop(text) ?? "", request);
	});
}

test("words that are not addressed to Parlume ask it nothing after a stop", () => {
	assert.equal(parlumeRequestAfterStop("Stop. What is next?"), null);
	assert.equal(parlumeRequestAfterStop("what is the plan?"), null);
});

const saying = ["The plan is ready.", "Two features remain open for Friday."];

for (const text of [
	"the plan is",
	"The plan is ready.",
	"features remain open",
	"Two features remain open for Friday",
]) {
	test(`"${text}" is Parlume's own sentence heard back`, () => {
		assert.equal(isParlumeEcho(text, saying), true);
	});
}

for (const { text, current } of [
	{ text: "stop", current: ["Stop the deploy before Friday."] },
	{ text: "Parlume, stop.", current: saying },
	{ text: "the plan for Friday", current: saying },
	{ text: "the plan is", current: [] },
]) {
	test(`"${text}" is not Parlume's own sentence heard back`, () => {
		assert.equal(isParlumeEcho(text, current), false);
	});
}
