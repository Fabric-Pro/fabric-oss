import assert from "node:assert/strict";
import test from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

type Actor = { name: string | null; id: string | null };
type Detection = { detectMs: number; confirmed: boolean };

interface SpokenStop {
	onPartial(text: string, actor: Actor | null, heardAt: number): void;
	onFinal(
		text: string,
		actor: Actor | null,
		heardAt: number,
	): Promise<string>;
}

const { ParlumeSpokenStop } = loadParlumeModule(
	"./parlume-spoken-stop.ts",
	async () => Response.json({}),
) as {
	ParlumeSpokenStop: new (host: unknown) => SpokenStop;
};

// Objects built inside the sandboxed module have that realm's prototypes.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

const devTwo: Actor = { name: "Dev Two", id: "participant-2" };

function spokenStop(
	options: {
		speaking?: boolean;
		stoppable?: boolean;
		saying?: string[];
	} = {},
) {
	const calls: string[] = [];
	const stops: Array<{ actor: Actor | null; detection: Detection }> = [];
	const logs: string[] = [];
	let now = 10_000;
	const stop = new ParlumeSpokenStop({
		speaking: () => options.speaking ?? true,
		stoppable: () => options.stoppable ?? options.speaking ?? true,
		saying: () => options.saying ?? [],
		hold: () => calls.push("hold"),
		release: () => calls.push("release"),
		stop: async (actor: Actor | null, detection: Detection) => {
			calls.push("stop");
			stops.push(plain({ actor, detection }));
		},
		log: (_level: string, event: string) => logs.push(event),
		now: () => now,
	});
	return {
		stop,
		calls,
		stops,
		logs,
		setNow: (at: number) => {
			now = at;
		},
	};
}

test("a stop that names Parlume holds its speech on the partial, and the final ends the answer as a confirmed stop", async () => {
	const { stop, calls, stops, setNow } = spokenStop();

	stop.onPartial("Parlume, stop", null, 9_800);
	assert.deepEqual(calls, ["hold"]);
	setNow(10_600);
	const kind = await stop.onFinal("Parlume, stop.", devTwo, 10_100);

	assert.equal(kind, "stop");
	assert.deepEqual(calls, ["hold", "stop"]);
	assert.deepEqual(stops, [
		{ actor: devTwo, detection: { detectMs: 200, confirmed: true } },
	]);
});

test("the final names who stopped Parlume, or else the partial does", async () => {
	const { stop, stops } = spokenStop();

	stop.onPartial("Parlume, wait", devTwo, 9_800);
	await stop.onFinal("Parlume, wait.", null, 10_000);

	assert.deepEqual(
		stops.map((entry) => entry.actor),
		[devTwo],
	);
});

test("a final that is not a stop lets the held speech go on, and stops nothing", async () => {
	const { stop, calls, logs } = spokenStop();

	stop.onPartial("Parlume, wait", devTwo, 9_800);
	const kind = await stop.onFinal(
		"Parlume, wait for the numbers.",
		devTwo,
		10_000,
	);

	assert.equal(kind, "none");
	assert.deepEqual(calls, ["hold", "release"]);
	assert.ok(logs.includes("speech.stop_held"));
	assert.ok(logs.includes("speech.stop_withdrawn"));
});

test("a stop without the name holds nothing on its partial, and stops Parlume on its final", async () => {
	const { stop, calls, stops, setNow } = spokenStop();

	stop.onPartial("stop", devTwo, 9_800);
	assert.deepEqual(calls, []);
	setNow(10_400);
	const kind = await stop.onFinal("Stop.", null, 10_000);

	assert.equal(kind, "stop");
	assert.deepEqual(calls, ["stop"]);
	assert.deepEqual(stops, [
		{ actor: null, detection: { detectMs: 400, confirmed: false } },
	]);
});

test("side talk holds nothing and stops nothing", async () => {
	const { stop, calls } = spokenStop();

	stop.onPartial("wait for the numbers", devTwo, 9_800);
	stop.onPartial("stop the deploy", devTwo, 9_900);
	const kind = await stop.onFinal(
		"Stop the deploy before Friday.",
		devTwo,
		10_000,
	);

	assert.equal(kind, "none");
	assert.deepEqual(calls, []);
});

test("a second stop heard while Parlume is held does not hold it again", async () => {
	const { stop, calls } = spokenStop();

	stop.onPartial("Parlume, stop", devTwo, 9_800);
	stop.onPartial("Parlume, stop talking", devTwo, 9_900);
	await stop.onFinal("Parlume, stop talking.", devTwo, 10_000);

	assert.deepEqual(calls, ["hold", "stop"]);
});

test("a stop that goes on to ask something ends the answer and says so", async () => {
	const { stop, calls } = spokenStop();

	const kind = await stop.onFinal(
		"Parlume, stop. What is next?",
		devTwo,
		10_000,
	);

	assert.equal(kind, "stop-then-request");
	assert.deepEqual(calls, ["stop"]);
});

test("with nothing to stop, a stop holds nothing and stops nothing", async () => {
	const { stop, calls } = spokenStop({ speaking: false, stoppable: false });

	stop.onPartial("Parlume, stop", devTwo, 9_800);
	const kind = await stop.onFinal("Parlume, stop.", devTwo, 10_000);

	assert.equal(kind, "stop");
	assert.deepEqual(calls, []);
});

test("an answer still being prepared is stopped by a final stop", async () => {
	const { stop, calls } = spokenStop({ speaking: false, stoppable: true });

	stop.onPartial("Parlume, stop", devTwo, 9_800);
	assert.deepEqual(calls, [], "nothing audible to hold");
	await stop.onFinal("Parlume, stop.", devTwo, 10_000);

	assert.deepEqual(calls, ["stop"]);
});

test("Parlume's own sentence heard back is not a stop", async () => {
	const { stop, calls } = spokenStop({
		saying: ["Say stop talking, and I will stop talking."],
	});

	const kind = await stop.onFinal("stop talking", null, 10_000);

	assert.equal(kind, "none");
	assert.deepEqual(calls, []);
});

test("with no final within four seconds, the held stop stands", async () => {
	const { stop, calls, stops } = spokenStop();
	// The module's timers do not keep the process alive on their own.
	const keepAlive = setInterval(() => {}, 1_000);

	stop.onPartial("Parlume, stop", devTwo, 9_800);
	await new Promise((resolve) => setTimeout(resolve, 3_500));
	assert.deepEqual(calls, ["hold"], "still waiting for the final");
	await new Promise((resolve) => setTimeout(resolve, 800));
	clearInterval(keepAlive);

	assert.deepEqual(calls, ["hold", "stop"]);
	assert.deepEqual(stops, [
		{ actor: devTwo, detection: { detectMs: 200, confirmed: false } },
	]);
});
