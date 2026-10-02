import assert from "node:assert/strict";
import test from "node:test";
import {
	authenticateParlumeStreamMessage,
	parseParlumeStreamMessage,
} from "./parlume-stream-auth.ts";

function stream(verify: () => Promise<boolean>) {
	const closed: number[] = [];
	const connection = {
		close: (code: number) => {
			closed.push(code);
		},
	};
	const state = {
		sessionId: "session-1",
		token: "token",
		botId: null as string | null,
		verified: false,
		generation: 1,
		streamGeneration: null,
	};
	const host = {
		connections: new Map([[connection, state]]),
		verifyStreamWithRetry: verify,
	};
	return { closed, connection, state, host };
}

const handshake = (botId: string, startTime: number | null = null) =>
	JSON.stringify({
		protocol_version: 2,
		bot_id: botId,
		offset: 0,
		sample_rate: 24_000,
		start_time: startTime,
	});

test("reads the audio handshake and speaker updates", () => {
	assert.deepEqual(parseParlumeStreamMessage(handshake("bot-1", 1_000)), {
		kind: "handshake",
		botId: "bot-1",
		sampleRate: 24_000,
		startTime: 1_000,
	});
	assert.deepEqual(
		parseParlumeStreamMessage(
			JSON.stringify([
				{ name: "Dev One", id: 1, timestamp: 5, isSpeaking: true },
				{ name: "Broken" },
			]),
		),
		{
			kind: "speakers",
			updates: [
				{ name: "Dev One", id: "1", timestamp: 5, isSpeaking: true },
			],
		},
	);
	assert.equal(parseParlumeStreamMessage('{"event":"other"}'), null);
});

test("verifies the bot named in the handshake before trusting the stream", async () => {
	let verified = 0;
	const { closed, connection, state, host } = stream(async () => {
		verified++;
		return true;
	});

	const first = await authenticateParlumeStreamMessage(
		host,
		connection,
		handshake("bot-1"),
	);
	assert.equal(first?.message.kind, "handshake");
	assert.equal(state.verified, true);
	assert.equal(state.botId, "bot-1");

	// The second handshake, sent once capture starts, needs no new check.
	await authenticateParlumeStreamMessage(
		host,
		connection,
		handshake("bot-1", 2_000),
	);
	assert.equal(verified, 1);

	// A verified stream ignores message kinds it does not know.
	assert.equal(
		await authenticateParlumeStreamMessage(
			host,
			connection,
			'{"event":"x"}',
		),
		null,
	);
	assert.deepEqual(closed, []);
});

test("refuses speaker updates before a handshake, a failed check, and another bot", async () => {
	const early = stream(async () => true);
	await authenticateParlumeStreamMessage(
		early.host,
		early.connection,
		JSON.stringify([
			{ name: "Dev", id: 1, timestamp: 1, isSpeaking: true },
		]),
	);
	assert.deepEqual(early.closed, [4001]);

	const garbage = stream(async () => true);
	await authenticateParlumeStreamMessage(
		garbage.host,
		garbage.connection,
		"not json",
	);
	assert.deepEqual(garbage.closed, [4002]);

	const refused = stream(async () => false);
	await authenticateParlumeStreamMessage(
		refused.host,
		refused.connection,
		handshake("bot-1"),
	);
	assert.deepEqual(refused.closed, [4001]);

	const other = stream(async () => true);
	await authenticateParlumeStreamMessage(
		other.host,
		other.connection,
		handshake("bot-1"),
	);
	await authenticateParlumeStreamMessage(
		other.host,
		other.connection,
		handshake("bot-2"),
	);
	assert.deepEqual(other.closed, [4001]);
});
