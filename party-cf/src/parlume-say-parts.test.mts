import assert from "node:assert/strict";
import test from "node:test";
import {
	answeringMeeting,
	connectedMeeting,
	flush,
	plain,
	say,
	sleep,
	slowAura,
} from "./parlume-meeting-harness.mts";

// A reply the worker sends in parts: part 0 starts it, the part marked last
// ends it.
function part(
	index: number,
	sentences: string[],
	options: { last?: boolean; generation?: string; reply?: string } = {},
) {
	return say(
		sentences,
		{
			"x-parlume-reply": options.reply ?? "reply-1",
			"x-parlume-reply-part": String(index),
			...(options.last ? { "x-parlume-reply-last": "1" } : {}),
		},
		options.generation ?? "0",
	);
}

async function waitFor(condition: () => boolean) {
	for (let waited = 0; waited < 2_000 && !condition(); waited += 10) {
		await sleep(10);
	}
	assert.ok(condition(), "timed out");
}

test("a reply sent in parts speaks its first part before the next exists, and plays them as one reply", async () => {
	const { bridge, bot, auraCalls } = await connectedMeeting();
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = bridge.onRequest(
		part(0, ["Let me check the roadmap's open features."]),
	);
	await waitFor(() => auraCalls.length === 1);
	const added = plain(
		await (
			await bridge.onRequest(
				part(1, ["There is one open feature on the roadmap."], {
					last: true,
				}),
			)
		).json(),
	);
	const result = plain(await (await playing).json());
	clearInterval(keepAlive);

	assert.deepEqual(added, { accepted: true });
	assert.equal(result.played, true);
	assert.equal(result.heard, 2);
	assert.deepEqual(
		result.sentences.map((s: { chars: number; ok: boolean }) => [
			s.chars,
			s.ok,
		]),
		[
			[41, true],
			[41, true],
		],
	);
	assert.ok(
		result.sentences[1].startedAtMs >= result.sentences[0].startedAtMs,
	);
	await bridge.onClose(bot, 1000, "done");
});

test("a part that arrives before the part that starts its reply is kept for it, in order", async () => {
	const { bridge, bot, auraCalls } = await connectedMeeting();
	const keepAlive = setInterval(() => {}, 1_000);

	const early = plain(
		await (
			await bridge.onRequest(
				part(1, ["Second sentence."], { last: true }),
			)
		).json(),
	);
	const result = plain(
		await (await bridge.onRequest(part(0, ["First sentence."]))).json(),
	);
	clearInterval(keepAlive);

	assert.deepEqual(early, { accepted: true });
	assert.equal(result.played, true);
	assert.deepEqual(
		auraCalls.map((call) => (call.inputs as { text: string }).text),
		["First sentence.", "Second sentence."],
	);
	await bridge.onClose(bot, 1000, "done");
});

test("a part that arrives after its reply was played is refused, and nothing more is spoken", async () => {
	const { bridge, bot, auraCalls, sent } = await connectedMeeting();
	const keepAlive = setInterval(() => {}, 1_000);

	const result = plain(
		await (
			await bridge.onRequest(
				part(0, ["The plan is ready."], { last: true }),
			)
		).json(),
	);
	const framesAfter = sent.length;
	const late = plain(
		await (await bridge.onRequest(part(1, ["One more thing."]))).json(),
	);
	const repeated = await bridge.onRequest(part(0, ["The plan is ready."]));
	await flush();
	clearInterval(keepAlive);

	assert.equal(result.played, true);
	assert.deepEqual(late, { accepted: false });
	assert.equal(repeated.status, 409);
	assert.equal(auraCalls.length, 1);
	assert.equal(sent.length, framesAfter);
	await bridge.onClose(bot, 1000, "done");
});

test("speech over a reply waiting for its next part ends it at once, and its later parts are dropped", async () => {
	const { bridge, bot, flux, auraCalls } = await answeringMeeting();
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = bridge.onRequest(
		part(0, ["The plan is ready."], { generation: "1" }),
	);
	await sleep(250);
	flux.turn({
		event: "Update",
		turn_index: 1,
		audio_window_start: 0.06,
		audio_window_end: 0.08,
		transcript: "I think we should",
	});
	await flush();
	// Answered without the reply's last part ever arriving.
	const result = plain(await (await playing).json());
	const dropped = plain(
		await (
			await bridge.onRequest(
				part(1, ["Two items remain."], { last: true, generation: "1" }),
			)
		).json(),
	);
	clearInterval(keepAlive);

	assert.equal(result.muted, true);
	assert.equal(result.played, false);
	assert.deepEqual(dropped, { accepted: false });
	assert.equal(auraCalls.length, 1);
	await bridge.onClose(bot, 1000, "done");
});

test("parts for a generation that was replaced are dropped", async () => {
	const { bridge, bot, auraCalls } = await connectedMeeting();

	const stale = plain(
		await (
			await bridge.onRequest(
				part(1, ["Old news."], { last: true, generation: "7" }),
			)
		).json(),
	);
	const opening = plain(
		await (
			await bridge.onRequest(part(0, ["Old news."], { generation: "7" }))
		).json(),
	);

	assert.deepEqual(stale, { accepted: false });
	assert.equal(opening.interrupted, true);
	assert.equal(auraCalls.length, 0);
	await bridge.onClose(bot, 1000, "done");
});

test("a stale part of an older reply does not end the reply being played", async () => {
	const { bridge, bot, auraCalls } = await connectedMeeting();
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = bridge.onRequest(part(0, ["First sentence."]));
	await waitFor(() => auraCalls.length === 1);
	const stale = plain(
		await (
			await bridge.onRequest(
				part(3, ["Old news."], { reply: "reply-0", generation: "7" }),
			)
		).json(),
	);
	const added = plain(
		await (
			await bridge.onRequest(
				part(1, ["Second sentence."], { last: true }),
			)
		).json(),
	);
	const result = plain(await (await playing).json());
	clearInterval(keepAlive);

	assert.deepEqual(stale, { accepted: false });
	assert.deepEqual(added, { accepted: true });
	assert.equal(result.played, true);
	assert.equal(result.heard, 2);
	await bridge.onClose(bot, 1000, "done");
});

test("a withdrawn reply stops playing what it had queued", async () => {
	const { bridge, bot, sent } = await connectedMeeting({ aura: slowAura });
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = bridge.onRequest(part(0, ["A rather long sentence."]));
	await sleep(250);
	const framesBefore = sent.length;
	const withdrawn = plain(
		await (
			await bridge.onRequest(
				say([], {
					"x-parlume-reply": "reply-1",
					"x-parlume-reply-part": "1",
					"x-parlume-reply-cancel": "1",
				}),
			)
		).json(),
	);
	await assert.rejects(playing, /withdrawn/);
	await sleep(300);
	clearInterval(keepAlive);

	assert.deepEqual(withdrawn, { accepted: true });
	assert.ok(framesBefore > 0, "it was speaking when withdrawn");
	assert.ok(sent.length < framesBefore + 6, "playback stopped");
	await bridge.onClose(bot, 1000, "done");
});
