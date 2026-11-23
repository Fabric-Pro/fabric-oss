import assert from "node:assert/strict";
import test from "node:test";
import {
	connectedMeeting,
	control,
	sleep,
} from "./parlume-meeting-harness.mts";

// A post read aloud survives one Aura failure, as an answer does; a second
// failure is said once in the chat, since no other voice reads it.

type Harness = Awaited<ReturnType<typeof connectedMeeting>>;

const ana = { name: "Ana Example", id: "participant-2" };

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
const retries = (harness: Harness) =>
	harness.logs
		.filter((entry) => entry.message.includes("aura.retry"))
		.map((entry) => entry.meta);

function typed(text: string) {
	return control("chat-message", {
		id: "msg_1",
		text,
		senderName: ana.name,
		senderId: ana.id,
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

test("a post read aloud whose first Aura call fails is still played", async () => {
	const harness = await connectedMeeting({
		aura: (_text, index) =>
			index === 0
				? new Response("busy", { status: 503 })
				: new Response(new Uint8Array(4_800)),
	});
	const keepAlive = setInterval(() => {}, 1_000);
	await harness.bridge.onRequest(
		control("chat", { message: "Here is F-12." }),
	);

	await harness.bridge.onRequest(typed("go P1"));
	await waitFor(() => retries(harness).length === 1);
	await waitFor(() => frames(harness) > 0);
	await sleep(600);
	clearInterval(keepAlive);

	assert.deepEqual(spoken(harness), ["Here is F-12.", "Here is F-12."]);
	assert.equal(retries(harness)[0]?.played, true);
	assert.equal(retries(harness)[0]?.route, "aura-bridge");
	assert.ok(
		!chatPosts(harness).some((post) => post.includes("Not read aloud")),
	);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a post read aloud that fails twice gets one chat line saying so", async () => {
	const harness = await connectedMeeting({
		aura: () => new Response("busy", { status: 503 }),
	});
	const keepAlive = setInterval(() => {}, 1_000);
	await harness.bridge.onRequest(
		control("chat", { message: "Here is F-12." }),
	);

	await harness.bridge.onRequest(typed("go P1"));
	await waitFor(() =>
		chatPosts(harness).some((post) => post.includes("Not read aloud")),
	);
	await sleep(400);
	clearInterval(keepAlive);

	assert.equal(
		chatPosts(harness).filter((post) => post.includes("Not read aloud"))
			.length,
		1,
	);
	assert.equal(retries(harness)[0]?.played, false);
	assert.equal(frames(harness), 0);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});
