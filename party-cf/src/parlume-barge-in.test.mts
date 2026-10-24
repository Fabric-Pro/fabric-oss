import assert from "node:assert/strict";
import test from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

const { classifyParlumeBargeIn } = loadParlumeModule(
	"./parlume-barge-in.ts",
	async () => Response.json({}),
) as { classifyParlumeBargeIn(text: string): string };

for (const text of [
	"yeah",
	"Yeah.",
	"ok",
	"Okay!",
	"mm-hmm",
	"Mm hmm.",
	"uh-huh",
	"right, right",
	"Got it, thanks.",
	"I see.",
	"Nice, great.",
	"Sure, cool.",
	"thank you",
	"Thanks, Parlume.",
	"Makes sense.",
	"Actually",
	"",
]) {
	test(`"${text}" does not interrupt Parlume`, () => {
		assert.equal(classifyParlumeBargeIn(text), "ignore");
	});
}

for (const text of [
	"stop",
	"Stop.",
	"cancel",
	"Cancel that.",
	"never mind",
	"Nevermind!",
	"not that",
	"hold on",
	"Hold on a second.",
	"wait",
	"Wait, wait.",
	"No, stop it please.",
	"Parlume stop",
	"Fabric, stop.",
	"Hey Fabric, never mind.",
	"stop, Parlume",
]) {
	test(`"${text}" cancels the answer`, () => {
		assert.equal(classifyParlumeBargeIn(text), "cancel");
	});
}

for (const text of [
	"I think we should",
	"Yeah, but what about the release?",
	"stop sharing your screen",
	"wait for the build",
	"Hey Fabric",
	"okay so the next item",
]) {
	test(`"${text}" is speech over Parlume`, () => {
		assert.equal(classifyParlumeBargeIn(text), "speech");
	});
}
