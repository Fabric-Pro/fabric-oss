import assert from "node:assert/strict";
import test from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));

type Bridge = {
	onStart(): Promise<void>;
	onAlarm(): Promise<void>;
	onRequest(request: Request): Promise<Response>;
};

function bridge(
	options: { suggestionsEnabled?: boolean; turnBusy?: boolean } = {},
) {
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
	const data = new Map<string, unknown>([
		[
			"bridge",
			{
				sessionId: "session-1",
				botId: "bot-1",
				hardStopAt: new Date(Date.now() + 3_600_000).toISOString(),
				suggestionsEnabled: options.suggestionsEnabled ?? true,
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
			AI: { run: async () => new Response(new Uint8Array(4_800)) },
		},
	);
	return { instance, requests, alarms };
}

function control(action: string, body: unknown) {
	return new Request(
		`https://bridge.example.com/parties/parlume/session-1?action=${action}`,
		{
			method: "POST",
			headers: {
				Authorization: "Bearer service-secret",
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		},
	);
}

test("the worker's chat post leaves the bridge tagged and is answered as queued", async () => {
	const { instance, requests } = bridge();
	await instance.onStart();

	const response = await instance.onRequest(
		control("chat", { message: "Here is F-12.", turnId: "turn-1" }),
	);

	assert.deepEqual(plain(await response.json()), {
		sent: true,
		tag: "P1",
		delivery: "queued",
	});
	assert.deepEqual(requests.find((r) => r.path.endsWith("/chat"))?.body, {
		sessionId: "session-1",
		botId: "bot-1",
		message: "[P1] Here is F-12.",
	});
});

test("a chat message is stored with the transcript as chat, and a typed request reaches Fabric as a chat-answered turn", async () => {
	const { instance, requests } = bridge();
	await instance.onStart();

	const response = await instance.onRequest(
		control("chat-message", {
			id: "msg_1",
			text: "@Fabric Parlume what changed?",
			senderName: "Dev One",
			senderId: "participant-1",
			toBot: false,
			timestampMs: 1_700_000_000_000,
		}),
	);
	await flush();
	await flush();

	assert.equal(response.status, 200);
	const segment = requests.find((r) => r.path.endsWith("/segments"));
	assert.equal(segment?.body.source, "CHAT");
	assert.equal(segment?.body.chatMessageId, "msg_1");
	assert.equal(segment?.body.speakerName, "Dev One");
	const turn = requests.find((r) => r.path.endsWith("/turns"));
	assert.deepEqual(
		{
			text: turn?.body.text,
			replyChannel: turn?.body.replyChannel,
			chatMessageId: turn?.body.chatMessageId,
			voiceGeneration: turn?.body.voiceGeneration,
		},
		{
			text: "what changed?",
			replyChannel: "CHAT",
			chatMessageId: "msg_1",
			voiceGeneration: 1,
		},
	);

	// The chat request's actions may run until its final post.
	const current = async () =>
		plain(
			await (
				await instance.onRequest(
					control("verify-generation", { voiceGeneration: 1 }),
				)
			).json(),
		).current;
	assert.equal(await current(), true);
	await instance.onRequest(
		control("chat", {
			message: "Two things changed.",
			turnId: "turn-1",
			voiceGeneration: 1,
			final: true,
		}),
	);
	assert.equal(await current(), false);
});

test("the alarm runs a due suggestion pass only when the invitation allows it", async () => {
	for (const suggestionsEnabled of [true, false]) {
		const { instance, requests } = bridge({ suggestionsEnabled });
		await instance.onStart();
		await instance.onAlarm();
		assert.equal(
			requests.filter((r) => r.path.endsWith("/suggest")).length,
			0,
			"no pass before any speech",
		);
	}
});

test("a missing post is checked on the alarm too, and refuses later posts when the chat never worked", async () => {
	const { instance, requests } = bridge();
	await instance.onStart();
	await instance.onRequest(control("chat", { message: "The link" }));
	const realNow = Date.now;
	Date.now = () => realNow() + 9_000;
	try {
		await instance.onAlarm();
	} finally {
		Date.now = realNow;
	}

	const report = requests.find((r) => r.path.endsWith("/chat-delivery"));
	assert.equal(report?.body.outcome, "unavailable");
	const refused = await instance.onRequest(
		control("chat", { message: "Another" }),
	);
	assert.deepEqual(plain(await refused.json()), {
		sent: false,
		reason: "chat_unavailable",
	});
});
