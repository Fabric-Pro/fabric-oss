import assert from "node:assert/strict";
import test from "node:test";
import {
	answeringMeeting,
	audio,
	connectedMeeting,
	control,
	flush,
	plain,
	STREAM_URL,
	say,
	sleep,
} from "./parlume-meeting-harness.mts";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

// An external guest in a meeting (D2) and the one speech gate (V10): while a
// guest is in, Parlume keeps notes only.

const GUEST = "8:teamsvisitor:guest-1";
const guest = (joined: boolean) =>
	control("guests", { updates: [{ id: GUEST, joined }] });

const NOTICE = {
	text: "**Fabric Parlume (AI assistant) is in this meeting**\nI transcribe the meeting and write notes. I keep transcripts for 90 days, and notes until someone deletes them.",
	spoken: "Fabric Parlume, an AI assistant, is in this meeting.",
};

function verified(extra: Record<string, unknown> = {}) {
	return async () =>
		Response.json({
			valid: true,
			hardStopAt: new Date(Date.now() + 3_600_000).toISOString(),
			streamGeneration: 1,
			...extra,
		});
}

const stopped = (logs: Array<{ meta: Record<string, unknown> }>) =>
	logs
		.filter((entry) => entry.meta.event === "parlume.bridge.speech.stopped")
		.map((entry) => entry.meta.cause);

// Over two seconds of whole meeting audio after the harness's first 80 ms:
// Parlume welcomes the meeting only once its audio arrives whole.
async function wholeAudio(
	bridge: { onMessage(conn: unknown, message: string): Promise<void> },
	conn: unknown,
	fromMs = 1_000_090,
) {
	for (let end = fromMs; end <= fromMs + 2_100; end += 10) {
		await bridge.onMessage(conn, audio(end));
	}
	await flush();
	await flush();
}

const chatPosts = (
	requests: Array<{ path: string; body: Record<string, unknown> }>,
) =>
	requests
		.filter((request) => request.path.endsWith("/chat"))
		.map((request) => request.body.message);

const GUESTS_NOTICE =
	"**Notes only** · a guest is in this meeting\nI keep notes. I do not speak or answer in this chat while a guest is here.";

let shownCount = 0;

/** The meeting chat shows Parlume's post, as Attendee relays it. */
async function shownInChat(
	bridge: { onRequest(request: Request): Promise<Response> },
	text: string,
) {
	shownCount += 1;
	await bridge.onRequest(
		control("chat-message", {
			id: `shown-${shownCount}`,
			text,
			senderName: "Fabric Parlume",
			senderId: "parlume-bot",
			toBot: false,
			timestampMs: 1_000_500,
		}),
	);
	await flush();
	await flush();
}

// Fabric says why in the chat and has Parlume leave: no notes-only notice
// comes first.
test("a guest who joins mid-answer silences Parlume at once, and speech.stopped names the guest", async () => {
	const { bridge, bot, sent, logs, requests } = await answeringMeeting();
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = bridge.onRequest(
		say(["The plan is to ship the release on Friday."], {}, "1"),
	);
	await sleep(250);
	const heardBefore = sent.length;
	const joined = await bridge.onRequest(guest(true));
	const heardAt = sent.length;
	const result = plain(await (await playing).json());
	await sleep(200);
	await flush();
	clearInterval(keepAlive);

	assert.ok(heardBefore > 0, "Parlume was speaking");
	assert.equal(joined.status, 200);
	assert.equal(result.played, false);
	assert.equal(sent.length, heardAt, "nothing more reaches the meeting");
	assert.deepEqual(stopped(logs), ["guest"]);
	assert.deepEqual(chatPosts(requests), []);
	await bridge.onClose(bot, 1000, "done");
});

type Guests = {
	load(): Promise<void>;
	expectChecks(checks: boolean): Promise<void>;
	update(
		relay: unknown,
	): Promise<{ guestArrived: boolean; closed: boolean; opened: boolean }>;
	attendees(): string[];
	userFor(id: string | null): string | null;
	readonly open: boolean;
	readonly present: boolean;
};

function guestsModule() {
	return loadParlumeModule("./parlume-guests.ts", async () =>
		Response.json({}),
	) as {
		ParlumeGuests: new (storage: unknown) => Guests;
		parseParlumeGuestUpdates(body: unknown): unknown;
	};
}

function memoryStorage() {
	const data = new Map<string, unknown>();
	return {
		data,
		get: async (key: string) => data.get(key),
		put: async (key: string, value: unknown) => {
			data.set(key, value);
		},
	};
}

test("where Fabric checks the meeting, Parlume answers once someone is confirmed and never while anyone is being checked", async () => {
	const { ParlumeGuests, parseParlumeGuestUpdates } = guestsModule();
	const storage = memoryStorage();
	const guests = new ParlumeGuests(storage);
	const relay = (updates: unknown[], placing: unknown[]) =>
		guests.update(parseParlumeGuestUpdates({ updates, placing }));
	const checking = (id: string) => ({ id, pending: true });
	const confirmed = (id: string, userId: string) => ({
		id,
		pending: false,
		userId,
	});

	assert.equal(guests.open, true, "a Fabric that does not check");
	await guests.expectChecks(true);
	assert.equal(guests.open, false, "no one is confirmed yet");

	await relay([], [checking("8:orgid:a")]);
	assert.equal(guests.open, false);
	await relay([], [confirmed("8:orgid:a", "user-a")]);
	assert.equal(guests.open, true);
	assert.deepEqual(plain(guests.attendees()), ["user-a"]);

	assert.deepEqual(plain(await relay([], [checking("8:orgid:b")])), {
		guestArrived: false,
		closed: true,
		opened: false,
	});
	assert.equal(guests.present, false, "being checked is not a guest");
	assert.deepEqual(
		plain(
			await relay(
				[{ id: "8:orgid:b", joined: true }],
				[{ id: "8:orgid:b", pending: false }],
			),
		),
		{ guestArrived: true, closed: false, opened: false },
	);
	await relay(
		[{ id: "8:orgid:b", joined: false }],
		[{ id: "8:orgid:b", pending: false }],
	);
	assert.equal(guests.open, true);

	// A restarted Durable Object reads the same room back.
	const restarted = new ParlumeGuests(storage);
	await restarted.load();
	assert.equal(restarted.open, true);
	assert.deepEqual(plain(restarted.attendees()), ["user-a"]);

	await relay(
		[{ id: "8:orgid:a", joined: false }],
		[{ id: "8:orgid:a", pending: false }, checking("8:orgid:c")],
	);
	assert.deepEqual(plain(guests.attendees()), [], "the confirmed one left");
	assert.equal(guests.open, false);
});

test("an outcome or a repeated join that arrives after the participant left puts no one back", async () => {
	const { ParlumeGuests, parseParlumeGuestUpdates } = guestsModule();
	const guests = new ParlumeGuests(memoryStorage());
	const relay = (updates: unknown[], placing: unknown[]) =>
		guests.update(parseParlumeGuestUpdates({ updates, placing }));
	const checking = (id: string, at: number) =>
		relay([], [{ id, pending: true, at }]);
	const confirmed = (id: string, userId: string, at: number) =>
		relay([], [{ id, pending: false, userId, at }]);
	const refused = (id: string, at: number) =>
		relay([{ id, joined: true }], [{ id, pending: false, at }]);
	const left = (id: string, at: number) =>
		relay([{ id, joined: false }], [{ id, pending: false, at }]);

	await guests.expectChecks(true);
	await checking("8:orgid:a", 100);
	await confirmed("8:orgid:a", "user-a", 100);

	await checking("8:orgid:b", 200);
	await left("8:orgid:b", 300);
	await confirmed("8:orgid:b", "user-b", 200);
	assert.deepEqual(plain(guests.attendees()), ["user-a"]);
	assert.equal(guests.open, true);

	await checking("8:teamsvisitor:c", 400);
	await left("8:teamsvisitor:c", 500);
	await refused("8:teamsvisitor:c", 400);
	assert.equal(guests.present, false, "a refused guest who left");
	assert.equal(guests.open, true);

	// Attendee delivers the joins again after the leaves.
	await checking("8:orgid:b", 200);
	assert.equal(guests.open, true, "a repeated join is not checked again");
	await confirmed("8:orgid:b", "user-b", 200);
	await checking("8:teamsvisitor:c", 400);
	await refused("8:teamsvisitor:c", 400);
	assert.deepEqual(plain(guests.attendees()), ["user-a"]);
	assert.equal(guests.present, false);

	// Joining again later is a new join, checked as any other.
	await checking("8:orgid:b", 600);
	assert.equal(guests.open, false);
	await confirmed("8:orgid:b", "user-b", 600);
	assert.deepEqual(plain(guests.attendees()), ["user-a", "user-b"]);
	assert.equal(guests.open, true);
});

test("a check Fabric relays must name the participant and say where it is", () => {
	const { parseParlumeGuestUpdates } = guestsModule();
	const parsed = (placing: unknown) =>
		parseParlumeGuestUpdates({ updates: [], placing });

	assert.equal(parsed([{ id: "8:orgid:a" }]), null);
	assert.equal(
		parsed([{ id: "8:orgid:a", pending: false, userId: 5 }]),
		null,
	);
	assert.equal(
		parsed([{ id: "8:orgid:a", pending: true, at: "soon" }]),
		null,
	);
	assert.equal(parsed({ id: "8:orgid:a", pending: true }), null);
	assert.deepEqual(
		plain(
			parseParlumeGuestUpdates({
				updates: [{ id: "8:teamsvisitor:g", joined: true }],
			}),
		),
		{
			updates: [{ id: "8:teamsvisitor:g", joined: true }],
			placing: [],
		},
		"a relay without checks is read as before",
	);
});

test("while someone who joined is checked, Parlume stops speaking and posts nothing; once they are confirmed it answers again", async () => {
	const { bridge, bot, sent, logs, requests } = await answeringMeeting();
	const keepAlive = setInterval(() => {}, 1_000);
	const placing = (placement: Record<string, unknown>) =>
		bridge.onRequest(
			control("guests", {
				updates: [],
				placing: [{ id: "8:orgid:b", ...placement }],
			}),
		);

	const playing = bridge.onRequest(
		say(["The plan is to ship the release on Friday."], {}, "1"),
	);
	await sleep(250);
	await placing({ pending: true });
	const heardAt = sent.length;
	const result = plain(await (await playing).json());
	await bridge.onRequest(control("chat", { message: "Here is F-12." }));
	await sleep(200);
	await flush();

	assert.equal(result.played, false);
	assert.equal(sent.length, heardAt, "nothing more reaches the meeting");
	assert.deepEqual(stopped(logs), ["guest"]);
	assert.deepEqual(chatPosts(requests), []);

	await placing({ pending: false, userId: "user-b" });
	await bridge.onRequest(control("chat", { message: "Here is F-12." }));
	clearInterval(keepAlive);
	assert.deepEqual(chatPosts(requests), ["[P1] Here is F-12."]);
	await bridge.onClose(bot, 1000, "done");
});

test("a recap made before Fabric confirms anyone waits, and is posted once when the chat opens", async () => {
	const { bridge, bot, requests } = await connectedMeeting({
		verify: verified({ checksAttendees: true }),
	});
	const recap = "Since last time: F-12 shipped and F-14 is in review.";
	const placing = (placement: Record<string, unknown>) =>
		bridge.onRequest(
			control("guests", {
				updates: [],
				placing: [{ id: "8:orgid:a", ...placement }],
			}),
		);

	const response = await bridge.onRequest(
		control("chat", { message: recap, plain: true }),
	);
	const held = plain(await response.json());
	await placing({ pending: true });
	await flush();

	assert.deepEqual(held, { sent: false, reason: "guests_present" });
	assert.deepEqual(chatPosts(requests), []);

	await placing({ pending: false, userId: "user-a" });
	await flush();
	await placing({ pending: true });
	await placing({ pending: false, userId: "user-a" });
	await flush();

	assert.deepEqual(chatPosts(requests), [`[P1] ${recap}`]);
	assert.equal(
		requests.find((request) => request.path.endsWith("/chat"))?.body.plain,
		true,
		"posted as one paragraph",
	);
	await bridge.onClose(bot, 1000, "done");
});

test("while a guest is in, say, speak and a post read aloud all refuse; once they leave, Parlume speaks again", async () => {
	const { bridge, bot, auraCalls } = await connectedMeeting();
	await bridge.onRequest(control("chat", { message: "Here is F-12." }));
	await bridge.onRequest(guest(true));
	await flush();

	const said = plain(await (await bridge.onRequest(say(["Hello."]))).json());
	const spoken = plain(
		await (
			await bridge.onRequest(
				new Request(
					"https://bridge.example.com/parties/parlume/session-1?action=speak",
					{
						method: "POST",
						headers: {
							Authorization: "Bearer service-secret",
							"content-type": "audio/pcm",
							"x-parlume-voice-generation": "0",
						},
						body: new Uint8Array(4_800),
					},
				),
			)
		).json(),
	);
	await bridge.onRequest(
		control("chat-message", {
			id: "msg_1",
			text: "say P1",
			senderName: "Dev One",
			senderId: "participant-1",
			toBot: false,
			timestampMs: 1_000_100,
		}),
	);
	await flush();

	assert.deepEqual(said, {
		played: false,
		interrupted: true,
		heard: 0,
		stopped: "guest",
	});
	assert.equal(spoken.played, false);
	assert.equal(spoken.stopped, "guest");
	assert.equal(auraCalls.length, 0, "nothing was synthesized");

	await bridge.onRequest(guest(false));
	const keepAlive = setInterval(() => {}, 1_000);
	const after = plain(await (await bridge.onRequest(say(["Hello."]))).json());
	clearInterval(keepAlive);
	assert.equal(after.played, true);
	await bridge.onClose(bot, 1000, "done");
});

test("past the meeting's cap, a post read aloud is refused as a reply is", async () => {
	const { bridge, bot, auraCalls } = await connectedMeeting({
		verify: async () =>
			Response.json({
				valid: true,
				hardStopAt: new Date(Date.now() + 400).toISOString(),
				streamGeneration: 1,
			}),
	});
	await bridge.onRequest(control("chat", { message: "Here is F-12." }));
	await sleep(500);

	await bridge.onRequest(
		control("chat-message", {
			id: "msg_1",
			text: "say P1",
			senderName: "Dev One",
			senderId: "participant-1",
			toBot: false,
			timestampMs: 1_000_100,
		}),
	);
	await flush();
	const said = await bridge.onRequest(say(["Hello."]));

	assert.equal(auraCalls.length, 0, "nothing was synthesized");
	assert.equal(said.status, 409);
	await bridge.onClose(bot, 1000, "done");
});

test("a guest's wake phrase starts no turn", async () => {
	const { bridge, bot, flux, requests, logs } = await connectedMeeting();
	await bridge.onRequest(guest(true));
	await bridge.onRequest(
		control("speakers", {
			updates: [
				{
					name: "Visitor (Guest)",
					id: GUEST,
					timestamp: 1_000_000,
					isSpeaking: true,
				},
				{
					name: "Visitor (Guest)",
					id: GUEST,
					timestamp: 1_002_000,
					isSpeaking: false,
				},
			],
		}),
	);

	flux.turn({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript: "Hey Fabric, what is the plan?",
	});
	await sleep(300);

	assert.equal(
		requests.some((request) => request.path.endsWith("/turns")),
		false,
	);
	assert.ok(
		logs.some(
			(entry) => entry.meta.event === "parlume.bridge.wake.from_guest",
		),
	);
	await bridge.onClose(bot, 1000, "done");
});

// The recap and the join notice were sent to the chat at the same time,
// and the recap arrived first. Sent a moment after the join notice, a post
// never showed in a live meeting.
test("a recap that comes before the join notice of a verified stream is posted once the chat shows the join notice", async () => {
	const { bridge, bot, requests } = await connectedMeeting({
		verify: verified({ joinNotice: NOTICE }),
	});
	const recap = "Since last time: F-12 shipped and F-14 is in review.";

	const response = await bridge.onRequest(
		control("chat", { message: recap, plain: true }),
	);
	await flush();

	assert.deepEqual(plain(await response.json()), {
		sent: false,
		reason: "guests_present",
	});
	assert.deepEqual(chatPosts(requests), []);

	await wholeAudio(bridge, bot);
	await flush();

	assert.deepEqual(
		chatPosts(requests),
		[`[P1] ${NOTICE.text}`],
		"Fabric took the join notice, but the chat has not shown it",
	);

	await shownInChat(bridge, `[P1] ${NOTICE.text}`);

	assert.deepEqual(chatPosts(requests), [
		`[P1] ${NOTICE.text}`,
		`[P2] ${recap}`,
	]);
	await bridge.onClose(bot, 1000, "done");
});

// Sent 0.17 s after the join notice, the guests notice never showed in a
// live meeting.
test("an invitation that names a guest gets the join notice, then the guests notice once the chat shows the join notice, and the meeting stays on the classic voice", async () => {
	const { bridge, bot, requests } = await connectedMeeting({
		verify: verified({ joinNotice: NOTICE, externalInvitees: true }),
	});
	await flush();
	await flush();
	assert.deepEqual(chatPosts(requests), [], "the audio is not whole yet");
	await wholeAudio(bridge, bot);

	assert.deepEqual(chatPosts(requests), [`[P1] ${NOTICE.text}`]);
	await shownInChat(bridge, `[P1] ${NOTICE.text}`);
	assert.deepEqual(chatPosts(requests), [
		`[P1] ${NOTICE.text}`,
		`[P2] ${GUESTS_NOTICE}`,
	]);
	// Fabric records when the meeting got the join notice: posting the
	// guests notice first delayed that record by the post's round trip.
	const recorded = requests.findIndex((request) =>
		request.path.endsWith("/join-notice"),
	);
	const guestsPost = requests.findIndex(
		(request) => request.body.message === `[P2] ${GUESTS_NOTICE}`,
	);
	assert.ok(recorded >= 0 && recorded < guestsPost);
	await shownInChat(bridge, `[P1] ${NOTICE.text}`);
	assert.equal(
		chatPosts(requests).length,
		2,
		"the guests notice is posted once",
	);
	assert.equal(
		requests.some((request) => request.path.endsWith("/realtime-session")),
		false,
		"no realtime audio while a guest is in",
	);
	const said = plain(await (await bridge.onRequest(say(["Hello."]))).json());
	assert.equal(said.stopped, "guest");
	await bridge.onClose(bot, 1000, "done");
});

// A request said in the first seconds after the bot joined went unheard: the
// meeting audio arrived with a third of its chunks missing.
test("the join notice waits while the meeting audio arrives with chunks missing, at most fifteen seconds", async () => {
	const { bridge, bot, requests, logs } = await connectedMeeting({
		verify: verified({ joinNotice: NOTICE }),
	});
	for (let end = 1_000_090; end <= 1_005_000; end += 30) {
		await bridge.onMessage(bot, audio(end));
		await bridge.onMessage(bot, audio(end + 10));
	}
	await flush();
	assert.deepEqual(chatPosts(requests), []);

	const realNow = Date.now;
	Date.now = () => realNow() + 16_000;
	try {
		await bridge.onMessage(bot, audio(1_005_100));
	} finally {
		Date.now = realNow;
	}
	await flush();
	await flush();

	assert.deepEqual(chatPosts(requests), [`[P1] ${NOTICE.text}`]);
	const ready = logs.find(
		(entry) => entry.meta.event === "parlume.bridge.welcome.audio_ready",
	);
	assert.equal(ready?.meta.whole, false);
	await bridge.onClose(bot, 1000, "done");
});

/** Runs `run` with the bridge's clock at `at`. */
async function at(time: number, run: () => Promise<unknown>) {
	const realNow = Date.now;
	Date.now = () => time;
	try {
		await run();
		await flush();
		await flush();
	} finally {
		Date.now = realNow;
	}
}

const welcomeAlarm = (alarms: number[], from: number, to: number) =>
	alarms.find((alarm) => alarm >= from + 15_000 && alarm <= to + 15_000);

// The deadline was checked only as chunks arrived, and the alarm came a
// minute later.
test("when the audio stops right after the stream is verified, the alarm gives the join notice fifteen seconds on", async () => {
	const before = Date.now();
	const { bridge, bot, requests, alarms } = await connectedMeeting({
		verify: verified({ joinNotice: NOTICE }),
	});
	const due = welcomeAlarm(alarms, before, Date.now());
	assert.ok(due, "the alarm is brought forward to the deadline");
	assert.deepEqual(chatPosts(requests), []);

	await at(due, () => bridge.onAlarm());

	assert.deepEqual(chatPosts(requests), [`[P1] ${NOTICE.text}`]);
	await bridge.onClose(bot, 1000, "done");
});

test("an alarm whose access check ends the session gives no welcome", async () => {
	const before = Date.now();
	const { bridge, bot, requests, alarms, logs } = await connectedMeeting({
		verify: verified({ joinNotice: NOTICE }),
		verifyAccess: async () => Response.json({ captureStopped: true }),
	});
	const due = welcomeAlarm(alarms, before, Date.now());
	assert.ok(due);

	await at(due, () => bridge.onAlarm());

	assert.deepEqual(chatPosts(requests), []);
	assert.equal(
		logs.some(
			(entry) =>
				entry.meta.event === "parlume.bridge.welcome.audio_ready",
		),
		false,
	);
	await bridge.onClose(bot, 1000, "done");
});

// A reconnect replaced the waiting welcome, and the second verification no
// longer reported the invited guest, so the notes-only notice was lost.
test("a stream that reconnects before its audio is whole still gives the guests notice", async () => {
	const { bridge, bot, requests } = await connectedMeeting({
		verify: verified({ joinNotice: NOTICE, externalInvitees: true }),
	});
	const second = { send() {}, close() {} };
	await bridge.onConnect(second, { request: { url: STREAM_URL } });
	await bridge.onMessage(second, audio(1_000_200));
	await wholeAudio(bridge, second, 1_000_210);
	await shownInChat(bridge, `[P1] ${NOTICE.text}`);

	assert.deepEqual(chatPosts(requests), [
		`[P1] ${NOTICE.text}`,
		`[P2] ${GUESTS_NOTICE}`,
	]);
	await bridge.onClose(second, 1000, "done");
	await bridge.onClose(bot, 1000, "done");
});

// The chat never shows Parlume's posts, so once they expire the bridge treats
// the chat as out of reach and, after a short grace, says the join notice
// instead.
async function chatGivesUp(bridge: { onAlarm(): Promise<void> }) {
	const realNow = Date.now;
	try {
		for (const ahead of [16_000, 21_000]) {
			Date.now = () => realNow() + ahead;
			await bridge.onAlarm();
			await flush();
		}
	} finally {
		Date.now = realNow;
	}
}

const saidAloud = (auraCalls: Array<{ inputs: unknown }>) =>
	auraCalls.map((call) => (call.inputs as { text: string }).text).join(" ");

const joinNoticeSaid = (
	requests: Array<{ path: string; body: Record<string, unknown> }>,
) =>
	requests.some(
		(request) =>
			request.path.endsWith("/join-notice") &&
			request.body.via === "voice",
	);

test("a join notice the chat never shows is still said aloud while a guest is in the meeting", async () => {
	const { bridge, bot, auraCalls, requests } = await connectedMeeting({
		verify: verified({ joinNotice: NOTICE, externalInvitees: true }),
	});
	await wholeAudio(bridge, bot);

	const keepAlive = setInterval(() => {}, 1_000);
	await chatGivesUp(bridge);
	await sleep(300);
	clearInterval(keepAlive);

	assert.ok(saidAloud(auraCalls).includes("an AI assistant"));
	assert.ok(joinNoticeSaid(requests), "Fabric records the notice as said");
	const said = plain(await (await bridge.onRequest(say(["Hello."]))).json());
	assert.equal(said.stopped, "guest", "nothing else is said");
	assert.deepEqual(
		chatPosts(requests),
		[`[P1] ${NOTICE.text}`],
		"no guests notice for a chat out of reach",
	);

	await shownInChat(bridge, `[P1] ${NOTICE.text}`);
	assert.deepEqual(
		chatPosts(requests),
		[`[P1] ${NOTICE.text}`, `[P2] ${GUESTS_NOTICE}`],
		"the guests notice follows once the chat shows a message again",
	);
	await bridge.onClose(bot, 1000, "done");
});

test("when the chat shows other messages but not the join notice, the guests notice follows once the join notice goes unconfirmed", async () => {
	const { bridge, bot, requests } = await connectedMeeting({
		verify: verified({ joinNotice: NOTICE, externalInvitees: true }),
	});
	await wholeAudio(bridge, bot);
	await bridge.onRequest(
		control("chat-message", {
			id: "member-1",
			text: "Morning, all",
			senderName: "Dev One",
			senderId: "participant-1",
			toBot: false,
			timestampMs: 1_000_400,
		}),
	);
	await flush();
	assert.deepEqual(chatPosts(requests), [`[P1] ${NOTICE.text}`]);

	await chatGivesUp(bridge);

	assert.deepEqual(chatPosts(requests), [
		`[P1] ${NOTICE.text}`,
		`[P2] ${GUESTS_NOTICE}`,
	]);
	await bridge.onClose(bot, 1000, "done");
});

test("past the meeting's cap, a join notice the chat never shows is not said aloud", async () => {
	const { bridge, bot, auraCalls, requests } = await connectedMeeting({
		verify: async () =>
			Response.json({
				valid: true,
				hardStopAt: new Date(Date.now() + 400).toISOString(),
				streamGeneration: 1,
				joinNotice: NOTICE,
				externalInvitees: true,
			}),
	});
	await wholeAudio(bridge, bot);
	await sleep(500);

	await chatGivesUp(bridge);

	assert.equal(auraCalls.length, 0, "nothing was synthesized");
	assert.equal(joinNoticeSaid(requests), false);
	await bridge.onClose(bot, 1000, "done");
});

test("the join notice is posted once, however often the stream reconnects", async () => {
	const { bridge, bot, requests } = await connectedMeeting({
		verify: verified({ joinNotice: NOTICE }),
	});
	await wholeAudio(bridge, bot);
	const second = { send() {}, close() {} };
	await bridge.onConnect(second, { request: { url: STREAM_URL } });
	await bridge.onMessage(second, audio(1_003_000));
	await wholeAudio(bridge, second, 1_003_010);

	assert.equal(
		requests.filter((request) => request.path.endsWith("/verify-stream"))
			.length,
		2,
	);
	assert.deepEqual(chatPosts(requests), [`[P1] ${NOTICE.text}`]);
	await bridge.onClose(second, 1000, "done");
	await bridge.onClose(bot, 1000, "done");
});

test("names the Fabric account of a confirmed participant who asks, and of no one else", async () => {
	const { ParlumeGuests, parseParlumeGuestUpdates } = guestsModule();
	const guests = new ParlumeGuests(memoryStorage());
	const relay = (updates: unknown[], placing: unknown[]) =>
		guests.update(parseParlumeGuestUpdates({ updates, placing }));

	await relay([], [{ id: "8:orgid:a", pending: true }]);
	assert.equal(guests.userFor("8:orgid:a"), null, "still being checked");
	await relay([], [{ id: "8:orgid:a", pending: false, userId: "user-a" }]);

	assert.equal(guests.userFor("8:orgid:a"), "user-a");
	assert.equal(guests.userFor("alex"), null, "a name places no one");
	assert.equal(guests.userFor(null), null);
	assert.equal(guests.userFor("constructor"), null);

	await relay(
		[{ id: "8:orgid:a", joined: false }],
		[{ id: "8:orgid:a", pending: false }],
	);
	assert.equal(guests.userFor("8:orgid:a"), null, "they left");
});

test("a spoken request carries the Fabric account of the confirmed participant who asked", async () => {
	const { bridge, bot, flux, requests } = await connectedMeeting();
	const SPEAKER = "8:orgid:00000000-0000-0000-0000-00000000000a";
	await bridge.onRequest(
		control("guests", {
			updates: [],
			placing: [{ id: SPEAKER, pending: true }],
		}),
	);
	await bridge.onRequest(
		control("guests", {
			updates: [],
			placing: [{ id: SPEAKER, pending: false, userId: "user-a" }],
		}),
	);
	await bridge.onRequest(
		control("speakers", {
			updates: [
				{
					name: "Alex",
					id: SPEAKER,
					timestamp: 1_000_000,
					isSpeaking: true,
				},
				{
					name: "Alex",
					id: SPEAKER,
					timestamp: 1_002_000,
					isSpeaking: false,
				},
			],
		}),
	);

	flux.turn({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript: "Hey Fabric, what is the plan?",
	});
	await sleep(300);

	const turn = requests.find((request) => request.path.endsWith("/turns"));
	assert.ok(turn, "the request reached Fabric");
	assert.equal(turn.body.requester, "user-a");
	assert.deepEqual(plain(turn.body.attendees), ["user-a"]);
	await bridge.onClose(bot, 1000, "done");
});
