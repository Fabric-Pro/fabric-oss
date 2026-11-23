import assert from "node:assert/strict";
import test from "node:test";
import {
	answeringMeeting,
	connectedMeeting,
	control,
	plain,
	say,
	sleep,
	slowAura,
} from "./parlume-meeting-harness.mts";

// What arrives while Parlume answers waits in the voice floor's queue, and is
// answered after that answer, in the order it came.

type Harness = Awaited<ReturnType<typeof connectedMeeting>>;

const ana = { name: "Ana Example", id: "participant-2" };
const bo = { name: "Bo Example", id: "participant-3" };

const turns = (harness: Harness) =>
	harness.requests.filter((r) => r.path.endsWith("/turns"));
const interrupts = (harness: Harness) =>
	harness.requests.filter((r) => r.path.endsWith("/interrupt"));
const chatPosts = (harness: Harness): string[] =>
	harness.requests
		.filter((r) => r.path.endsWith("/chat"))
		.map((r) => String(r.body.message));
const spoken = (harness: Harness) =>
	harness.auraCalls.map((call) => (call.inputs as { text: string }).text);

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

/** A participant's finished turn, as Flux reports it. */
function heard(harness: Harness, turnIndex: number, transcript: string) {
	harness.flux.turn({
		event: "EndOfTurn",
		turn_index: turnIndex,
		audio_window_start: 0.06,
		audio_window_end: 0.08,
		transcript,
	});
}

async function waitFor(condition: () => boolean, ms = 3_000) {
	for (let waited = 0; waited < ms && !condition(); waited += 20) {
		await sleep(20);
	}
	assert.ok(condition(), "timed out");
}

test("a spoken request made while Parlume answers stops nothing, and is asked of Fabric once that answer has played", async () => {
	const harness = await answeringMeeting();
	const keepAlive = setInterval(() => {}, 1_000);
	const playing = harness.bridge.onRequest(
		say(["The plan is ready."], {}, "1"),
	);
	await sleep(250);

	heard(harness, 1, "Hey Fabric, what are the risks?");
	// The answer plays for over two seconds: a second in, the request waits.
	await sleep(1_000);
	assert.equal(turns(harness).length, 1, "the request waits");
	assert.deepEqual(interrupts(harness), []);

	const result = plain(await (await playing).json());
	assert.equal(result.played, true);
	await waitFor(() => turns(harness).length === 2);
	clearInterval(keepAlive);

	const turn = turns(harness)[1];
	assert.match(String(turn?.body.text), /what are the risks/);
	assert.equal(turn?.body.replyChannel, "VOICE");
	assert.equal(turn?.body.voiceGeneration, 2);
	assert.deepEqual(interrupts(harness), []);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("'say P1' typed while Parlume prepares an answer is read after the answer, opening with its typer's name", async () => {
	const harness = await answeringMeeting();
	const keepAlive = setInterval(() => {}, 1_000);
	await harness.bridge.onRequest(
		control("chat", { message: "Here is F-12." }),
	);

	await harness.bridge.onRequest(typed("msg_1", "say P1", ana));
	await sleep(200);
	assert.deepEqual(spoken(harness), [], "the read waits for the answer");

	const answer = await harness.bridge.onRequest(
		say(["The plan is ready."], {}, "1"),
	);
	assert.equal(plain(await answer.json()).played, true);
	await waitFor(() => spoken(harness).length === 2);
	clearInterval(keepAlive);

	assert.deepEqual(spoken(harness), [
		"The plan is ready.",
		"Ana, Here is F-12.",
	]);
	assert.deepEqual(interrupts(harness), []);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("after a restart, a request that was waiting is still answered once the answer before it has played", async () => {
	const before = await answeringMeeting();
	await before.bridge.onRequest(
		typed("msg_1", "@Fabric Parlume what changed?", ana),
	);
	// Kept in the Durable Object's storage, which a restart keeps.
	const queue = () => JSON.stringify(before.data.get("requestQueue") ?? null);
	await waitFor(() => queue().includes("msg_1"));
	assert.equal(turns(before).length, 1);

	const after = await connectedMeeting({
		aura: slowAura,
		data: before.data,
	});
	const keepAlive = setInterval(() => {}, 1_000);
	assert.equal(turns(after).length, 0, "the answer before it is not over");
	await after.bridge.onRequest(say(["The plan is ready."], {}, "1"));
	await waitFor(() => turns(after).length === 1);
	clearInterval(keepAlive);

	assert.deepEqual(
		{
			text: turns(after)[0]?.body.text,
			replyChannel: turns(after)[0]?.body.replyChannel,
			chatMessageId: turns(after)[0]?.body.chatMessageId,
			speakerName: turns(after)[0]?.body.speakerName,
		},
		{
			text: "what changed?",
			replyChannel: "CHAT",
			chatMessageId: "msg_1",
			speakerName: "Ana Example",
		},
	);
	await after.bridge.onClose(after.bot, 1000, "done");
});

test("after a stop, a request that waits starts only once nobody has spoken for two seconds", async () => {
	const harness = await answeringMeeting();
	const keepAlive = setInterval(() => {}, 1_000);
	const playing = harness.bridge.onRequest(
		say(["The plan is ready."], {}, "1"),
	);
	await sleep(250);
	await harness.bridge.onRequest(
		typed("msg_1", "@Fabric Parlume what changed?", ana),
	);
	await harness.bridge.onRequest(typed("msg_2", "stop", bo));
	await playing;
	await waitFor(() => interrupts(harness).length === 1);

	// Someone speaks a second after the stop: the two seconds start again.
	await sleep(1_000);
	heard(harness, 1, "Okay, let us move on to the next item.");
	const spokeAt = performance.now();
	assert.equal(turns(harness).length, 1, "the request still waits");
	await waitFor(() => turns(harness).length === 2);
	clearInterval(keepAlive);

	assert.ok((turns(harness)[1]?.at ?? 0) - spokeAt >= 1_900);
	assert.equal(turns(harness)[1]?.body.chatMessageId, "msg_1");
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a sixth request is not queued, and its typer is told once in the chat", async () => {
	const harness = await answeringMeeting();
	for (let index = 1; index <= 6; index++) {
		const sender = {
			name: `Person${index} Example`,
			id: `participant-${index + 10}`,
		};
		const text = `@Fabric Parlume what about item ${index}?`;
		await harness.bridge.onRequest(typed(`msg_${index}`, text, sender));
	}
	await waitFor(() =>
		chatPosts(harness).some((post) => post.includes("**Not queued**")),
	);

	const refused = chatPosts(harness).filter((post) =>
		post.includes("**Not queued**"),
	);
	assert.equal(refused.length, 1);
	assert.match(
		refused[0] ?? "",
		/\*\*Not queued\*\* · Person6, 5 requests are already waiting\. Ask me again after the current answer\.$/,
	);
	assert.equal(turns(harness).length, 1, "every other request waits");
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("one request waits per person: a second from the same typer is not queued", async () => {
	const harness = await answeringMeeting();
	await harness.bridge.onRequest(
		typed("msg_1", "@Fabric Parlume what changed?", ana),
	);
	await harness.bridge.onRequest(
		typed("msg_2", "@Fabric Parlume and who owns it?", ana),
	);
	await waitFor(() =>
		chatPosts(harness).some((post) => post.includes("**Not queued**")),
	);

	assert.match(
		chatPosts(harness).find((post) => post.includes("**Not queued**")) ??
			"",
		/\*\*Not queued\*\* · Ana, you already have a request waiting\. Ask me again after the current answer\.$/,
	);
	// Someone else may still queue.
	await harness.bridge.onRequest(
		typed("msg_3", "@Fabric Parlume what is next?", bo),
	);
	await sleep(100);
	assert.equal(
		chatPosts(harness).filter((post) => post.includes("**Not queued**"))
			.length,
		1,
	);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a request that waited more than two minutes is not answered, and its asker is told once", async () => {
	const data = new Map<string, unknown>([
		[
			"requestQueue",
			{
				entries: [
					{
						request: {
							kind: "read",
							text: "Here is F-12.",
							chapter: false,
						},
						askerKey: ana.id,
						askerName: ana.name,
						queuedAt: Date.now() - 3 * 60_000,
					},
				],
				quietAfterStop: false,
			},
		],
	]);
	const harness = await connectedMeeting({ data });
	await waitFor(() =>
		chatPosts(harness).some((post) => post.includes("**Not answered**")),
	);

	assert.equal(
		chatPosts(harness).filter((post) => post.includes("**Not answered**"))
			.length,
		1,
	);
	assert.match(
		chatPosts(harness).find((post) => post.includes("**Not answered**")) ??
			"",
		/\*\*Not answered\*\* · Ana, your request waited more than two minutes\. Ask me again\.$/,
	);
	assert.deepEqual(spoken(harness), [], "nothing is read");
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a long post is read a chapter at a time: 'continue' typed, or the page's Continue reading, reads the next", async () => {
	const harness = await connectedMeeting();
	const keepAlive = setInterval(() => {}, 1_000);
	const item = (index: number) =>
		`Item ${index} of the release plan needs one more review.`;
	const hints = () =>
		spoken(harness).filter((text) => text === "There is more.").length;
	// Three chapters: items 1 to 11, 12 to 22, and 23 to 30.
	const post = Array.from({ length: 30 }, (_, index) => item(index + 1));
	await harness.bridge.onRequest(
		control("chat", { message: post.join(" ") }),
	);

	const continueFromPage = async () => {
		const response = await harness.bridge.onRequest(
			control("continue-reading", {
				actor: { id: "user-1", name: "Dana Member" },
			}),
		);
		return plain(await response.json()).changed;
	};

	await harness.bridge.onRequest(typed("msg_1", "say P1", ana));
	await waitFor(() => hints() === 1, 6_000);
	assert.equal(spoken(harness)[0], item(1));
	assert.equal(spoken(harness).includes(item(12)), false);

	await harness.bridge.onRequest(typed("msg_2", "continue", bo));
	await waitFor(() => hints() === 2, 6_000);
	// Asked for while the first chapter played, it may open with Bo's name.
	assert.ok(
		spoken(harness).some((text) => /^(?:Bo, )?Item 12 of the /.test(text)),
	);

	assert.equal(await continueFromPage(), true);
	await waitFor(() => spoken(harness).at(-1) === item(30), 6_000);
	assert.equal(hints(), 2, "the last chapter has none after it");

	assert.equal(await continueFromPage(), false, "nothing more waits");
	clearInterval(keepAlive);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});
