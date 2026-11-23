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
	return { instance, requests, alarms, data };
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
	// The turn goes along, so Fabric drops the post of a request that ended.
	assert.deepEqual(requests.find((r) => r.path.endsWith("/chat"))?.body, {
		sessionId: "session-1",
		botId: "bot-1",
		message: "[P1] Here is F-12.",
		turnId: "turn-1",
	});
});

// Removed and invited back to the same meeting, Parlume posted a second [P1],
// and "go P1" played the new post instead of the one the participant meant.
test("a session invited back to a meeting continues its chat tags, and an earlier session's tag is answered, not substituted", async () => {
	const { instance, requests, data } = bridge();
	await instance.onStart();
	const verified = data.get("bridge");

	const armed = await instance.onRequest(
		control("", {
			hardStopAt: new Date(Date.now() + 3_600_000).toISOString(),
			chatTagStart: 4,
		}),
	);
	assert.equal(armed.status, 200);
	data.set("bridge", verified);
	const response = await instance.onRequest(
		control("chat", { message: "Here is F-12.", turnId: "turn-1" }),
	);
	assert.equal(plain(await response.json()).tag, "P4");

	for (const [id, text] of [
		["msg_1", "go P1"],
		["msg_2", "say P9"],
	]) {
		await instance.onRequest(
			control("chat-message", {
				id,
				text,
				senderName: "Dev One",
				senderId: "participant-1",
				toBot: false,
				timestampMs: 1_700_000_000_000,
			}),
		);
	}
	await flush();

	assert.deepEqual(
		requests
			.filter((r) => r.path.endsWith("/chat"))
			.map((r) => r.body.message),
		[
			"[P4] Here is F-12.",
			"[P5] P1: This meeting has ended for the Parlume session that posted it, so it can no longer be played.",
			"[P6] P9: There is no P9 in this meeting's chat. Check the tag on the post you mean.",
		],
	);
	assert.equal(
		requests.some((r) => r.path.endsWith("/turns")),
		false,
		"nothing else is asked for in place of the earlier post",
	);
});

test("Fabric's leaving call posts the line that the session's posts can no longer be played, once", async () => {
	const { instance, requests } = bridge();
	await instance.onStart();
	await instance.onRequest(
		control("chat", { message: "Here is F-12.", turnId: "turn-1" }),
	);

	const first = await instance.onRequest(control("leaving", {}));
	const second = await instance.onRequest(control("leaving", {}));

	assert.deepEqual(plain(await first.json()), { posted: true });
	assert.deepEqual(plain(await second.json()), { posted: false });
	assert.deepEqual(
		requests
			.filter((r) => r.path.endsWith("/chat"))
			.map((r) => r.body.message),
		[
			"[P1] Here is F-12.",
			"[P2] Unavailable: P1. This meeting has ended for Parlume, so these posts can no longer be played.",
		],
	);
});

test("Fabric's reason for leaving is posted once, as one plain paragraph, before the leaving line", async () => {
	const { instance, requests } = bridge();
	await instance.onStart();
	await instance.onRequest(
		control("chat", { message: "Here is F-12.", turnId: "turn-1" }),
	);
	const notice =
		"I'm leaving: I could not confirm that Sam Lee can see this project in Fabric. I answer only when everyone in the meeting can.";

	const first = await instance.onRequest(control("leaving", { notice }));
	const second = await instance.onRequest(control("leaving", { notice }));

	assert.deepEqual(plain(await first.json()), {
		posted: true,
		noticed: true,
	});
	assert.deepEqual(plain(await second.json()), {
		posted: false,
		noticed: true,
	});
	const posts = requests.filter((r) => r.path.endsWith("/chat"));
	assert.deepEqual(
		posts.map((r) => r.body.message),
		[
			"[P1] Here is F-12.",
			`[P2] ${notice}`,
			"[P3] Unavailable: P1. This meeting has ended for Parlume, so these posts can no longer be played.",
		],
	);
	assert.equal(posts[1]?.body.plain, true);
});

test("a turn names the confirmed attendees for Fabric to check again", async () => {
	const { instance, requests } = bridge();
	await instance.onStart();
	const ask = async (id: string) => {
		await instance.onRequest(
			control("chat-message", {
				id,
				text: `@Fabric Parlume what changed in ${id}?`,
				senderName: "Dev One",
				senderId: "8:orgid:inviter",
				toBot: false,
				timestampMs: 1_700_000_000_000,
			}),
		);
		await flush();
		await flush();
		// The worker's final post ends the request: one typed while it is
		// answered waits for it.
		await instance.onRequest(
			control("chat", {
				message: "",
				voiceGeneration: 0,
				final: true,
				close: true,
			}),
		);
		return requests.find(
			(r) => r.path.endsWith("/turns") && r.body.chatMessageId === id,
		)?.body.attendees;
	};
	const guests = (updates: unknown[], placing: unknown[]) =>
		instance.onRequest(control("guests", { updates, placing }));
	// Fabric confirms someone only after telling the bridge it is checking them.
	const confirmed = async (id: string, userId: string) => {
		await guests([], [{ id, pending: true }]);
		await guests([], [{ id, pending: false, userId }]);
	};

	assert.deepEqual(await ask("msg_1"), []);
	await confirmed("8:orgid:inviter", "user-1");
	await confirmed("8:orgid:member", "user-2");
	assert.deepEqual(await ask("msg_2"), ["user-1", "user-2"]);
	await guests(
		[{ id: "8:orgid:member", joined: false }],
		[{ id: "8:orgid:member", pending: false }],
	);
	assert.deepEqual(await ask("msg_3"), ["user-1"]);
});

// Fabric marks a participant it could not confirm a guest, and relays that
// mark as it relays any guest: the bridge then takes no request from them,
// though their words are kept in the transcript.
test("a typed request from a participant Fabric marked a guest is kept as a chat line and starts no turn", async () => {
	const { instance, requests } = bridge();
	await instance.onStart();
	const OUTSIDE = "8:orgid:00000000-0000-4000-8000-000000000002";
	const MEMBER = "8:orgid:00000000-0000-4000-8000-000000000001";
	const guests = (updates: unknown[], placing: unknown[]) =>
		instance.onRequest(control("guests", { updates, placing }));
	const ask = async (id: string, senderId: string) => {
		await instance.onRequest(
			control("chat-message", {
				id,
				text: `@Fabric Parlume what changed in ${id}?`,
				senderName: senderId === MEMBER ? "Dev One" : "Pat Example",
				senderId,
				toBot: false,
				timestampMs: 1_700_000_000_000,
			}),
		);
		await flush();
		await flush();
	};
	const turns = () =>
		requests
			.filter((r) => r.path.endsWith("/turns"))
			.map((r) => r.body.chatMessageId);
	// The relays Fabric sends when it checks someone who joined.
	await guests([], [{ id: MEMBER, pending: true }]);
	await guests([], [{ id: MEMBER, pending: false, userId: "user-1" }]);
	await ask("msg_member", MEMBER);
	assert.deepEqual(turns(), ["msg_member"], "a member's request is taken");
	await guests([], [{ id: OUTSIDE, pending: true }]);
	await guests(
		[{ id: OUTSIDE, joined: true }],
		[{ id: OUTSIDE, pending: false }],
	);

	await ask("msg_guest", OUTSIDE);

	assert.deepEqual(turns(), ["msg_member"], "no turn from a guest");
	const kept = requests.find(
		(r) =>
			r.path.endsWith("/segments") &&
			r.body.chatMessageId === "msg_guest",
	);
	assert.equal(kept?.body.speakerId, OUTSIDE, "a guest may be quoted");
});

test("a first tag outside the bridge's range is ignored and the session starts at P1", async () => {
	const { instance, data } = bridge();
	await instance.onStart();
	const verified = data.get("bridge");

	await instance.onRequest(
		control("", {
			hardStopAt: new Date(Date.now() + 3_600_000).toISOString(),
			chatTagStart: 100_001,
		}),
	);
	data.set("bridge", verified);
	const response = await instance.onRequest(
		control("chat", { message: "Here is F-12." }),
	);

	assert.equal(plain(await response.json()).tag, "P1");
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
			// A typed request answered in the chat starts no new voice
			// generation, so it supersedes nothing being said.
			voiceGeneration: 0,
		},
	);

	// The chat request's actions may run until its final post.
	const current = async () =>
		plain(
			await (
				await instance.onRequest(
					control("verify-generation", { voiceGeneration: 0 }),
				)
			).json(),
		).current;
	assert.equal(await current(), true);
	await instance.onRequest(
		control("chat", {
			message: "Two things changed.",
			turnId: "turn-1",
			voiceGeneration: 0,
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
	Date.now = () => realNow() + 16_000;
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
