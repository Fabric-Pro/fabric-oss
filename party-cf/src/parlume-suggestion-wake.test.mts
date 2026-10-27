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

test("enough speech brings the alarm forward to the suggestion pass, not the next access check", async () => {
	const harness = await connectedMeeting({ suggestionsEnabled: true });
	const accessCheck = harness.alarms.at(-1) ?? 0;
	assert.ok(
		accessCheck > Date.now() + 50_000,
		"the access check is a minute out",
	);

	await said(harness, "We still need an export.");
	assert.equal(
		harness.alarms.at(-1),
		accessCheck,
		"one remark is not enough",
	);

	await said(harness, "Nobody owns it yet.");
	const pass = harness.alarms.at(-1) ?? 0;
	assert.ok(pass < accessCheck, "brought forward");
	assert.ok(pass <= Date.now() + 45_000, "at the pass interval");
});

test("speech does not move the alarm when the invitation turned suggestions off", async () => {
	const harness = await connectedMeeting();
	const accessCheck = harness.alarms.at(-1);

	await said(harness, "We still need an export.");
	await said(harness, "Nobody owns it yet.");

	assert.equal(harness.alarms.at(-1), accessCheck);
});
