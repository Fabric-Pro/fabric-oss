import assert from "node:assert/strict";
import test from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

const calls: { fetch: (...args: unknown[]) => Promise<Response> } = {
	fetch: async () => Response.json({}),
};

/** Fabric accepts every report except those whose path ends in a refused suffix. */
function fabric(refused: Set<string>, requests: string[]) {
	calls.fetch = async (url: unknown) => {
		const path = new URL(String(url)).pathname;
		requests.push(path);
		if ([...refused].some((suffix) => path.endsWith(suffix))) {
			return new Response("unavailable", { status: 503 });
		}
		if (path.endsWith("/verify-access")) {
			return Response.json({ accepted: true, captureStopped: false });
		}
		return Response.json({ accepted: true });
	};
}

/**
 * A bridge whose meeting passed its hard stop with reports still to send. A
 * session that never had a bot has no transcript segments.
 */
function endedMeeting(
	botId: string | null = "bot-1",
	console?: Pick<Console, "info" | "warn" | "error" | "log">,
) {
	const data = new Map<string, unknown>();
	let alarm: number | null = null;
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
		deleteAll: async () => data.clear(),
		setAlarm: async (at: number) => {
			alarm = at;
		},
		getAlarm: async () => alarm,
		deleteAlarm: async () => {
			alarm = null;
		},
	};
	data.set("bridge", {
		sessionId: "session-1",
		botId,
		hardStopAt: new Date(Date.now() - 60_000).toISOString(),
	});
	if (botId) {
		data.set("pendingSegments", [
			{
				sessionId: "session-1",
				botId,
				text: "We ship on Friday.",
				speakerName: "Attendee One",
				speakerId: "speaker-1",
				utteranceStartMs: 1_000,
				utteranceEndMs: 2_000,
			},
		]);
	}
	data.set("listening", {
		paused: false,
		reports: [
			{
				paused: true,
				by: "Attendee One",
				at: Date.now() - 120_000,
				offsetMs: 5_000,
			},
			{
				paused: false,
				by: "Attendee One",
				at: Date.now() - 90_000,
				offsetMs: 9_000,
			},
		],
	});
	const { Parlume } = loadParlumeModule(
		"./parlume.ts",
		(...args) => calls.fetch(...args),
		console,
	) as {
		Parlume: new (
			ctx: { storage: typeof storage },
			env: Record<string, string>,
		) => {
			onStart(): Promise<void>;
			onAlarm(): Promise<void>;
			onRequest(request: Request): Promise<Response>;
			onConnect(
				connection: { send(): void; close(): void },
				context: { request: { url: string } },
			): Promise<void>;
		};
	};
	const bridge = new Parlume(
		{ storage },
		{
			FABRIC_API_URL: "https://fabric.example",
			AGENT_SERVICE_SECRET: "service-secret",
		},
	);
	return { bridge, data, storage, alarm: () => alarm };
}

const STREAM_URL =
	"wss://bridge.example.com/parties/parlume/session-1?token=stream-token";

function purgeRequest(secret = "service-secret") {
	return new Request(
		"https://bridge.example.com/parties/parlume/session-1?action=purge",
		{ method: "POST", headers: { Authorization: `Bearer ${secret}` } },
	);
}

test("keeps the meeting in storage while a pause report has not reached Fabric", async () => {
	const meeting = endedMeeting();
	const requests: string[] = [];
	fabric(new Set(["/listening"]), requests);
	await meeting.bridge.onStart();

	await meeting.bridge.onAlarm();

	assert.ok(requests.some((path) => path.endsWith("/watchdog")));
	assert.ok(meeting.data.has("bridge"), "the bridge state stays");
	assert.equal(
		(meeting.data.get("listening") as { reports: unknown[] }).reports
			.length,
		2,
	);
	assert.ok(
		(meeting.alarm() ?? 0) > Date.now(),
		"the alarm retries the report",
	);
});

test("keeps the meeting in storage while transcript segments have not reached Fabric", async () => {
	const meeting = endedMeeting();
	const requests: string[] = [];
	fabric(new Set(["/segments"]), requests);
	await meeting.bridge.onStart();

	await meeting.bridge.onAlarm();

	assert.ok(meeting.data.has("bridge"));
	assert.equal((meeting.data.get("pendingSegments") as unknown[]).length, 1);
	assert.ok((meeting.alarm() ?? 0) > Date.now());
});

test("empties storage and clears the alarm once Fabric has every report", async () => {
	const meeting = endedMeeting();
	const requests: string[] = [];
	const refused = new Set(["/listening"]);
	fabric(refused, requests);
	await meeting.bridge.onStart();
	await meeting.bridge.onAlarm();
	assert.ok(meeting.data.has("bridge"));

	refused.clear();
	await meeting.bridge.onAlarm();

	assert.equal(
		requests.filter((path) => path.endsWith("/listening")).length,
		3,
		"the failed report and the one after it are sent",
	);
	assert.ok(requests.some((path) => path.endsWith("/segments")));
	assert.equal(meeting.data.size, 0, "nothing of the meeting stays");
	assert.equal(meeting.alarm(), null, "no alarm wakes the object again");
});

test("drops the pause reports of a session that never had a bot, and empties storage", async () => {
	const meeting = endedMeeting(null);
	const requests: string[] = [];
	fabric(new Set(), requests);
	await meeting.bridge.onStart();

	await meeting.bridge.onAlarm();

	assert.equal(
		requests.filter((path) => path.endsWith("/listening")).length,
		0,
		"no report can name a bot, so none is sent",
	);
	assert.ok(requests.some((path) => path.endsWith("/watchdog")));
	assert.equal(meeting.data.size, 0, "nothing of the meeting stays");
	assert.equal(meeting.alarm(), null, "no alarm wakes the object again");
});

test("keeps the meeting until Fabric acknowledges the watchdog", async () => {
	const meeting = endedMeeting();
	const requests: string[] = [];
	fabric(new Set(["/watchdog"]), requests);
	await meeting.bridge.onStart();

	await meeting.bridge.onAlarm();

	assert.ok(meeting.data.has("bridge"));
	assert.ok((meeting.alarm() ?? 0) > Date.now());
});

test("empties storage and clears the alarm when Fabric says the session is over, and logs it", async () => {
	const logs: unknown[][] = [];
	const meeting = endedMeeting("bot-1", {
		info: (...args: unknown[]) => logs.push(args),
		warn() {},
		error() {},
		log() {},
	});
	fabric(new Set(), []);
	await meeting.bridge.onStart();
	await meeting.storage.setAlarm(Date.now() + 60_000);

	const response = await meeting.bridge.onRequest(purgeRequest());

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { purged: true });
	assert.equal(meeting.data.size, 0, "nothing of the meeting stays");
	assert.equal(meeting.alarm(), null, "no alarm wakes the object again");
	const purged = logs.find(
		([message]) => message === "[Parlume] bridge.purged",
	);
	assert.deepEqual(
		// Logged from the bridge's own context: compared as plain data.
		JSON.parse(JSON.stringify(purged?.[1])),
		{
			component: "parlume-bridge",
			event: "parlume.bridge.bridge.purged",
			sessionId: "session-1",
			reason: "fabric",
		},
	);
});

test("refuses to purge while a stream is still connected", async () => {
	const meeting = endedMeeting();
	fabric(new Set(), []);
	await meeting.bridge.onStart();
	await meeting.bridge.onConnect(
		{ send() {}, close() {} },
		{ request: { url: STREAM_URL } },
	);

	const response = await meeting.bridge.onRequest(purgeRequest());

	assert.equal(response.status, 409);
	assert.ok(meeting.data.has("bridge"), "the bridge state stays");
	assert.equal((meeting.data.get("pendingSegments") as unknown[]).length, 1);
});

test("refuses a purge without the service secret", async () => {
	const meeting = endedMeeting();
	await meeting.bridge.onStart();

	const response = await meeting.bridge.onRequest(purgeRequest("guess"));

	assert.equal(response.status, 401);
	assert.ok(meeting.data.has("bridge"));
});
