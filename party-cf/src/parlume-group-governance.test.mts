import assert from "node:assert/strict";
import test from "node:test";
import {
	connectedMeeting,
	control,
	flush,
	plain,
	say,
	sleep,
} from "./parlume-meeting-harness.mts";

// A meeting of several people: whose access each request is read with, who
// may pick a post made for someone else, and what a guest or a participant
// still being checked stops.

type Harness = Awaited<ReturnType<typeof connectedMeeting>>;
type Person = { name: string; id: string; userId: string };

const ALEX: Person = {
	name: "Alex Example",
	id: "8:orgid:00000000-0000-4000-8000-00000000000a",
	userId: "user-alex",
};
const BO: Person = {
	name: "Bo Example",
	id: "8:orgid:00000000-0000-4000-8000-00000000000b",
	userId: "user-bo",
};
const CY: Person = {
	name: "Cy Example",
	id: "8:orgid:00000000-0000-4000-8000-00000000000c",
	userId: "user-cy",
};
const GUEST = { name: "Visitor (Guest)", id: "8:teamsvisitor:guest-1" };

function checkedMeeting() {
	return connectedMeeting({
		verify: async () =>
			Response.json({
				valid: true,
				hardStopAt: new Date(Date.now() + 3_600_000).toISOString(),
				streamGeneration: 1,
				checksAttendees: true,
			}),
	});
}

const guests = (harness: Harness, updates: unknown[], placing: unknown[]) =>
	harness.bridge.onRequest(control("guests", { updates, placing }));

const checking = (harness: Harness, person: Person) =>
	guests(harness, [], [{ id: person.id, pending: true }]);

const confirmed = (harness: Harness, person: Person) => {
	const placement = { id: person.id, pending: false, userId: person.userId };
	return guests(harness, [], [placement]);
};

/** Fabric checks a participant who joined, then confirms them. */
async function confirm(harness: Harness, person: Person) {
	await checking(harness, person);
	await confirmed(harness, person);
}

let messageNumber = 0;
function typed(
	text: string,
	sender: { name: string | null; id: string | null },
) {
	messageNumber += 1;
	const id = `msg_${messageNumber}`;
	return {
		id,
		request: control("chat-message", {
			id,
			text,
			senderName: sender.name,
			senderId: sender.id,
			toBot: false,
			timestampMs: 1_000_100,
		}),
	};
}

/** One spoken request, heard from `person` alone. */
async function spoken(harness: Harness, person: Person, transcript: string) {
	const speaking = (timestamp: number, isSpeaking: boolean) => ({
		name: person.name,
		id: person.id,
		timestamp,
		isSpeaking,
	});
	await harness.bridge.onRequest(
		control("speakers", {
			updates: [speaking(1_000_000, true), speaking(1_002_000, false)],
		}),
	);
	harness.flux.turn({
		event: "EndOfTurn",
		turn_index: 0,
		audio_window_start: 0.1,
		audio_window_end: 1.5,
		transcript,
	});
	await sleep(300);
}

/** The worker posts to the meeting chat through the bridge. */
async function workerPost(harness: Harness, body: Record<string, unknown>) {
	const response = await harness.bridge.onRequest(control("chat", body));
	return plain(await response.json());
}

/** The worker speaks a reply through the bridge. */
async function workerSay(harness: Harness, text: string) {
	const response = await harness.bridge.onRequest(say([text]));
	return plain(await response.json());
}

/** The worker's final post ends a typed request, so the next is not queued. */
function closeChatRequest(harness: Harness) {
	return workerPost(harness, {
		message: "",
		voiceGeneration: 0,
		final: true,
		close: true,
	});
}

const turns = (harness: Harness) =>
	harness.requests
		.filter((request) => request.path.endsWith("/turns"))
		.map((request) => request.body);
const turnFor = (harness: Harness, chatMessageId: string) =>
	turns(harness).find((turn) => turn.chatMessageId === chatMessageId);
const synthesized = (harness: Harness) =>
	harness.auraCalls.map((call) => (call.inputs as { text: string }).text);
const chatPosts = (harness: Harness) =>
	harness.requests
		.filter((request) => request.path.endsWith("/chat"))
		.map((request) => String(request.body.message));

async function waitFor(condition: () => boolean) {
	for (let waited = 0; waited < 3_000 && !condition(); waited += 20) {
		await sleep(20);
	}
	assert.ok(condition(), "timed out");
}

/** Fabric's answer to Alex's question, posted as P1. */
async function answerForAlex(harness: Harness) {
	const posted = await workerPost(harness, {
		message: "F-12 ships on Friday.",
		turnId: "turn-alex",
		header: {
			kind: "answer",
			asker: ALEX.name,
			request: "When does F-12 ship?",
		},
	});
	assert.deepEqual(posted, { sent: true, tag: "P1", delivery: "queued" });
	assert.deepEqual(chatPosts(harness), [
		"[P1] **Answer** for Alex Example\n*“When does F-12 ship?”*\nF-12 ships on Friday.",
	]);
}

test("each participant's typed request reaches Fabric as that participant, with everyone confirmed, and a name alone places no one", async () => {
	const harness = await checkedMeeting();
	await confirm(harness, ALEX);
	await confirm(harness, BO);
	await confirm(harness, CY);
	const everyone = [ALEX.userId, BO.userId, CY.userId];

	const fromBo = typed("@Fabric Parlume when is the release?", BO);
	await harness.bridge.onRequest(fromBo.request);
	await waitFor(() => turnFor(harness, fromBo.id) !== undefined);
	await closeChatRequest(harness);
	const fromCy = typed("@Fabric Parlume who owns the migration?", CY);
	await harness.bridge.onRequest(fromCy.request);
	await waitFor(() => turnFor(harness, fromCy.id) !== undefined);
	await closeChatRequest(harness);
	const byNameOnly = typed("@Fabric Parlume what is the budget?", {
		name: ALEX.name,
		id: null,
	});
	await harness.bridge.onRequest(byNameOnly.request);
	await waitFor(() => turnFor(harness, byNameOnly.id) !== undefined);

	assert.deepEqual(
		[fromBo, fromCy, byNameOnly].map(({ id }) => {
			const turn = turnFor(harness, id);
			return {
				speakerName: turn?.speakerName,
				requester: turn?.requester,
				attendees: turn?.attendees,
			};
		}),
		[
			{ speakerName: BO.name, requester: BO.userId, attendees: everyone },
			{ speakerName: CY.name, requester: CY.userId, attendees: everyone },
			{ speakerName: ALEX.name, requester: null, attendees: everyone },
		],
	);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a spoken request from a participant other than the inviter reaches Fabric as that participant", async () => {
	const harness = await checkedMeeting();
	await confirm(harness, ALEX);
	await confirm(harness, BO);

	await spoken(harness, BO, "Hey Fabric, when is the release?");

	const [turn] = turns(harness);
	assert.ok(turn, "the request reached Fabric");
	assert.equal(turn.speakerId, BO.id);
	assert.equal(turn.requester, BO.userId);
	assert.deepEqual(plain(turn.attendees), [ALEX.userId, BO.userId]);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a participant who did not ask types go on an answer posted for someone else, and Parlume says that answer without asking Fabric again", async () => {
	const harness = await checkedMeeting();
	await confirm(harness, ALEX);
	await confirm(harness, BO);
	await answerForAlex(harness);
	const keepAlive = setInterval(() => {}, 1_000);

	await harness.bridge.onRequest(typed("go P1", BO).request);
	await waitFor(() => synthesized(harness).length > 0);
	clearInterval(keepAlive);

	const heard = synthesized(harness).join("\n");
	assert.match(heard, /F-12 ships on Friday\./, "the answer is spoken");
	assert.doesNotMatch(heard, /Answer|When does F-12/, "its header is not");
	assert.deepEqual(turns(harness), [], "the stored answer is used");
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a participant who did not ask says go on an answer posted for someone else, and Parlume says that answer without asking Fabric again", async () => {
	const harness = await checkedMeeting();
	await confirm(harness, ALEX);
	await confirm(harness, BO);
	await answerForAlex(harness);
	const keepAlive = setInterval(() => {}, 1_000);

	await spoken(harness, BO, "Hey Fabric, go P1");
	await waitFor(() => synthesized(harness).length > 0);
	clearInterval(keepAlive);

	const heard = synthesized(harness).join("\n");
	assert.match(heard, /F-12 ships on Friday\./, "the answer is spoken");
	assert.deepEqual(turns(harness), [], "the stored answer is used");
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a guest who joins a meeting of confirmed members stops every answer reaching it, whoever asks or picks a post, until the guest leaves", async () => {
	const harness = await checkedMeeting();
	await confirm(harness, ALEX);
	await confirm(harness, BO);
	await answerForAlex(harness);

	await guests(harness, [], [{ id: GUEST.id, pending: true }]);
	await guests(
		harness,
		[{ id: GUEST.id, joined: true }],
		[{ id: GUEST.id, pending: false }],
	);
	await flush();
	const postsBefore = chatPosts(harness).length;

	const said = await workerSay(harness, "F-14 is late.");
	const posted = await workerPost(harness, {
		message: "F-14 is late.",
		turnId: "turn-bo",
		header: { kind: "answer", asker: BO.name, request: "Is F-14 on time?" },
	});
	await harness.bridge.onRequest(typed("go P1", BO).request);
	await harness.bridge.onRequest(
		typed("@Fabric Parlume what is the budget?", GUEST).request,
	);
	await sleep(200);
	await flush();

	assert.equal(said.played, false);
	assert.equal(said.stopped, "guest");
	assert.deepEqual(posted, { sent: false, reason: "guests_present" });
	assert.deepEqual(synthesized(harness), [], "nothing was spoken");
	const later = chatPosts(harness).slice(postsBefore);
	assert.deepEqual(
		later.filter((post) => /F-1[24]/.test(post)),
		[],
	);
	const guestTurns = turns(harness).filter((t) => t.speakerId === GUEST.id);
	assert.deepEqual(
		guestTurns,
		[],
		"a guest's request is not asked of Fabric",
	);

	await guests(
		harness,
		[{ id: GUEST.id, joined: false }],
		[{ id: GUEST.id, pending: false }],
	);
	const keepAlive = setInterval(() => {}, 1_000);
	const after = await workerSay(harness, "F-14 is late.");
	clearInterval(keepAlive);
	assert.equal(after.played, true);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});

test("a participant who joins mid-call holds every answer while Fabric checks them, and counts among the attendees once confirmed", async () => {
	const harness = await checkedMeeting();
	await confirm(harness, ALEX);
	await confirm(harness, BO);

	await checking(harness, CY);
	const said = await workerSay(harness, "F-14 is late.");
	const posted = await workerPost(harness, {
		message: "F-14 is late.",
		turnId: "turn-bo",
	});
	assert.equal(said.played, false);
	assert.deepEqual(posted, { sent: false, reason: "guests_present" });
	assert.deepEqual(synthesized(harness), []);

	await confirmed(harness, CY);
	const fromBo = typed("@Fabric Parlume is F-14 on time?", BO);
	await harness.bridge.onRequest(fromBo.request);
	await waitFor(() => turnFor(harness, fromBo.id) !== undefined);

	assert.equal(turnFor(harness, fromBo.id)?.requester, BO.userId);
	assert.deepEqual(plain(turnFor(harness, fromBo.id)?.attendees), [
		ALEX.userId,
		BO.userId,
		CY.userId,
	]);
	await harness.bridge.onClose(harness.bot, 1000, "done");
});
