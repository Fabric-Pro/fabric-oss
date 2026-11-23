import assert from "node:assert/strict";
import test from "node:test";
import * as bridgeHarness from "./parlume-meeting-harness.mts";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

class FakeSocket {
	accepted = false;
	accept() {
		this.accepted = true;
	}
	send() {}
	close() {}
	addEventListener() {}
}

type Bridge = {
	onStart(): Promise<void>;
	onConnect(conn: unknown, ctx: { request: { url: string } }): Promise<void>;
	onMessage(conn: unknown, message: string): Promise<void>;
	onRequest(request: Request): Promise<Response>;
	onClose(conn: unknown, code?: number, reason?: string): Promise<void>;
	onError(conn: unknown, error: unknown): Promise<void>;
	onAlarm(): Promise<void>;
};

const STREAM_URL =
	"wss://bridge.example.com/parties/parlume/session-1?token=stream-token";

/**
 * One meeting whose organization has no working OpenAI key, and whose
 * provider can reconnect: every verified stream gets the next generation,
 * as Fabric's verify-stream gives it. `fabric` sets what Fabric answers.
 * `data` is the storage a bridge left behind when it restarted.
 */
function meeting(options: { data?: Map<string, unknown> } = {}) {
	const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
	const alarms: number[] = [];
	const hardStopAt = Date.now() + 3_600_000;
	const fabric = { captureStopped: false, streamClosedFailures: 0 };
	let streamGeneration = 0;
	const fetch = async (url: unknown, init: unknown) => {
		const { body } = (init ?? {}) as { body?: string };
		const path = new URL(String(url)).pathname;
		requests.push({
			path,
			body: typeof body === "string" ? JSON.parse(body) : {},
		});
		if (path.endsWith("/verify-stream")) {
			return Response.json({
				valid: true,
				hardStopAt: new Date(hardStopAt).toISOString(),
				streamGeneration: ++streamGeneration,
			});
		}
		if (
			path.endsWith("/stream-closed") &&
			fabric.streamClosedFailures > 0
		) {
			fabric.streamClosedFailures--;
			return Response.json(
				{ error: "Finalization retry required" },
				{ status: 503 },
			);
		}
		if (path.endsWith("/realtime-session")) {
			return Response.json(
				{ engine: "classic", reason: "mint_failed" },
				{ status: 404 },
			);
		}
		if (path.endsWith("/verify-access")) {
			return Response.json({
				accepted: true,
				captureStopped: fabric.captureStopped,
			});
		}
		return Response.json({ accepted: true });
	};
	const data = options.data ?? new Map<string, unknown>();
	const storage = {
		get: async (key: string) => data.get(key),
		put: async (key: string | Record<string, unknown>, value?: unknown) => {
			if (typeof key === "string") {
				data.set(key, value);
			} else {
				for (const [k, v] of Object.entries(key)) {
					data.set(k, v);
				}
			}
		},
		delete: async (key: string) => data.delete(key),
		setAlarm: async (at: number) => {
			alarms.push(at);
		},
	};
	const { Parlume } = loadParlumeModule("./parlume.ts", fetch) as {
		Parlume: new (ctx: unknown, env: unknown) => Bridge;
	};
	const bridge = new Parlume(
		{ storage, waitUntil: (work: Promise<unknown>) => void work },
		{
			FABRIC_API_URL: "https://fabric.example",
			AGENT_SERVICE_SECRET: "service-secret",
			AI: {
				run: async () => ({ status: 101, webSocket: new FakeSocket() }),
			},
		},
	);
	const paths = (name: string) =>
		requests.filter((request) => request.path.endsWith(`/${name}`));
	return { bridge, requests, paths, alarms, hardStopAt, fabric, data };
}

const flush = async () => {
	for (let index = 0; index < 10; index++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
};

let clock = 1_000_000;
function audio() {
	clock += 10;
	return JSON.stringify({
		trigger: "realtime_audio.mixed",
		bot_id: "bot_abc123",
		data: {
			chunk: Buffer.alloc(320).toString("base64"),
			timestamp_ms: clock,
			sample_rate: 16_000,
		},
	});
}

function socket() {
	return { send() {}, close() {} };
}

async function stream(bridge: Bridge) {
	const connection = socket();
	await bridge.onConnect(connection, { request: { url: STREAM_URL } });
	for (let chunk = 0; chunk < 4; chunk++) {
		await bridge.onMessage(connection, audio());
	}
	await flush();
	return connection;
}

function control(action: string) {
	return new Request(
		`https://bridge.example.com/parties/parlume/session-1?action=${action}`,
		{
			method: "POST",
			headers: { Authorization: "Bearer service-secret" },
			body: "{}",
		},
	);
}

test("a provider reconnect that never closed its old socket still reports the stream closed", async () => {
	const live = meeting();
	await live.bridge.onStart();
	// The provider reconnects twice; neither old socket ever reports a close.
	await stream(live.bridge);
	await stream(live.bridge);
	const latest = await stream(live.bridge);
	assert.equal(live.paths("verify-stream").length, 3);

	// The bot leaves: Fabric closes the bridge, and the latest socket closes.
	await live.bridge.onRequest(control("close"));
	await live.bridge.onClose(latest, 1000, "meeting ended");
	await flush();

	assert.equal(live.paths("interrupt").length, 1);
	assert.deepEqual(
		live.paths("stream-closed").map((request) => request.body),
		[{ sessionId: "session-1", botId: "bot_abc123", streamGeneration: 3 }],
	);
	// Fabric's access check sees no socket left, so it can finalize too.
	await live.bridge.onAlarm();
	assert.equal(live.paths("verify-access").at(-1)?.body.openConnections, 0);
});

test("an old socket that closes after its replacement verified does not end the meeting", async () => {
	const live = meeting();
	await live.bridge.onStart();
	const first = await stream(live.bridge);
	const second = await stream(live.bridge);

	await live.bridge.onClose(first, 1006, "gone");
	await flush();
	assert.equal(live.paths("interrupt").length, 0);
	assert.equal(live.paths("stream-closed").length, 0);

	await live.bridge.onClose(second, 1000, "meeting ended");
	await flush();
	assert.deepEqual(
		live.paths("stream-closed").map((request) => request.body),
		[{ sessionId: "session-1", botId: "bot_abc123", streamGeneration: 2 }],
	);
});

test("a socket that fails instead of closing still reports the stream closed", async () => {
	const live = meeting();
	await live.bridge.onStart();
	const connection = await stream(live.bridge);

	await live.bridge.onError(
		connection,
		new Error("Network connection lost."),
	);
	await flush();

	assert.deepEqual(
		live.paths("stream-closed").map((request) => request.body),
		[{ sessionId: "session-1", botId: "bot_abc123", streamGeneration: 1 }],
	);
});

test("realtime refused once stays classic across provider reconnects", async () => {
	const live = meeting();
	await live.bridge.onStart();
	const first = await stream(live.bridge);
	await live.bridge.onClose(first, 1006, "gone");
	await flush();
	const second = await stream(live.bridge);
	await stream(live.bridge);
	await live.bridge.onClose(second, 1006, "gone");

	assert.equal(live.paths("verify-stream").length, 3);
	assert.equal(live.paths("realtime-session").length, 1);
});

test("a close the bridge asks for reports the stream closed even when the socket never answers", async () => {
	const live = meeting();
	await live.bridge.onStart();
	const connection = await stream(live.bridge);

	// The socket is half-open: no close or error ever reaches the bridge.
	const response = await live.bridge.onRequest(control("close"));
	assert.deepEqual(await response.json(), { closed: 1 });
	await flush();
	assert.equal(live.paths("interrupt").length, 1);
	assert.deepEqual(
		live.paths("stream-closed").map((request) => request.body),
		[{ sessionId: "session-1", botId: "bot_abc123", streamGeneration: 1 }],
	);

	// A close the runtime delivers late does not report it again.
	await live.bridge.onClose(connection, 1006, "gone");
	await flush();
	assert.equal(live.paths("stream-closed").length, 1);
	assert.equal(live.paths("interrupt").length, 1);
});

// The access check that lets Fabric finalize a session whose stream close
// never reached it waited for the hard stop, four hours away: the session
// stayed LEAVING and the Parlume page took no new invitation.
test("capture stopped on Fabric's side closes the stream and reports it once, then checks access every minute", async () => {
	const live = meeting();
	await live.bridge.onStart();
	const connection = await stream(live.bridge);
	live.fabric.captureStopped = true;

	const before = Date.now();
	await live.bridge.onAlarm();
	assert.deepEqual(
		live.paths("stream-closed").map((request) => request.body),
		[{ sessionId: "session-1", botId: "bot_abc123", streamGeneration: 1 }],
	);
	const next = live.alarms.at(-1) ?? Number.POSITIVE_INFINITY;
	assert.ok(next >= before + 60_000 && next <= Date.now() + 60_000);

	await live.bridge.onClose(connection, 1006, "gone");
	await live.bridge.onAlarm();
	assert.equal(live.paths("stream-closed").length, 1);
	assert.equal(live.paths("verify-access").at(-1)?.body.openConnections, 0);
});

test("a stream-closed report Fabric could not take is retried before the hard stop", async () => {
	const live = meeting();
	await live.bridge.onStart();
	await stream(live.bridge);
	live.fabric.captureStopped = true;
	// Refused by the close itself, and by the access check's own try after it.
	live.fabric.streamClosedFailures = 2;

	await live.bridge.onAlarm();
	assert.equal(live.paths("stream-closed").length, 2);
	assert.ok(
		(live.alarms.at(-1) ?? Number.POSITIVE_INFINITY) < live.hardStopAt,
	);

	await live.bridge.onAlarm();
	assert.equal(live.paths("stream-closed").length, 3);
	assert.ok(
		(live.alarms.at(-1) ?? Number.POSITIVE_INFINITY) <= Date.now() + 60_000,
	);
	await live.bridge.onAlarm();
	assert.equal(live.paths("stream-closed").length, 3);
});

test("a meeting that fell back to classic stays classic after the bridge restarts", async () => {
	const live = meeting();
	await live.bridge.onStart();
	await stream(live.bridge);
	assert.equal(live.paths("realtime-session").length, 1);

	const restarted = meeting({ data: live.data });
	await restarted.bridge.onStart();
	await stream(restarted.bridge);

	assert.equal(restarted.paths("verify-stream").length, 1);
	assert.equal(restarted.paths("realtime-session").length, 0);
});

type Logged = { message: string; meta: Record<string, unknown> };

const frames = (sent: string[]) =>
	sent.filter((message) => message.includes('"realtime_audio.bot_output"'))
		.length;

const auraTexts = (calls: Array<{ inputs: unknown }>) =>
	calls.map((call) => (call.inputs as { text: string }).text);

const heardOf = (data: Map<string, unknown>) =>
	(data.get("spokenRecord") as { heard?: number } | undefined)?.heard ?? 0;

/** The storage as the Durable Object reads it after a restart. */
function restartedStorage(data: Map<string, unknown>) {
	const copy = new Map<string, unknown>();
	for (const [key, value] of data) {
		copy.set(key, structuredClone(value));
	}
	return copy;
}

function resumedLog(logs: Logged[]) {
	const resumed = "[Parlume] speech.resumed";
	return logs.find((entry) => entry.message === resumed)?.meta;
}

async function waitFor(condition: () => boolean) {
	for (let waited = 0; waited < 3_000 && !condition(); waited += 20) {
		await bridgeHarness.sleep(20);
	}
	assert.ok(condition(), "timed out");
}

const REPLY = [
	"The roadmap has two open features.",
	"Both of them ship on Friday.",
	"Nothing is blocked.",
];

// A provider reconnect mid-reply cut the reply off: its rest went to the
// socket the provider had given up on.
test("a bot socket replaced mid-reply carries the rest of it, little of the speech lost over the swap", async () => {
	const live = await bridgeHarness.connectedMeeting({
		aura: bridgeHarness.slowAura,
	});
	const keepAlive = setInterval(() => {}, 1_000);
	const playing = live.bridge.onRequest(bridgeHarness.say(REPLY));
	await waitFor(() => frames(live.sent) > 0);

	const replacementSent: string[] = [];
	const replacement = {
		send: (message: string) => replacementSent.push(message),
		close: () => {},
	};
	await live.bridge.onConnect(replacement, {
		request: { url: bridgeHarness.STREAM_URL },
	});
	await live.bridge.onMessage(replacement, bridgeHarness.audio(1_000_090));
	const oldFrames = frames(live.sent);
	const result = bridgeHarness.plain(await (await playing).json());
	clearInterval(keepAlive);

	assert.equal(result.played, true);
	assert.equal(frames(live.sent), oldFrames, "the old socket gets no more");
	assert.ok(frames(replacementSent) > 0);
	const resumed = resumedLog(live.logs);
	assert.equal(resumed?.cause, "socket_swap");
	assert.ok(Number(resumed?.lostMs) <= 300);
	await live.bridge.onClose(replacement, 1000, "done");
});

// A deploy restarts the bridge's Durable Object mid-reply. The worker asks
// how much was heard and sends the rest again once the bot is back.
test("after the bridge restarts mid-reply, it says how much of the reply was heard, and plays the rest once the bot is back", async () => {
	const live = await bridgeHarness.answeringMeeting();
	const keepAlive = setInterval(() => {}, 1_000);
	void live.bridge.onRequest(
		bridgeHarness.say(
			REPLY,
			{
				"x-parlume-reply": "reply-1",
				"x-parlume-reply-part": "0",
				"x-parlume-reply-last": "1",
			},
			"1",
		),
	);
	await waitFor(() => heardOf(live.data) >= 1);
	const stored = restartedStorage(live.data);
	const heard = heardOf(stored);
	await live.bridge.onClose(live.bot, 1006, "restarted");

	const restarted = bridgeHarness.meeting({
		aura: bridgeHarness.slowAura,
		data: stored,
	});
	await restarted.bridge.onStart();
	const state = async () => {
		const response = await restarted.bridge.onRequest(
			bridgeHarness.control("verify-generation", {
				voiceGeneration: 1,
				replyId: "reply-1",
			}),
		);
		return bridgeHarness.plain(await response.json());
	};
	const lost = await state();
	assert.equal(lost.current, true);
	assert.equal(lost.live, false, "no bot socket yet");
	assert.equal(lost.heard, heard);

	await restarted.bridge.onConnect(restarted.bot, {
		request: { url: bridgeHarness.STREAM_URL },
	});
	await restarted.bridge.onMessage(
		restarted.bot,
		bridgeHarness.audio(1_000_010),
	);
	const back = await state();
	assert.equal(back.live, true);
	assert.equal(back.heard, heard);

	const response = await restarted.bridge.onRequest(
		bridgeHarness.say(REPLY.slice(heard), {}, "1"),
	);
	const resent = bridgeHarness.plain(await response.json());
	clearInterval(keepAlive);
	assert.equal(resent.played, true);
	assert.deepEqual(
		auraTexts(restarted.auraCalls),
		REPLY.slice(heard),
		"the rest starts at the first sentence not heard",
	);
	await restarted.bridge.onClose(restarted.bot, 1000, "done");
});

test("after the bridge restarts mid-read, the post is read on from the first sentence not heard", async () => {
	const live = await bridgeHarness.connectedMeeting({
		aura: bridgeHarness.slowAura,
	});
	const keepAlive = setInterval(() => {}, 1_000);
	await live.bridge.onRequest(
		bridgeHarness.control("chat", { message: REPLY.join(" ") }),
	);
	await live.bridge.onRequest(
		bridgeHarness.control("chat-message", {
			id: "msg_1",
			text: "go P1",
			senderName: "Ana Example",
			senderId: "participant-2",
			toBot: false,
			timestampMs: 1_000_100,
		}),
	);
	await waitFor(() => heardOf(live.data) >= 1);
	const stored = restartedStorage(live.data);
	const heard = heardOf(stored);
	const read = auraTexts(live.auraCalls);
	await live.bridge.onClose(live.bot, 1006, "restarted");

	const restarted = await bridgeHarness.connectedMeeting({
		aura: bridgeHarness.slowAura,
		data: stored,
	});
	await waitFor(() => restarted.auraCalls.length > 0);
	clearInterval(keepAlive);

	assert.equal(auraTexts(restarted.auraCalls)[0], read[heard]);
	assert.equal(resumedLog(restarted.logs)?.cause, "restart");
	await restarted.bridge.onClose(restarted.bot, 1000, "done");
});
