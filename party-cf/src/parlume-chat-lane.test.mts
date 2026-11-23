import assert from "node:assert/strict";
import test from "node:test";
import {
	answeringMeeting,
	control,
	flush,
	plain,
	say,
	sleep,
} from "./parlume-meeting-harness.mts";

// A request typed in the chat waits in the floor's queue: it never cuts
// what Parlume is saying or answering.

type Harness = Awaited<ReturnType<typeof answeringMeeting>>;

const ana = { name: "Ana Example", id: "participant-2" };
const bo = { name: "Bo Example", id: "participant-3" };

const turns = (harness: Harness) =>
	harness.requests.filter((r) => r.path.endsWith("/turns"));
const interrupts = (harness: Harness) =>
	harness.requests
		.filter((r) => r.path.endsWith("/interrupt"))
		.map((r) => r.body);
const chatPosts = (harness: Harness): string[] =>
	harness.requests
		.filter((r) => r.path.endsWith("/chat"))
		.map((r) => String(r.body.message));
const spoken = (harness: Harness) =>
	harness.auraCalls.map((call) => (call.inputs as { text: string }).text);
const frames = (harness: Harness) =>
	harness.sent.filter((message) =>
		message.includes('"realtime_audio.bot_output"'),
	).length;

function typed(id: string, text: string, sender: { name: string; id: string }) {
	return control("chat-message", {
		id,
		text,
		senderName: sender.name,
		senderId: sender.id,
		toBot: false,
		timestampMs: 1_000_100,
	});
}

async function waitFor(condition: () => boolean) {
	for (let waited = 0; waited < 3_000 && !condition(); waited += 20) {
		await sleep(20);
	}
	assert.ok(condition(), "timed out");
}

/** Frames the bot got over the next 300 ms: three or more while it speaks. */
async function framesOver300Ms(harness: Harness): Promise<number> {
	const before = frames(harness);
	await sleep(300);
	return frames(harness) - before;
}

test("a request typed while Parlume speaks leaves the speech playing, and is answered in the chat on the same voice generation once the answer ends", async () => {
	const harness = await answeringMeeting();
	const keepAlive = setInterval(() => {}, 1_000);
	assert.equal(turns(harness)[0]?.body.voiceGeneration, 1);

	const playing = harness.bridge.onRequest(
		say(["The plan is ready."], {}, "1"),
	);
	await sleep(250);
	await harness.bridge.onRequest(
		typed("msg_1", "@Fabric Parlume what changed?", ana),
	);
	await flush();
	await flush();

	assert.equal(turns(harness).length, 1, "the typed request waits");
	assert.ok((await framesOver300Ms(harness)) >= 2, "the speech goes on");
	const result = plain(await (await playing).json());
	assert.equal(result.played, true);
	assert.deepEqual(interrupts(harness), []);

	await waitFor(() => turns(harness).length === 2);
	clearInterval(keepAlive);

	const turn = turns(harness)[1];
	assert.deepEqual(
		{
			text: turn?.body.text,
			replyChannel: turn?.body.replyChannel,
			chatMessageId: turn?.body.chatMessageId,
			voiceGeneration: turn?.body.voiceGeneration,
			speakerName: turn?.body.speakerName,
		},
		{
			text: "what changed?",
			replyChannel: "CHAT",
			chatMessageId: "msg_1",
			voiceGeneration: 1,
			speakerName: "Ana Example",
		},
	);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a typed stop from anyone ends the answer, the stopped answer posts nothing more, and a typed request still waiting gets its chat answer after two quiet seconds", async () => {
	const harness = await answeringMeeting();
	const keepAlive = setInterval(() => {}, 1_000);

	const playing = harness.bridge.onRequest(
		say(["The plan is ready."], {}, "1"),
	);
	await sleep(250);
	await harness.bridge.onRequest(
		typed("msg_1", "@Fabric Parlume what changed?", ana),
	);
	await flush();
	await harness.bridge.onRequest(typed("msg_2", "stop", bo));
	const result = plain(await (await playing).json());
	await waitFor(() => interrupts(harness).length === 1);

	assert.equal(result.played, false);
	assert.deepEqual(interrupts(harness), [
		{
			sessionId: "session-1",
			botId: "bot_abc123",
			voiceGeneration: 2,
			stop: { cause: "CHAT", by: "Bo Example" },
		},
	]);
	await waitFor(() =>
		chatPosts(harness).some((post) => post.includes("**Stopped**")),
	);
	assert.match(
		chatPosts(harness).find((post) => post.includes("**Stopped**")) ?? "",
		/\*\*Stopped\*\* · Bo stopped the answer$/,
	);
	const late = plain(
		await (
			await harness.bridge.onRequest(
				control("chat", {
					message: "Two items remain.",
					turnId: "turn-1",
					voiceGeneration: 1,
					final: true,
				}),
			)
		).json(),
	);
	assert.deepEqual(late, { sent: false, reason: "stopped" });
	assert.equal(turns(harness).length, 1, "the typed request still waits");
	const stoppedAt =
		harness.requests.find((r) => r.path.endsWith("/interrupt"))?.at ?? 0;

	// It starts once the meeting has been quiet for two seconds.
	await waitFor(() => turns(harness).length === 2);
	clearInterval(keepAlive);
	assert.ok((turns(harness)[1]?.at ?? 0) - stoppedAt >= 1_900);

	const turn = turns(harness)[1];
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
			voiceGeneration: 2,
		},
	);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("'go' typed while Parlume speaks reads the post after the speech, for its typer", async () => {
	const harness = await answeringMeeting();
	const keepAlive = setInterval(() => {}, 1_000);
	await harness.bridge.onRequest(
		control("chat", { message: "Here is F-12." }),
	);

	const playing = harness.bridge.onRequest(
		say(["The plan is ready."], {}, "1"),
	);
	await sleep(250);
	await harness.bridge.onRequest(typed("msg_1", "go P1", ana));
	await sleep(200);

	assert.deepEqual(spoken(harness), ["The plan is ready."], "the read waits");
	const result = plain(await (await playing).json());
	assert.equal(result.played, true);
	assert.deepEqual(interrupts(harness), []);

	// It waited for the answer before it, so it opens with its typer's name.
	await waitFor(() => spoken(harness).includes("Ana, Here is F-12."));
	assert.ok((await framesOver300Ms(harness)) >= 2, "the read plays");
	// Stopped, the read is the answer of the one who typed "go".
	await harness.bridge.onRequest(typed("msg_2", "stop", bo));
	await waitFor(() => interrupts(harness).length === 1);
	await waitFor(() =>
		chatPosts(harness).some((post) => post.includes("**Stopped**")),
	);
	clearInterval(keepAlive);

	assert.deepEqual(interrupts(harness)[0]?.stop, {
		cause: "CHAT",
		by: "Bo Example",
	});
	assert.match(
		chatPosts(harness).find((post) => post.includes("**Stopped**")) ?? "",
		/\*\*Stopped\*\* · Bo stopped the answer for Ana$/,
	);
	assert.equal(turns(harness).length, 1, "nothing is asked of Fabric");
	await harness.bridge.onClose(harness.bot, 1000, "done");
});
