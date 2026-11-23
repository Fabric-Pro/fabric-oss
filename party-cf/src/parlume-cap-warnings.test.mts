import assert from "node:assert/strict";
import test from "node:test";
import {
	answeringMeeting,
	connectedMeeting,
	control,
	flush,
	plain,
	say,
	sleep,
} from "./parlume-meeting-harness.mts";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

const capModule = loadParlumeModule("./parlume-cap-warnings.ts", async () =>
	Response.json({}),
) as {
	parlumeCapClosing(openUntil: number | null, now: number): boolean;
	ParlumeCapWarnings: new (
		host: unknown,
	) => {
		load(): Promise<void>;
		nextAt(hardStopAt: number): number | null;
		run(hardStopAt: number): Promise<void>;
	};
};
const { ParlumeCapWarnings, parlumeCapClosing } = capModule;

// The warnings before the four-hour cap, the last two minutes, and the end
// at the cap.

const MINUTE = 60_000;
const HARD_STOP = 100 * MINUTE;
const CLOSING = 2 * MINUTE;

function warnings(data = new Map<string, unknown>()) {
	let now = 0;
	const notices: string[] = [];
	const spoken: string[] = [];
	let closings = 0;
	const capWarnings = new ParlumeCapWarnings({
		storage: {
			get: async (key: string) => structuredClone(data.get(key)),
			put: async (key: string, value: unknown) => {
				data.set(key, structuredClone(value));
			},
		},
		speak: async (text: string) => {
			spoken.push(text);
		},
		postNotice: async (text: string) => {
			notices.push(text);
		},
		onClosing: () => {
			closings++;
		},
		log: () => {},
		now: () => now,
	});
	return {
		capWarnings,
		notices,
		spoken,
		data,
		closings: () => closings,
		at: (ms: number) => {
			now = ms;
		},
	};
}

test("warns ten and two minutes before the cap, once each, and only then", async () => {
	const { capWarnings, notices, spoken, closings, at } = warnings();
	await capWarnings.load();
	assert.equal(capWarnings.nextAt(HARD_STOP), HARD_STOP - 10 * MINUTE);

	at(HARD_STOP - 11 * MINUTE);
	await capWarnings.run(HARD_STOP);
	assert.deepEqual(notices, []);

	at(HARD_STOP - 10 * MINUTE);
	await capWarnings.run(HARD_STOP);
	await capWarnings.run(HARD_STOP);
	assert.deepEqual(notices, [
		"**Leaving in 10 minutes** · This meeting reaches Parlume's four-hour limit, and I leave then.",
	]);
	assert.deepEqual(spoken, [
		"I leave this meeting in 10 minutes, at its four-hour limit.",
	]);
	assert.equal(capWarnings.nextAt(HARD_STOP), HARD_STOP - 2 * MINUTE);
	assert.equal(closings(), 0);

	at(HARD_STOP - 2 * MINUTE);
	await capWarnings.run(HARD_STOP);
	await capWarnings.run(HARD_STOP);
	assert.equal(notices.length, 2);
	assert.equal(
		notices[1],
		"**Leaving in 2 minutes** · This meeting reaches Parlume's four-hour limit, and I leave then.\nI answer new requests here in the chat until I leave.",
	);
	assert.equal(
		spoken[1],
		"I leave this meeting in 2 minutes, at its four-hour limit. I answer in the chat from now on.",
	);
	assert.equal(closings(), 1);
	assert.equal(capWarnings.nextAt(HARD_STOP), null);
});

test("a restarted bridge gives no warning twice", async () => {
	const first = warnings();
	await first.capWarnings.load();
	first.at(HARD_STOP - 10 * MINUTE);
	await first.capWarnings.run(HARD_STOP);

	const restarted = warnings(first.data);
	await restarted.capWarnings.load();
	restarted.at(HARD_STOP - 9 * MINUTE);
	await restarted.capWarnings.run(HARD_STOP);

	assert.deepEqual(restarted.notices, []);
	assert.equal(
		restarted.capWarnings.nextAt(HARD_STOP),
		HARD_STOP - 2 * MINUTE,
	);
});

test("an alarm that comes late gives only the later warning, and none at or past the cap", async () => {
	const late = warnings();
	await late.capWarnings.load();
	late.at(HARD_STOP - 90_000);
	await late.capWarnings.run(HARD_STOP);
	assert.equal(late.notices.length, 1);
	assert.match(late.notices[0] ?? "", /^\*\*Leaving in 2 minutes\*\*/);
	assert.equal(late.capWarnings.nextAt(HARD_STOP), null);

	const past = warnings();
	await past.capWarnings.load();
	past.at(HARD_STOP);
	await past.capWarnings.run(HARD_STOP);
	assert.deepEqual(past.notices, []);
});

test("a cap Fabric moved starts its warnings over", async () => {
	const { capWarnings, notices, at } = warnings();
	await capWarnings.load();
	at(HARD_STOP - 10 * MINUTE);
	await capWarnings.run(HARD_STOP);
	const moved = HARD_STOP + 30 * MINUTE;
	assert.equal(capWarnings.nextAt(moved), moved - 10 * MINUTE);
	at(moved - 10 * MINUTE);
	await capWarnings.run(moved);
	assert.equal(notices.length, 2);
});

test("the last two minutes start two minutes before the cap and never without one", () => {
	assert.equal(parlumeCapClosing(HARD_STOP, HARD_STOP - CLOSING - 1), false);
	assert.equal(parlumeCapClosing(HARD_STOP, HARD_STOP - CLOSING), true);
	assert.equal(parlumeCapClosing(HARD_STOP, HARD_STOP + 1), true);
	assert.equal(parlumeCapClosing(null, HARD_STOP), false);
	assert.equal(parlumeCapClosing(Number.POSITIVE_INFINITY, HARD_STOP), false);
});

type Harness = Awaited<ReturnType<typeof connectedMeeting>>;

const chatPosts = (harness: Harness) =>
	harness.requests
		.filter((request) => request.path.endsWith("/parlume/chat"))
		.map((request) => String(request.body.message));

/** Bridge time, moved by `offset` from the real clock. */
function shiftClock(t: { after(run: () => void): void }) {
	const realNow = Date.now;
	let offset = 0;
	Date.now = () => realNow() + offset;
	t.after(() => {
		Date.now = realNow;
	});
	return (ms: number) => {
		offset = ms;
	};
}

test("the bridge posts and says each warning once, keeping its other alarms", async (t) => {
	const start = Date.now();
	const shift = shiftClock(t);
	const harness = await connectedMeeting({
		verify: async () =>
			Response.json({
				valid: true,
				hardStopAt: new Date(start + 11 * MINUTE).toISOString(),
				streamGeneration: 1,
			}),
	});
	const keepAlive = setInterval(() => {}, 1_000);
	t.after(() => clearInterval(keepAlive));

	shift(MINUTE + 1_000);
	await harness.bridge.onAlarm();
	await harness.bridge.onAlarm();
	await sleep(300);
	await flush();

	const tenMinutes = chatPosts(harness).filter((message) =>
		message.includes("Leaving in 10 minutes"),
	);
	assert.equal(tenMinutes.length, 1);
	assert.ok(
		harness.auraCalls.some((call) =>
			String((call.inputs as { text: string }).text).includes(
				"I leave this meeting in 10 minutes",
			),
		),
		"the warning is said",
	);
	// The access check keeps its one-minute cadence; the warning only
	// brings an alarm forward.
	const alarm = harness.alarms.at(-1) ?? Number.POSITIVE_INFINITY;
	assert.ok(alarm <= Date.now() + MINUTE);

	// The meeting chat shows the warning. A post that never shows up, in a
	// chat that has shown nothing, marks the chat out of reach, and the
	// later warning would not be posted.
	await harness.bridge.onRequest(
		control("chat-message", {
			id: "msg_ten_minutes",
			text: tenMinutes[0],
			senderName: "Fabric Parlume",
			senderId: "parlume-bot",
			toBot: false,
			timestampMs: Date.now(),
		}),
	);

	shift(9 * MINUTE + 1_000);
	await harness.bridge.onAlarm();
	await flush();
	assert.equal(
		chatPosts(harness).filter((message) =>
			message.includes("Leaving in 2 minutes"),
		).length,
		1,
	);
	assert.equal(
		chatPosts(harness).filter((message) =>
			message.includes("Leaving in 10 minutes"),
		).length,
		1,
	);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("in the last two minutes a spoken request is answered in the chat", async (t) => {
	const start = Date.now();
	const shift = shiftClock(t);
	const harness = await connectedMeeting({
		verify: async () =>
			Response.json({
				valid: true,
				hardStopAt: new Date(start + 11 * MINUTE).toISOString(),
				streamGeneration: 1,
			}),
	});
	shift(9 * MINUTE + 30_000);

	harness.flux.turn({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.01,
		audio_window_end: 0.05,
		transcript: "Hey Fabric, what is the plan?",
	});
	for (
		let waited = 0;
		waited < 2_000 &&
		!harness.requests.some((r) => r.path.endsWith("/turns"));
		waited += 20
	) {
		await sleep(20);
	}

	const turn = harness.requests.find((r) => r.path.endsWith("/turns"))?.body;
	assert.equal(turn?.text, "what is the plan?");
	assert.equal(turn?.replyChannel, "CHAT");
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

/** The bridge's log entries for `name`, as their structured fields. */
const events = (harness: Harness, name: string) =>
	harness.logs
		.filter((entry) => entry.meta.event === `parlume.bridge.${name}`)
		.map((entry) => entry.meta);

async function until(condition: () => boolean) {
	for (let waited = 0; waited < 3_000 && !condition(); waited += 20) {
		await sleep(20);
	}
	assert.ok(condition(), "timed out");
}

test("in the last two minutes a request the realtime voice holds is answered in the chat, not aloud", async (t) => {
	const start = Date.now();
	const shift = shiftClock(t);
	const harness = await connectedMeeting({
		realtime: true,
		verify: async () =>
			Response.json({
				valid: true,
				hardStopAt: new Date(start + 11 * MINUTE).toISOString(),
				streamGeneration: 1,
			}),
	});
	const keepAlive = setInterval(() => {}, 1_000);
	t.after(() => clearInterval(keepAlive));
	const spokenByRealtime = () =>
		events(harness, "speech.started").filter(
			(event) => event.voice === "realtime",
		).length;
	const turns = () =>
		harness.requests.filter((request) => request.path.endsWith("/turns"));
	await until(() => events(harness, "realtime.connected").length > 0);
	// The meeting chat has shown a message, so a post it has not shown yet
	// is late, not out of reach.
	await harness.bridge.onRequest(
		control("chat-message", {
			id: "msg_observed",
			text: "Parlume is in the meeting.",
			senderName: "Fabric Parlume",
			senderId: "parlume-bot",
			toBot: false,
			timestampMs: Date.now(),
		}),
	);

	// The realtime voice answers the first request, and holds the second
	// until that answer is done.
	harness.flux.turn({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.01,
		audio_window_end: 0.03,
		transcript: "Hey Fabric, what is the plan?",
	});
	await until(() => spokenByRealtime() === 1);
	harness.realtime.turn({ type: "input_audio_buffer.speech_started" });
	harness.realtime.turn({ type: "input_audio_buffer.speech_stopped" });
	harness.flux.turn({
		event: "EndOfTurn",
		turn_index: 1,
		audio_window_start: 0.04,
		audio_window_end: 0.07,
		transcript: "Hey Fabric, who owns the export?",
	});
	await until(() => events(harness, "realtime.armed").length === 2);
	await flush();
	assert.equal(spokenByRealtime(), 1);
	assert.equal(turns().length, 0, "the realtime voice holds the request");

	// Two minutes before the cap, the request is asked of Fabric instead.
	shift(9 * MINUTE + 30_000);
	await harness.bridge.onAlarm();
	await until(() => turns().some((request) => request.body.job === "J1"));
	const turn = turns().find((request) => request.body.job === "J1")?.body;
	assert.equal(turn?.text, "who owns the export?");
	assert.equal(turn?.delivery, "realtime");
	assert.deepEqual(
		events(harness, "realtime.request_to_chat").map((event) => [
			event.kind,
			event.job,
		]),
		[["wake", "J1"]],
	);

	// Its result goes to the chat, and nothing more is said.
	const delivered = await harness.bridge.onRequest(
		control("fabric-result", {
			job: "J1",
			status: "completed",
			text: "Dana owns the export.",
			chatTags: [],
			turnId: "turn-2",
		}),
	);
	assert.deepEqual(plain(await delivered.json()), { accepted: true });
	await until(() =>
		chatPosts(harness).some((message) =>
			message.includes("Dana owns the export."),
		),
	);
	assert.equal(spokenByRealtime(), 1, "no new realtime answer started");
	assert.ok(
		!harness.auraCalls.some((call) =>
			String((call.inputs as { text: string }).text).includes("Dana"),
		),
		"the result is not read aloud",
	);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("at the cap an answer ends at its sentence end, then the watchdog is told", async (t) => {
	const shift = shiftClock(t);
	const harness = await answeringMeeting();
	const keepAlive = setInterval(() => {}, 1_000);
	t.after(() => clearInterval(keepAlive));

	const playing = harness.bridge.onRequest(
		say(
			[
				"The plan is to ship the release on Friday.",
				"Then we start the next milestone.",
				"After that comes the review.",
			],
			{},
			"1",
		),
	);
	await sleep(300);
	// The harness's meeting reaches its cap one hour after it started.
	shift(3_600_000 + 1_000);
	await harness.bridge.onAlarm();
	const result = plain(await (await playing).json());

	assert.equal(result.heard, 1, "the first sentence, heard to its end");
	assert.equal(result.played, false);
	assert.ok(harness.requests.some((r) => r.path.endsWith("/watchdog")));
	await harness.bridge.onClose(harness.bot, 1000, "done");
});
