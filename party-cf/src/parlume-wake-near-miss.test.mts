import assert from "node:assert/strict";
import test from "node:test";
import { connectedMeeting, flush, sleep } from "./parlume-meeting-harness.mts";

async function said(
	harness: Awaited<ReturnType<typeof connectedMeeting>>,
	transcript: string,
) {
	harness.flux.turn({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.01,
		audio_window_end: 0.05,
		transcript,
	});
	await sleep(20);
	await flush();
}

const nearMisses = (harness: Awaited<ReturnType<typeof connectedMeeting>>) =>
	harness.logs.filter(
		(entry) => entry.message === "[Parlume] wake.near_miss",
	);

// Under overlapping speech a wake phrase arrived clipped ("Hey, Fab") and the
// request went unanswered with nothing in the logs to show it was asked.
test("a clipped wake phrase is logged as a near miss, without its words", async () => {
	const harness = await connectedMeeting();

	await said(harness, "Hey, Fab what is the status of the export?");
	await said(harness, "We could ask Parlume about the export later.");
	await said(harness, "The export is slow on large projects.");

	const misses = nearMisses(harness);
	assert.deepEqual(
		misses.map((entry) => entry.meta.reason),
		["clipped_name", "name"],
	);
	for (const miss of misses) {
		assert.doesNotMatch(JSON.stringify(miss.meta), /export/i);
		assert.equal(typeof miss.meta.chars, "number");
	}
	assert.equal(
		harness.requests.some((request) => request.path.endsWith("/turns")),
		false,
	);
});

test("a request that follows a bare wake phrase is not a near miss", async () => {
	const harness = await connectedMeeting();

	await said(harness, "Hey Fabric.");
	await said(harness, "go P3");

	assert.deepEqual(nearMisses(harness), []);
});
