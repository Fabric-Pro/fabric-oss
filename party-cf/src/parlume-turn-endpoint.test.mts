import assert from "node:assert/strict";
import test from "node:test";
import { ParlumeTurnEndpoint } from "./parlume-turn-endpoint.ts";

interface Turn {
	text: string;
	utteranceEndMs: number | null;
}

function endpoint() {
	const completed: Turn[] = [];
	const turns = new ParlumeTurnEndpoint<Turn>(
		(turn) => {
			completed.push(turn);
		},
		600,
		5_000,
	);
	return { turns, completed };
}

test("submits a request once the requester has been quiet", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const { turns, completed } = endpoint();
	turns.begin("speaker-1", {
		text: "what is the name?",
		utteranceEndMs: 1_000,
	});
	t.mock.timers.tick(599);
	assert.equal(completed.length, 0);
	t.mock.timers.tick(1);
	assert.deepEqual(completed, [
		{ text: "what is the name?", utteranceEndMs: 1_000 },
	]);
});

test("appends the requester's continuation instead of submitting a fragment", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const { turns, completed } = endpoint();
	turns.begin("speaker-1", {
		text: "what is the name?",
		utteranceEndMs: 1_000,
	});
	t.mock.timers.tick(400);
	assert.equal(turns.hold("speaker-1"), true);
	t.mock.timers.tick(500);
	assert.equal(turns.append("speaker-1", "of the project.", 2_600), true);
	t.mock.timers.tick(599);
	assert.equal(completed.length, 0);
	t.mock.timers.tick(1);
	assert.deepEqual(completed, [
		{ text: "what is the name? of the project.", utteranceEndMs: 2_600 },
	]);
});

test("ignores other speakers while a request is being endpointed", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const { turns, completed } = endpoint();
	turns.begin("speaker-1", { text: "summarize", utteranceEndMs: 1_000 });
	assert.equal(turns.hold("speaker-2"), false);
	assert.equal(turns.append("speaker-2", "unrelated remark", 1_500), false);
	t.mock.timers.tick(600);
	assert.deepEqual(completed, [{ text: "summarize", utteranceEndMs: 1_000 }]);
});

test("submits at the cap when the requester keeps talking", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const { turns, completed } = endpoint();
	turns.begin("speaker-1", { text: "status", utteranceEndMs: 1_000 });
	for (let elapsed = 0; elapsed < 4_800; elapsed += 400) {
		turns.hold("speaker-1");
		t.mock.timers.tick(400);
	}
	assert.equal(completed.length, 0);
	t.mock.timers.tick(200);
	assert.equal(completed.length, 1);
	assert.equal(turns.hold("speaker-1"), false);
});

test("a new request or cancellation discards the previous draft", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const { turns, completed } = endpoint();
	turns.begin("speaker-1", { text: "first", utteranceEndMs: 1_000 });
	turns.begin("speaker-2", { text: "second", utteranceEndMs: 1_200 });
	t.mock.timers.tick(600);
	assert.deepEqual(completed, [{ text: "second", utteranceEndMs: 1_200 }]);
	turns.begin("speaker-1", { text: "third", utteranceEndMs: 2_000 });
	turns.cancel();
	t.mock.timers.tick(5_000);
	assert.equal(completed.length, 1);
});
