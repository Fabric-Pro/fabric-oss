import assert from "node:assert/strict";
import test from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

type Bridge = {
	onStart(): Promise<void>;
	onAlarm(): Promise<void>;
	onRequest(request: Request): Promise<Response>;
};

function bridge(botId: string | null) {
	const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
	const fetch = async (url: unknown, init: unknown) => {
		const path = new URL(String(url)).pathname;
		requests.push({
			path,
			body: JSON.parse(String((init as RequestInit).body)),
		});
		if (path.endsWith("/verify-access")) {
			return Response.json({ accepted: true, captureStopped: false });
		}
		return Response.json({ accepted: true });
	};
	const hardStopAt = Date.now() + 3_600_000;
	const data = new Map<string, unknown>([
		[
			"bridge",
			{
				sessionId: "session-1",
				botId,
				hardStopAt: new Date(hardStopAt).toISOString(),
			},
		],
	]);
	const alarms: number[] = [];
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
	const instance = new Parlume(
		{ storage },
		{
			FABRIC_API_URL: "https://fabric.example",
			AGENT_SERVICE_SECRET: "service-secret",
		},
	);
	return { instance, requests, alarms, hardStopAt };
}

function arm(hardStopAt: number) {
	return new Request(
		"https://bridge.example.com/parties/parlume/session-1?action=",
		{
			method: "POST",
			headers: {
				Authorization: "Bearer service-secret",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				hardStopAt: new Date(hardStopAt).toISOString(),
			}),
		},
	);
}

// Staging, 2026-11-21: Attendee reported a bot nobody admitted only as
// joining, then waiting_room_timeout_exceeded, so the inviter was never told
// to admit it. The bridge's first alarm now checks for a stream.
test("arming the bridge wakes it ninety seconds after the invite, not first at the hard stop", async () => {
	const { instance, alarms, hardStopAt } = bridge(null);
	await instance.onStart();
	const before = Date.now();

	const response = await instance.onRequest(arm(hardStopAt));

	assert.equal(response.status, 200);
	const wakeAt = alarms.at(-1) ?? 0;
	assert.ok(wakeAt >= before + 90_000 && wakeAt <= Date.now() + 90_000);
});

test("a bot that has not streamed by the check asks Fabric for the lobby notice once, then waits for the hard stop", async () => {
	const { instance, requests, alarms, hardStopAt } = bridge(null);
	await instance.onStart();

	await instance.onAlarm();

	assert.deepEqual(
		requests.map((request) => request.path),
		["/api/internal/parlume/lobby"],
	);
	assert.deepEqual(requests[0]?.body, { sessionId: "session-1" });
	assert.equal(alarms.at(-1), hardStopAt);
});

test("a bot that is already streaming sends no lobby notice", async () => {
	const { instance, requests } = bridge("bot-1");
	await instance.onStart();

	await instance.onAlarm();

	assert.ok(!requests.some((request) => request.path.endsWith("/lobby")));
});
