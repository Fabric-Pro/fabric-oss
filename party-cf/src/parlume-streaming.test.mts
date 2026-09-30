import assert from "node:assert/strict";
import test from "node:test";
import { authenticateParlumeStreamMessage } from "./parlume-stream-auth.ts";

for (const [description, payload] of [
	["empty data", { event: "transcript.segment", bot_id: "bot-1", data: {} }],
	[
		"missing final marker",
		{
			event: "transcript.segment",
			bot_id: "bot-1",
			data: { text: "Hello" },
		},
	],
	[
		"missing transcript text",
		{
			event: "transcript.segment",
			bot_id: "bot-1",
			data: { isFinal: true },
		},
	],
] as const) {
	test(`authenticates and ignores incomplete transcription events: ${description}`, async () => {
		let closeCount = 0;
		let verifyCount = 0;
		const connection = {
			close: () => {
				closeCount++;
			},
		};
		const state = {
			sessionId: "session-1",
			token: "token",
			botId: null,
			verified: false,
			generation: 1,
			streamGeneration: null,
		};
		const host = {
			connections: new Map([[connection, state]]),
			verifyStreamWithRetry: async () => {
				verifyCount++;
				return true;
			},
		};

		const authenticated = await authenticateParlumeStreamMessage(
			host,
			connection,
			JSON.stringify(payload),
		);

		assert.ok(authenticated);
		assert.equal(authenticated.event.event, "transcript.incomplete");
		assert.equal(verifyCount, 1);
		assert.equal(closeCount, 0);
		assert.equal(state.verified, true);
		assert.equal(state.botId, "bot-1");
	});
}

test("refuses an unverified stream and a mismatched provider bot", async () => {
	const closed: number[] = [];
	const connection = {
		close: (code: number) => {
			closed.push(code);
		},
	};
	const state = {
		sessionId: "session-1",
		token: "token",
		botId: null,
		verified: false,
		generation: 1,
		streamGeneration: null,
	};
	const host = {
		connections: new Map([[connection, state]]),
		verifyStreamWithRetry: async () => false,
	};

	assert.equal(
		await authenticateParlumeStreamMessage(
			host,
			connection,
			JSON.stringify({ event: "session.started", bot_id: "bot-1" }),
		),
		null,
	);
	assert.deepEqual(closed, [4001]);

	state.verified = true;
	state.botId = "bot-1";
	assert.equal(
		await authenticateParlumeStreamMessage(
			host,
			connection,
			JSON.stringify({ event: "session.started", bot_id: "bot-2" }),
		),
		null,
	);
	assert.deepEqual(closed, [4001, 4001]);
});
