import assert from "node:assert/strict";
import test from "node:test";
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
 */
function meeting() {
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
	const data = new Map<string, unknown>();
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
	return { bridge, requests, paths, alarms, hardStopAt, fabric };
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

test("capture stopped on Fabric's side closes the stream and reports it once, then waits for the hard stop", async () => {
	const live = meeting();
	await live.bridge.onStart();
	const connection = await stream(live.bridge);
	live.fabric.captureStopped = true;

	await live.bridge.onAlarm();
	assert.deepEqual(
		live.paths("stream-closed").map((request) => request.body),
		[{ sessionId: "session-1", botId: "bot_abc123", streamGeneration: 1 }],
	);
	assert.equal(live.alarms.at(-1), live.hardStopAt);

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
	assert.equal(live.alarms.at(-1), live.hardStopAt);
	await live.bridge.onAlarm();
	assert.equal(live.paths("stream-closed").length, 3);
});
