import assert from "node:assert/strict";
import test from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

function load(path: string): Record<string, unknown> {
	return loadParlumeModule(path, (...args) => calls.fetch(...args));
}

const calls: { fetch: (...args: unknown[]) => Promise<Response> } = {
	fetch: async () => Response.json({}),
};

type Storage = {
	data: Map<string, unknown>;
	alarms: number[];
};

function harness(now: number) {
	const storage: Storage = { data: new Map(), alarms: [] };
	const api = {
		get: async (key: string) => storage.data.get(key),
		put: async (key: string | Record<string, unknown>, value?: unknown) => {
			if (typeof key === "string") {
				storage.data.set(key, value);
			} else {
				for (const [k, v] of Object.entries(key)) {
					storage.data.set(k, v);
				}
			}
		},
		delete: async (key: string) => storage.data.delete(key),
		setAlarm: async (at: number) => {
			storage.alarms.push(at);
		},
	};
	storage.data.set("bridge", {
		sessionId: "session-1",
		botId: "bot-1",
		hardStopAt: new Date(now + 3_600_000).toISOString(),
	});
	const { Parlume } = load("./parlume.ts") as {
		Parlume: new (
			ctx: { storage: typeof api },
			env: Record<string, string>,
		) => {
			onStart(): Promise<void>;
			onAlarm(): Promise<void>;
			lastActivityAt: number;
			playbackActive: boolean;
		};
	};
	const instance = new Parlume(
		{ storage: api },
		{
			FABRIC_API_URL: "https://fabric.example",
			AGENT_SERVICE_SECRET: "service-secret",
		},
	);
	return { instance, storage };
}

function fabricStub(requests: Array<{ path: string; body: unknown }>) {
	calls.fetch = async (url: unknown, init: unknown) => {
		const path = new URL(String(url)).pathname;
		const body = JSON.parse(String((init as RequestInit).body));
		requests.push({ path, body });
		if (path.endsWith("/verify-access")) {
			return Response.json({ accepted: true, captureStopped: false });
		}
		return Response.json({ accepted: true });
	};
}

test("reports a meeting idle for three minutes once, then leaves the session alone", async () => {
	const now = Date.now();
	const { instance, storage } = harness(now);
	const requests: Array<{ path: string; body: unknown }> = [];
	fabricStub(requests);
	await instance.onStart();
	instance.lastActivityAt = now - 3 * 60 * 1000 - 1;

	await instance.onAlarm();

	const access = requests.find((r) => r.path.endsWith("/verify-access"));
	assert.deepEqual(access?.body, {
		sessionId: "session-1",
		botId: "bot-1",
		openConnections: 0,
	});
	const idle = requests.filter((r) => r.path.endsWith("/idle"));
	assert.equal(idle.length, 1);
	assert.deepEqual(
		{ ...(idle[0].body as Record<string, unknown>), idleMs: undefined },
		{ sessionId: "session-1", botId: "bot-1", idleMs: undefined },
	);
	assert.ok((idle[0].body as { idleMs: number }).idleMs >= 3 * 60 * 1000);
	assert.equal(storage.data.get("idleReported"), true);

	await instance.onAlarm();
	assert.equal(requests.filter((r) => r.path.endsWith("/idle")).length, 1);
});

test("does not report an attended or speaking meeting", async () => {
	const now = Date.now();
	const { instance } = harness(now);
	const requests: Array<{ path: string; body: unknown }> = [];
	fabricStub(requests);
	await instance.onStart();

	instance.lastActivityAt = now - 2 * 60 * 1000;
	await instance.onAlarm();
	assert.equal(requests.filter((r) => r.path.endsWith("/idle")).length, 0);

	instance.lastActivityAt = now - 10 * 60 * 1000;
	instance.playbackActive = true;
	await instance.onAlarm();
	assert.equal(requests.filter((r) => r.path.endsWith("/idle")).length, 0);
});

test("resumes the idle window from storage after a restart", async () => {
	const now = Date.now();
	const { instance, storage } = harness(now);
	storage.data.set("lastActivityAt", now - 4 * 60 * 1000);
	const requests: Array<{ path: string; body: unknown }> = [];
	fabricStub(requests);

	await instance.onStart();
	await instance.onAlarm();

	assert.equal(requests.filter((r) => r.path.endsWith("/idle")).length, 1);
});
