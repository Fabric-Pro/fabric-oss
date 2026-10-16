import assert from "node:assert/strict";
import test from "node:test";
import {
	authenticateParlumeStreamMessage,
	parseParlumeSpeakerUpdates,
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
		verification: null as Promise<boolean> | null,
		generation: 1,
		streamGeneration: null,
	};
	const host = {
		connections: new Map([[connection, state]]),
		verifyStreamWithRetry: verify,
	};
	return { closed, connection, state, host };
}

// 10 ms of 24 kHz, 16-bit mono PCM: samples 1, 2, ... as little-endian pairs.
const PCM = Uint8Array.from({ length: 480 }, (_, index) =>
	index % 2 === 0 ? ((index / 2) % 256) + 1 : 0,
);

const audio = (
	botId: string,
	overrides: Record<string, unknown> = {},
	trigger = "realtime_audio.mixed",
) =>
	JSON.stringify({
		bot_id: botId,
		trigger,
		data: {
			chunk: Buffer.from(PCM).toString("base64"),
			sample_rate: 24_000,
			timestamp_ms: 1_700_000_000_000,
			...overrides,
		},
	});

test("reads a mixed-audio chunk from Attendee", () => {
	const message = parseParlumeStreamMessage(audio("bot_abc123"));

	assert.equal(message?.kind, "audio");
	assert.equal(message?.botId, "bot_abc123");
	assert.equal(message?.sampleRate, 24_000);
	assert.equal(message?.timestampMs, 1_700_000_000_000);
	assert.deepEqual(Array.from(message?.pcm ?? []), Array.from(PCM));
});

test("refuses anything that is not a whole, well-formed audio chunk", () => {
	const malformed = [
		"not json",
		"[]",
		"null",
		audio("bot_abc123", {}, "realtime_audio.per_participant"),
		audio("bot_abc123", {}, "transcript.update"),
		audio(""),
		audio("bot_abc123", { chunk: 12 }),
		audio("bot_abc123", { chunk: "***not base64***" }),
		audio("bot_abc123", { chunk: "" }),
		// One byte is not a 16-bit sample.
		audio("bot_abc123", { chunk: Buffer.from([1]).toString("base64") }),
		audio("bot_abc123", { sample_rate: 0 }),
		audio("bot_abc123", { sample_rate: 24_000.5 }),
		audio("bot_abc123", { sample_rate: "24000" }),
		audio("bot_abc123", { timestamp_ms: "now" }),
		JSON.stringify({
			trigger: "realtime_audio.mixed",
			bot_id: "bot_abc123",
		}),
		JSON.stringify({
			protocol_version: 2,
			bot_id: "bot-1",
			sample_rate: 24_000,
		}),
		JSON.stringify([
			{ name: "Dev One", id: 1, timestamp: 5, isSpeaking: true },
		]),
		`${audio("bot_abc123")}${" ".repeat(300 * 1024)}`,
	];

	for (const message of malformed) {
		assert.equal(
			parseParlumeStreamMessage(message),
			null,
			message.slice(0, 80),
		);
	}
});

test("reads speaker updates and refuses a request with one bad entry", () => {
	assert.deepEqual(
		parseParlumeSpeakerUpdates({
			updates: [
				{
					name: "Dev One",
					id: "participant-1",
					timestamp: 5,
					isSpeaking: true,
				},
				{ name: "Dev Two", id: 2, timestamp: 6, isSpeaking: false },
				{ name: "No Id", timestamp: 7, isSpeaking: true },
			],
		}),
		[
			{
				name: "Dev One",
				id: "participant-1",
				timestamp: 5,
				isSpeaking: true,
			},
			{ name: "Dev Two", id: "2", timestamp: 6, isSpeaking: false },
			{ name: "No Id", id: null, timestamp: 7, isSpeaking: true },
		],
	);
	assert.deepEqual(parseParlumeSpeakerUpdates({ updates: [] }), []);

	assert.equal(parseParlumeSpeakerUpdates(null), null);
	assert.equal(parseParlumeSpeakerUpdates([]), null);
	assert.equal(parseParlumeSpeakerUpdates({}), null);
	assert.equal(
		parseParlumeSpeakerUpdates({
			updates: [
				{ name: "Dev One", timestamp: 5, isSpeaking: true },
				{ name: "Broken" },
			],
		}),
		null,
	);
	assert.equal(
		parseParlumeSpeakerUpdates({
			updates: [{ name: "Dev", timestamp: Number.NaN, isSpeaking: true }],
		}),
		null,
	);
	assert.equal(
		parseParlumeSpeakerUpdates({
			updates: Array.from({ length: 101 }, () => ({
				name: "Dev",
				timestamp: 1,
				isSpeaking: true,
			})),
		}),
		null,
	);
});

test("verifies the bot named by the first audio chunk before trusting the stream", async () => {
	const verified: string[] = [];
	const { closed, connection, state, host } = stream(async () => {
		verified.push("check");
		return true;
	});

	const first = await authenticateParlumeStreamMessage(
		host,
		connection,
		audio("bot_abc123"),
	);
	assert.equal(first?.message.kind, "audio");
	assert.equal(state.verified, true);
	assert.equal(state.botId, "bot_abc123");

	// Every later chunk needs no new check.
	await authenticateParlumeStreamMessage(
		host,
		connection,
		audio("bot_abc123"),
	);
	assert.equal(verified.length, 1);

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

test("chunks that arrive while the stream is being verified wait for that one check", async () => {
	let verifyCalls = 0;
	let release: (verified: boolean) => void = () => {};
	const { closed, connection, state, host } = stream(() => {
		verifyCalls++;
		return new Promise<boolean>((resolve) => {
			release = resolve;
		});
	});

	const order: number[] = [];
	const pending = [0, 1, 2, 3].map((index) =>
		authenticateParlumeStreamMessage(
			host,
			connection,
			audio("bot_abc123", {
				timestamp_ms: 1_700_000_000_000 + index * 10,
			}),
		).then((result) => {
			order.push(result?.message.timestampMs ?? -1);
			return result;
		}),
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(verifyCalls, 1);
	assert.equal(order.length, 0);

	release(true);
	const results = await Promise.all(pending);

	assert.equal(verifyCalls, 1);
	assert.ok(results.every((result) => result !== null));
	assert.equal(state.verified, true);
	assert.deepEqual(
		order,
		[0, 1, 2, 3].map((index) => 1_700_000_000_000 + index * 10),
	);
	assert.deepEqual(closed, []);
});

test("closes the stream when the check refuses the bot, for every chunk that waited", async () => {
	const refused = stream(async () => false);

	await Promise.all([
		authenticateParlumeStreamMessage(
			refused.host,
			refused.connection,
			audio("bot_abc123"),
		),
		authenticateParlumeStreamMessage(
			refused.host,
			refused.connection,
			audio("bot_abc123"),
		),
	]);

	assert.deepEqual(refused.closed, [4001, 4001]);
	assert.equal(refused.state.verified, false);
});

test("closes the stream for a message that is not audio before it is verified", async () => {
	const garbage = stream(async () => true);
	await authenticateParlumeStreamMessage(
		garbage.host,
		garbage.connection,
		"not json",
	);
	assert.deepEqual(garbage.closed, [4002]);

	const speakers = stream(async () => true);
	await authenticateParlumeStreamMessage(
		speakers.host,
		speakers.connection,
		JSON.stringify([
			{ name: "Dev", id: 1, timestamp: 1, isSpeaking: true },
		]),
	);
	assert.deepEqual(speakers.closed, [4002]);
});

test("closes the stream when a later chunk names another bot", async () => {
	const other = stream(async () => true);
	await authenticateParlumeStreamMessage(
		other.host,
		other.connection,
		audio("bot_abc123"),
	);
	await authenticateParlumeStreamMessage(
		other.host,
		other.connection,
		audio("bot_other"),
	);
	assert.deepEqual(other.closed, [4001]);
});

test("a chunk naming another bot is refused even when it waited on the first bot's check", async () => {
	let release: (verified: boolean) => void = () => {};
	const racing = stream(
		() =>
			new Promise<boolean>((resolve) => {
				release = resolve;
			}),
	);

	const first = authenticateParlumeStreamMessage(
		racing.host,
		racing.connection,
		audio("bot_abc123"),
	);
	const second = authenticateParlumeStreamMessage(
		racing.host,
		racing.connection,
		audio("bot_other"),
	);
	await new Promise((resolve) => setImmediate(resolve));
	release(true);

	assert.notEqual(await first, null);
	assert.equal(await second, null);
	assert.equal(racing.state.botId, "bot_abc123");
	assert.deepEqual(racing.closed, [4001]);
});
