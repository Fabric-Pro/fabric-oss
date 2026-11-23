import assert from "node:assert/strict";
import test from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

const { ParlumeAudioReadiness } = loadParlumeModule(
	"./parlume-audio-ready.ts",
	async () => Response.json({}),
) as {
	ParlumeAudioReadiness: new () => {
		note(chunkMs: number, atMs: number): boolean;
	};
};

/**
 * Feeds 10 ms chunks stamped `fromMs` to `untilMs`, but those `drop` names,
 * and returns the stamp of the chunk that made the audio ready.
 */
function feed(
	readiness: { note(chunkMs: number, atMs: number): boolean },
	fromMs: number,
	untilMs: number,
	drop: (index: number) => boolean = () => false,
): number | null {
	for (let at = fromMs, index = 0; at <= untilMs; at += 10, index++) {
		if (!drop(index) && readiness.note(10, at)) {
			return at;
		}
	}
	return null;
}

test("audio that arrives whole is ready after two seconds of it", () => {
	const readiness = new ParlumeAudioReadiness();

	assert.equal(feed(readiness, 1_000, 3_000), 3_000);
});

// On staging the first ten seconds held 641 and 792 of about 1,000 chunks.
test("audio missing a third of its chunks is never ready", () => {
	const readiness = new ParlumeAudioReadiness();

	assert.equal(
		feed(readiness, 1_000, 11_000, (index) => index % 3 === 0),
		null,
	);
});

test("a gap starts the count again, and whole audio after it is ready two seconds on", () => {
	const readiness = new ParlumeAudioReadiness();

	assert.equal(feed(readiness, 1_000, 1_900), null);
	// 0.8 s with nothing, as on staging.
	assert.equal(feed(readiness, 2_700, 3_000), null);
	assert.equal(feed(readiness, 3_010, 6_000), 5_000);
});

test("chunks sent twice never count for more than the time that passed", () => {
	const readiness = new ParlumeAudioReadiness();
	readiness.note(10, 1_000);
	for (let copy = 0; copy < 300; copy++) {
		assert.equal(readiness.note(10, 1_010), false);
	}

	// Half of the next two seconds arrives: counted whole with the copies, it
	// would be ready.
	assert.equal(
		feed(readiness, 1_020, 3_010, (index) => index % 2 === 0),
		null,
	);
});
