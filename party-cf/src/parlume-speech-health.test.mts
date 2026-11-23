import assert from "node:assert/strict";
import test from "node:test";
import {
	answeringMeeting,
	audio,
	connectedMeeting,
	control,
	flush,
	meeting,
	plain,
	STREAM_URL,
	say,
	sleep,
	slowAura,
} from "./parlume-meeting-harness.mts";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

type Logged = { meta: Record<string, unknown> };
type Meta = Record<string, unknown>;

/** The bridge's log entries for `name`, as their structured fields. */
const events = (logs: Logged[], name: string) =>
	logs
		.filter((entry) => entry.meta.event === `parlume.bridge.${name}`)
		.map((entry) => entry.meta);

async function waitFor(condition: () => boolean) {
	for (let waited = 0; waited < 3_000 && !condition(); waited += 20) {
		await sleep(20);
	}
	assert.ok(condition(), "timed out");
}

const frames = (sent: string[]) =>
	sent.filter((message) => message.includes('"realtime_audio.bot_output"'))
		.length;

type Report = {
	sessionId: string;
	botId: string;
	totals: Record<string, number>;
};

const speechReports = (requests: Array<{ path: string; body: Meta }>) =>
	requests
		.filter((request) => request.path.endsWith("/speech-health"))
		.map((request) => request.body as Report);

/** The storage as the Durable Object reads it after a restart. */
function restartedStorage(data: Map<string, unknown>) {
	const copy = new Map<string, unknown>();
	for (const [key, value] of data) {
		copy.set(key, structuredClone(value));
	}
	return copy;
}

const ZERO_TOTALS = {
	replies: 0,
	speakingMs: 0,
	underrunMs: 0,
	waitMs: 0,
	stallResets: 0,
	stops: 0,
	slowStops: 0,
	worstStopMs: 0,
	resumes: 0,
	failedResumes: 0,
	capped: 0,
	fallbacks: 0,
	auraRetries: 0,
	auraRetryFailures: 0,
};

test("a reply played to its end logs its start, its first audio and how it ended", async () => {
	const harness = await connectedMeeting();
	const keepAlive = setInterval(() => {}, 1_000);

	const response = await harness.bridge.onRequest(
		say(["The plan is ready.", "It ships on Friday."]),
	);
	const result = plain(await response.json());
	await waitFor(() => events(harness.logs, "speech.ended").length > 0);
	clearInterval(keepAlive);

	assert.equal(result.played, true);
	const [started] = events(harness.logs, "speech.started");
	assert.equal(started?.sessionId, "session-1");
	assert.equal(started?.voice, "classic");
	assert.equal(started?.route, "aura");
	assert.equal(started?.voiceGeneration, 0);
	const [first] = events(harness.logs, "speech.first_audio");
	assert.equal(first?.route, "aura");
	assert.equal(typeof first?.firstAudioMs, "number");
	assert.ok(Number(first?.firstAudioMs) >= 0);
	const [ended] = events(harness.logs, "speech.ended");
	assert.equal(ended?.sessionId, "session-1");
	assert.equal(ended?.voice, "classic");
	assert.equal(ended?.route, "aura");
	assert.equal(ended?.voiceGeneration, 0);
	assert.equal(ended?.outcome, "completed");
	assert.equal(ended?.replies, 1);
	assert.equal(ended?.cause, null);
	assert.equal(ended?.actorId, null);
	// Two 100 ms sentences.
	assert.equal(ended?.heardMs, 200);
	assert.equal(ended?.droppedMs, 0);
	assert.equal(typeof ended?.underrunMs, "number");
	assert.ok(Number(ended?.speakingMs) > 0);
	assert.equal(typeof ended?.stallResets, "number");
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a stopped reply logs who stopped it and how, and ends as stopped with the speech it dropped", async () => {
	const harness = await answeringMeeting();
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = harness.bridge.onRequest(
		say(["The plan is to ship the release on Friday."], {}, "1"),
	);
	await waitFor(() => frames(harness.sent) > 3);
	await harness.bridge.onRequest(
		control("stop-speech", {
			actor: { id: "user-1", name: "Dana Member" },
		}),
	);
	await flush();
	await playing;
	clearInterval(keepAlive);

	const [stopped] = events(harness.logs, "speech.stopped");
	assert.equal(stopped?.sessionId, "session-1");
	assert.equal(stopped?.cause, "page");
	assert.equal(stopped?.actorId, "user-1");
	assert.equal(stopped?.speaking, true);
	assert.equal(stopped?.stopped, true);
	assert.equal(stopped?.detectMs, null, "only a stop said aloud is timed");
	assert.equal(stopped?.confirmed, null);
	const [ended] = events(harness.logs, "speech.ended");
	assert.equal(ended?.outcome, "stopped");
	assert.equal(ended?.cause, "page");
	assert.equal(ended?.actorId, "user-1");
	assert.equal(ended?.voiceGeneration, 1);
	assert.ok(Number(ended?.droppedMs) > 0, "the rest was never sent");
	assert.ok(Number(ended?.heardMs) < 2_000);
	assert.equal(
		JSON.stringify(ended).includes("Dana"),
		false,
		"ids only, never a name",
	);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a reply a new bot socket took over logs speech.resumed, and its end once played there", async () => {
	const harness = await connectedMeeting({ aura: slowAura });
	const keepAlive = setInterval(() => {}, 1_000);
	const playing = harness.bridge.onRequest(
		say(["The roadmap has two open features."]),
	);
	await waitFor(() => frames(harness.sent) > 0);

	const replacementSent: string[] = [];
	const replacement = {
		send: (message: string) => replacementSent.push(message),
		close: () => {},
	};
	await harness.bridge.onConnect(replacement, {
		request: { url: STREAM_URL },
	});
	await harness.bridge.onMessage(replacement, audio(1_000_090));
	await playing;
	await waitFor(() => events(harness.logs, "speech.ended").length > 0);
	clearInterval(keepAlive);

	const [resumed] = events(harness.logs, "speech.resumed");
	assert.equal(resumed?.sessionId, "session-1");
	assert.equal(resumed?.cause, "socket_swap");
	assert.equal(resumed?.voiceGeneration, 0);
	assert.equal(typeof resumed?.gapMs, "number");
	assert.ok(Number(resumed?.lostMs) <= 300);
	const [ended] = events(harness.logs, "speech.ended");
	assert.equal(ended?.outcome, "completed");
	assert.equal(ended?.replies, 1);
	assert.ok(frames(replacementSent) > 0);
	await harness.bridge.onAlarm();
	assert.equal(speechReports(harness.requests)[0]?.totals?.resumes, 1);
	await harness.bridge.onClose(replacement, 1000, "done");
});

test("a realtime answer cut at the spoken limit logs realtime.capped and ends as capped", async () => {
	const harness = await connectedMeeting({ realtime: true });
	const keepAlive = setInterval(() => {}, 1_000);
	await waitFor(() => events(harness.logs, "realtime.connected").length > 0);
	harness.flux.turn({
		event: "Update",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 0.9,
		transcript: "Hey Fabric, what is",
	});
	await sleep(50);
	harness.realtime.turn({ type: "input_audio_buffer.speech_stopped" });
	// The voice answers once the speaker has stayed quiet briefly.
	await sleep(700);
	harness.realtime.turn({
		type: "response.created",
		response: { id: "resp_1" },
	});
	// 200 ms of 24 kHz speech.
	harness.realtime.turn({
		type: "response.output_audio.delta",
		response_id: "resp_1",
		item_id: "item_1",
		delta: Buffer.alloc(9_600).toString("base64"),
	});
	harness.realtime.turn({
		type: "response.done",
		response: {
			id: "resp_1",
			status: "incomplete",
			status_details: { reason: "max_output_tokens" },
			output: [],
		},
	});
	await waitFor(() => events(harness.logs, "speech.ended").length > 0);
	clearInterval(keepAlive);

	const [started] = events(harness.logs, "speech.started");
	assert.equal(started?.voice, "realtime");
	assert.equal(started?.route, "realtime");
	assert.equal(started?.kind, "wake");
	assert.equal(started?.botId, "bot_abc123");
	const [capped] = events(harness.logs, "realtime.capped");
	assert.equal(capped?.audioMs, 200);
	const [first] = events(harness.logs, "speech.first_audio");
	assert.equal(first?.voice, "realtime");
	const [ended] = events(harness.logs, "speech.ended");
	assert.equal(ended?.outcome, "capped");
	assert.equal(ended?.voice, "realtime");
	assert.equal(ended?.kind, "wake");
	assert.equal(ended?.heardMs, 200);
	assert.equal(ended?.droppedMs, 0);
	await harness.bridge.onAlarm();
	assert.equal(speechReports(harness.requests)[0]?.totals?.capped, 1);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("the totals survive a restart and go to Fabric on the alarm, once until they change", async () => {
	const harness = await connectedMeeting();
	const keepAlive = setInterval(() => {}, 1_000);
	await harness.bridge.onRequest(say(["The plan is ready."]));
	await waitFor(() => events(harness.logs, "speech.ended").length > 0);
	clearInterval(keepAlive);
	const stored = restartedStorage(harness.data);
	await harness.bridge.onClose(harness.bot, 1006, "restarted");

	const restarted = meeting({ data: stored });
	await restarted.bridge.onStart();
	await restarted.bridge.onAlarm();
	await restarted.bridge.onAlarm();

	const reports = speechReports(restarted.requests);
	assert.equal(reports.length, 1, "unchanged totals are not sent again");
	const [report] = reports;
	assert.equal(report?.sessionId, "session-1");
	assert.equal(report?.botId, "bot_abc123");
	const totals = report?.totals ?? {};
	assert.deepEqual(
		Object.keys(totals).sort(),
		Object.keys(ZERO_TOTALS).sort(),
	);
	assert.equal(totals.replies, 1);
	assert.ok(Number(totals.speakingMs) > 0);
	assert.equal(totals.stops, 0);
	assert.equal(totals.auraRetries, 0);
	assert.equal(
		speechReports(harness.requests).length,
		0,
		"nothing is sent before the alarm",
	);
});

// The counting itself, from the events alone.

interface SpeechHealth {
	observe(event: string, meta: Meta): void;
	queued(opened: boolean): void;
	ended(reply: Meta): void;
	report(): Promise<boolean>;
}

const { ParlumeSpeechHealth } = loadParlumeModule(
	"./parlume-speech-health.ts",
	async () => Response.json({}),
) as { ParlumeSpeechHealth: new (host: unknown) => SpeechHealth };

function speechHealth() {
	const logs: Array<{ event: string; meta: Meta }> = [];
	const posted: Meta[] = [];
	let now = 10_000;
	const data = new Map<string, unknown>();
	const health = new ParlumeSpeechHealth({
		storage: {
			get: async (key: string) => data.get(key),
			put: async (key: string, value: unknown) => {
				data.set(key, value);
			},
		},
		sessionId: () => "session-1",
		bot: async () => ({ sessionId: "session-1", botId: "bot-1" }),
		postToFabric: async (_path: string, body: Meta) => {
			posted.push(plain(body));
			return Response.json({ accepted: true });
		},
		log: (_level: string, event: string, meta: Meta) =>
			logs.push({ event, meta: plain(meta) }),
		now: () => now,
	});
	return {
		health,
		posted,
		ended: () =>
			logs
				.filter((entry) => entry.event === "speech.ended")
				.map((entry) => entry.meta),
		totals: async () => {
			await health.report();
			return (posted.at(-1) as Report | undefined)?.totals;
		},
		advance: (milliseconds: number) => {
			now += milliseconds;
		},
	};
}

const reply = (overrides: Meta = {}) => ({
	played: true,
	speakingMs: 1_000,
	speechMs: 800,
	droppedMs: 0,
	waitMs: 0,
	underrunMs: 0,
	stallResets: 0,
	...overrides,
});

test("a stop said aloud counts as slow once Parlume stayed audible more than 1.5 s after the words", async () => {
	const { health, totals } = speechHealth();
	const stop = (detectMs: number, extra: Meta = {}) =>
		health.observe("speech.stopped", {
			cause: "voice",
			actorId: "participant-1",
			speaking: true,
			stopped: true,
			detectMs,
			confirmed: true,
			...extra,
		});

	// 1,300 ms plus the 200 ms the bot still plays is just in time.
	stop(1_300);
	stop(1_301);
	// Not audible, or not said aloud: no stop-to-silence time.
	stop(5_000, { speaking: false });
	health.observe("speech.stopped", {
		cause: "page",
		speaking: true,
		stopped: true,
		detectMs: null,
	});

	const counted = await totals();
	assert.equal(counted?.stops, 2);
	assert.equal(counted?.slowStops, 1);
	assert.equal(counted?.worstStopMs, 1_501);
});

test("underrun and speaking time add up across replies, with clock restarts", async () => {
	const { health, totals } = speechHealth();
	health.observe("speech.started", { voice: "classic", route: "aura" });
	health.queued(true);
	health.ended(reply({ underrunMs: 30, speakingMs: 2_000 }));
	health.observe("speech.started", { voice: "classic", route: "pcm" });
	health.queued(true);
	health.ended(reply({ underrunMs: 10, speakingMs: 1_000, stallResets: 1 }));

	const counted = await totals();
	assert.equal(counted?.replies, 2);
	assert.equal(counted?.speakingMs, 3_000);
	assert.equal(counted?.underrunMs, 40);
	assert.equal(counted?.stallResets, 1);
});

// Live, every reply with a tool wait counted its covered pause as underrun:
// 4,600 of 141,787 ms, while a plain read-aloud counted none.
test("a reply's covered wait for its next part is counted apart from underrun", async () => {
	const { health, ended, totals } = speechHealth();
	health.observe("speech.started", { voice: "classic", route: "aura" });
	health.queued(true);
	health.ended(reply({ waitMs: 1_300, speakingMs: 4_987 }));

	const counted = await totals();
	assert.equal(counted?.waitMs, 1_300);
	assert.equal(counted?.underrunMs, 0);
	const [stretch] = ended();
	assert.equal(stretch?.waitMs, 1_300);
	assert.equal(stretch?.underrunMs, 0);
});

test("a reply that never sent audio ends as silent, or as failed when Aura failed it twice", async () => {
	const { health, ended, totals } = speechHealth();
	health.observe("speech.started", { voice: "classic", route: "aura" });
	health.observe("aura.retry", {
		sentence: 0,
		replayed: false,
		played: false,
	});
	health.observe("speech.synthesized", { played: false });
	health.observe("speech.started", { voice: "realtime", kind: "chat" });
	health.observe("realtime.done", { status: "completed" });

	assert.deepEqual(
		ended().map((meta) => [meta.voice, meta.outcome, meta.heardMs]),
		[
			["classic", "failed", 0],
			["realtime", "silent", 0],
		],
	);
	const counted = await totals();
	assert.equal(counted?.replies, 0, "only speech the meeting heard counts");
	assert.equal(counted?.auraRetries, 1);
	assert.equal(counted?.auraRetryFailures, 1);
});

test("a reply queued before the one before it played out ends with it, as one stretch", () => {
	const { health, ended, advance } = speechHealth();
	health.observe("speech.started", { voice: "realtime", kind: "wake" });
	advance(900);
	health.queued(true);
	health.observe("realtime.done", { status: "completed" });
	health.observe("speech.started", { voice: "realtime", kind: "tool" });
	health.queued(false);
	health.ended(reply());

	assert.deepEqual(
		ended().map((meta) => [meta.kind, meta.replies, meta.outcome]),
		[["wake", 2, "completed"]],
	);
});

test("resumes, failed resumes, realtime fallbacks and caps are counted from their events", async () => {
	const { health, totals } = speechHealth();
	health.observe("speech.resumed", { cause: "socket_swap" });
	health.observe("speech.resumed", { cause: "dropped" });
	health.observe("realtime.resume_missed", { cause: "dropped" });
	// Moved to the chat on purpose in the meeting's last two minutes.
	health.observe("realtime.resume_to_chat", { cause: "dropped" });
	health.observe("engine.fallback", { reason: "reconnect_failed" });
	health.observe("realtime.capped", { audioMs: 45_000 });

	assert.deepEqual(await totals(), {
		...ZERO_TOTALS,
		resumes: 2,
		failedResumes: 1,
		fallbacks: 1,
		capped: 1,
	});
});

test("nothing is reported before anything was counted", async () => {
	const { health, posted } = speechHealth();
	assert.equal(await health.report(), true);
	assert.deepEqual(posted, []);
});
