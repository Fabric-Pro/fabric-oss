import assert from "node:assert/strict";
import test from "node:test";
import {
	answeringMeeting,
	audio,
	connectedMeeting,
	control,
	flush,
	plain,
	say,
	sleep,
} from "./parlume-meeting-harness.mts";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

// The stop that always works (V4) and the pause (F2), through the bridge.

const MEMBER = { id: "user-1", name: "Dana Member" };

function chatMessage(id: string, text: string) {
	return control("chat-message", {
		id,
		text,
		senderName: "Dev One",
		senderId: "participant-1",
		toBot: false,
		timestampMs: 1_000_100,
	});
}

type Harness = Awaited<ReturnType<typeof connectedMeeting>>;

const chatPosts = (harness: Harness) =>
	harness.requests
		.filter((request) => request.path.endsWith("/parlume/chat"))
		.map((request) => request.body.message);

const interrupts = (harness: Harness) =>
	harness.requests
		.filter((request) => request.path.endsWith("/interrupt"))
		.map((request) => request.body);

const stoppedLogs = (harness: Harness) =>
	harness.logs
		.filter((entry) => entry.meta.event === "parlume.bridge.speech.stopped")
		.map((entry) => entry.meta);

const listeningReports = (harness: Harness) =>
	harness.requests
		.filter((request) => request.path.endsWith("/listening"))
		.map((request) => request.body);

test("a typed stop silences the answer at once, ends its turn as STOPPED, posts one line, and refuses the turn's later posts", async () => {
	const harness = await answeringMeeting();
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = harness.bridge.onRequest(
		say(["The plan is to ship the release on Friday."], {}, "1"),
	);
	await sleep(250);
	const heardBefore = harness.sent.length;
	await harness.bridge.onRequest(chatMessage("msg_1", "stop"));
	await flush();
	const heardAtStop = harness.sent.length;
	const result = plain(await (await playing).json());
	const late = plain(
		await (
			await harness.bridge.onRequest(
				control("chat", {
					message: "The rest of the answer.",
					turnId: "turn-1",
					voiceGeneration: 1,
					final: true,
				}),
			)
		).json(),
	);
	await sleep(100);
	await flush();
	clearInterval(keepAlive);

	assert.ok(heardBefore > 0, "Parlume was speaking");
	assert.equal(result.played, false);
	assert.equal(harness.sent.length, heardAtStop, "nothing more is heard");
	assert.deepEqual(interrupts(harness), [
		{
			sessionId: "session-1",
			botId: "bot_abc123",
			voiceGeneration: 2,
			stop: { cause: "CHAT", by: "Dev One" },
		},
	]);
	assert.deepEqual(late, { sent: false, reason: "stopped" });
	assert.deepEqual(chatPosts(harness), [
		"[P1] **Stopped** · Dev stopped the answer",
	]);
	const [stopped] = stoppedLogs(harness);
	assert.equal(stopped?.cause, "chat");
	assert.equal(stopped?.actorId, "participant-1");
	assert.equal(stopped?.stopped, true);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("the page's Stop speaking button stops an answer still being prepared, named after the member", async () => {
	const harness = await answeringMeeting();

	const response = await harness.bridge.onRequest(
		control("stop-speech", { actor: MEMBER }),
	);
	await flush();

	assert.deepEqual(plain(await response.json()), { changed: true });
	assert.deepEqual(interrupts(harness).at(-1)?.stop, {
		cause: "PAGE",
		by: "Dana Member",
	});
	assert.deepEqual(chatPosts(harness), [
		"[P1] **Stopped** · Dana stopped the answer",
	]);
	assert.equal(stoppedLogs(harness)[0]?.actorId, "user-1");
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a stop with nothing to stop changes nothing and posts nothing", async () => {
	const harness = await connectedMeeting();

	const response = await harness.bridge.onRequest(
		control("stop-speech", { actor: MEMBER }),
	);
	await harness.bridge.onRequest(chatMessage("msg_1", "stop"));
	await flush();

	assert.deepEqual(plain(await response.json()), { changed: false });
	assert.deepEqual(interrupts(harness), []);
	assert.deepEqual(chatPosts(harness), []);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("Say in meeting reads the text in its turn, and is refused while paused or with a guest in", async () => {
	const harness = await connectedMeeting();
	const said = await harness.bridge.onRequest(
		control("read-aloud", {
			text: "F-12 already covers the roadmap export.",
			suggestionId: "suggestion-1",
			actor: MEMBER,
		}),
	);
	assert.deepEqual(plain(await said.json()), { spoken: true });
	for (let waited = 0; waited < 1_000; waited += 20) {
		if (harness.auraCalls.length > 0) {
			break;
		}
		await sleep(20);
	}
	assert.ok(
		harness.auraCalls.some((call) =>
			String((call.inputs as { text: string }).text).includes(
				"already covers the roadmap export",
			),
		),
	);

	const missingActor = await harness.bridge.onRequest(
		control("read-aloud", { text: "Hello.", suggestionId: "s" }),
	);
	assert.equal(missingActor.status, 400);
	const empty = await harness.bridge.onRequest(
		control("read-aloud", { text: " ", actor: MEMBER }),
	);
	assert.equal(empty.status, 400);

	await harness.bridge.onRequest(control("pause", { actor: MEMBER }));
	const paused = await harness.bridge.onRequest(
		control("read-aloud", { text: "Hello.", actor: MEMBER }),
	);
	assert.deepEqual(plain(await paused.json()), { spoken: false });
	await harness.bridge.onClose(harness.bot, 1000, "done");

	const guests = await connectedMeeting({
		verify: async () =>
			Response.json({
				valid: true,
				hardStopAt: new Date(Date.now() + 3_600_000).toISOString(),
				streamGeneration: 1,
				externalInvitees: true,
			}),
	});
	const refused = await guests.bridge.onRequest(
		control("read-aloud", { text: "Hello.", actor: MEMBER }),
	);
	assert.deepEqual(plain(await refused.json()), { spoken: false });
	await guests.bridge.onClose(guests.bot, 1000, "done");
});

test("a page control without a member is refused", async () => {
	const harness = await connectedMeeting();
	const response = await harness.bridge.onRequest(
		control("pause", { actor: { name: "Nobody" } }),
	);
	assert.equal(response.status, 400);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("while paused, meeting audio never reaches Flux, a late transcript stores no segment, and nothing is answered", async () => {
	const harness = await connectedMeeting();
	const keepAlive = setInterval(() => {}, 1_000);

	const paused = await harness.bridge.onRequest(
		control("pause", { actor: MEMBER }),
	);
	await flush();
	const sentToFlux = harness.flux.sent.length;
	for (let end = 1_000_090; end <= 1_000_400; end += 10) {
		await harness.bridge.onMessage(harness.bot, audio(end));
	}
	harness.flux.turn({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.01,
		audio_window_end: 0.05,
		transcript: "Hey Fabric, what is the plan?",
	});
	await harness.bridge.onRequest(
		chatMessage("msg_1", "Parlume, what changed?"),
	);
	await sleep(50);
	await flush();
	clearInterval(keepAlive);

	assert.deepEqual(plain(await paused.json()), { changed: true });
	assert.equal(harness.flux.sent.length, sentToFlux, "no audio sent to Flux");
	const paths = harness.requests.map((request) => request.path);
	assert.equal(
		paths.some((path) => path.endsWith("/segments")),
		false,
	);
	assert.equal(
		paths.some((path) => path.endsWith("/turns")),
		false,
	);
	assert.deepEqual(chatPosts(harness), [
		"[P1] **Listening paused** by Dana\nI hear nothing until a member resumes me on the Parlume page.",
	]);
	const [report] = listeningReports(harness);
	assert.equal(report?.paused, true);
	assert.equal(report?.by, "Dana Member");
	assert.equal(report?.sessionId, "session-1");
	assert.equal(typeof report?.offsetMs, "number");
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("'Parlume, pause' said aloud pauses listening and is never asked of Fabric", async () => {
	const harness = await connectedMeeting();

	harness.flux.turn({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.01,
		audio_window_end: 0.05,
		transcript: "Parlume, pause.",
	});
	await sleep(50);
	await flush();

	const paths = harness.requests.map((request) => request.path);
	assert.equal(
		paths.some((path) => path.endsWith("/turns")),
		false,
	);
	assert.equal(listeningReports(harness)[0]?.paused, true);
	assert.match(String(chatPosts(harness)[0]), /\*\*Listening paused\*\*/);
	assert.equal(
		stoppedLogs(harness)[0]?.cause,
		"pause",
		"the pause runs the one stop first",
	);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a pause ends the answer in progress as STOPPED; resume lets the meeting be heard again", async () => {
	const harness = await answeringMeeting();

	await harness.bridge.onRequest(control("pause", { actor: MEMBER }));
	await flush();
	assert.deepEqual(interrupts(harness).at(-1)?.stop, {
		cause: "PAUSE",
		by: "Dana Member",
	});
	const sentToFlux = harness.flux.sent.length;

	const again = await harness.bridge.onRequest(
		control("pause", { actor: MEMBER }),
	);
	const resumed = await harness.bridge.onRequest(
		control("resume", { actor: MEMBER }),
	);
	for (let end = 1_000_500; end <= 1_000_800; end += 10) {
		await harness.bridge.onMessage(harness.bot, audio(end));
	}
	await flush();

	assert.deepEqual(plain(await again.json()), { changed: false });
	assert.deepEqual(plain(await resumed.json()), { changed: true });
	assert.ok(harness.flux.sent.length > sentToFlux, "audio flows again");
	assert.deepEqual(
		listeningReports(harness).map((report) => report.paused),
		[true, false],
	);
	assert.equal(
		chatPosts(harness).at(-1),
		"[P2] **Listening again** · resumed by Dana",
	);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

// A pause typed in the chat named the Teams name "Dana Member", the resume
// from the page the Fabric account's "Dana": the notices use the first name.
test("the stop, pause and resume notices name a person the same way, whoever reported the name", () => {
	const notices = loadParlumeModule("./parlume-stop.ts", async () =>
		Response.json({}),
	) as {
		parlumeStoppedNotice(actor: unknown, asker: string | null): string;
		parlumePausedNotice(actor: unknown): string;
		parlumeResumedNotice(actor: unknown): string;
	};

	assert.match(
		notices.parlumePausedNotice({ id: "p-1", name: "Dana Member" }),
		/^\*\*Listening paused\*\* by Dana\n/,
	);
	assert.equal(
		notices.parlumeResumedNotice({ id: "user-1", name: "Dana" }),
		"**Listening again** · resumed by Dana",
	);
	assert.equal(
		notices.parlumeStoppedNotice(
			{ id: "p-2", name: "Member, Dana" },
			"Sam Example",
		),
		"**Stopped** · Dana stopped the answer for Sam",
	);
	assert.equal(
		notices.parlumeResumedNotice({ id: null, name: "  " }),
		"**Listening again** · resumed by Someone",
	);
});

test("the paused state survives a Durable Object restart, and a report Fabric missed is sent again", async () => {
	const { ParlumeLiveControls } = loadParlumeModule(
		"./parlume-live-controls.ts",
		async () => Response.json({}),
	) as {
		ParlumeLiveControls: new (
			host: unknown,
		) => {
			load(): Promise<void>;
			paused: boolean;
			pause(actor: unknown): Promise<boolean>;
			flushReports(): Promise<boolean>;
		};
	};
	const data = new Map<string, unknown>();
	const reports: unknown[] = [];
	let fabricUp = false;
	const host = () => ({
		storage: {
			get: async (key: string) => structuredClone(data.get(key)),
			put: async (key: string, value: unknown) => {
				data.set(key, structuredClone(value));
			},
		},
		floor: { stop: async () => ({ stopped: false, asker: null }) },
		postNotice: async () => ({ sent: true, tag: "P1", delivery: "queued" }),
		dropQueued: async () => {},
		bot: async () => ({ sessionId: "session-1", botId: "bot-1" }),
		audioStartedAt: () => 1_000,
		postToFabric: async (_path: string, body: unknown) => {
			if (!fabricUp) {
				return null;
			}
			reports.push(plain(body));
			return Response.json({ accepted: true });
		},
		log: () => {},
		now: () => 61_000,
	});

	const first = new ParlumeLiveControls(host());
	await first.load();
	assert.equal(
		await first.pause({ id: "participant-1", name: "Dev One" }),
		true,
	);

	const restarted = new ParlumeLiveControls(host());
	await restarted.load();
	assert.equal(restarted.paused, true);
	fabricUp = true;
	assert.equal(await restarted.flushReports(), true);
	assert.deepEqual(reports, [
		{
			sessionId: "session-1",
			botId: "bot-1",
			paused: true,
			by: "Dev One",
			at: 61_000,
			offsetMs: 60_000,
		},
	]);
});
