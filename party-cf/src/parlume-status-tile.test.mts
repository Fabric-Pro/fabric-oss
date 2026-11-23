import assert from "node:assert/strict";
import test from "node:test";
import { loadParlumeModule } from "./parlume-test-runtime.mts";

// The bot's video tile follows what Parlume is doing.

type TileState = "LISTENING" | "PAUSED" | "ANSWERING";

const { ParlumeStatusTile } = loadParlumeModule(
	"./parlume-status-tile.ts",
	async () => Response.json({}),
) as {
	ParlumeStatusTile: new (
		host: unknown,
	) => {
		observing(
			log: (level: string, event: string, meta: object) => void,
		): (level: string, event: string, meta: object) => void;
		changed(delayMs?: number): void;
		sync(): Promise<void>;
	};
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tile() {
	let state: TileState = "LISTENING";
	let fabricUp = true;
	const shown: unknown[] = [];
	const statusTile = new ParlumeStatusTile({
		state: () => state,
		bot: async () => ({ sessionId: "session-1", botId: "bot-1" }),
		postToFabric: async (path: string, body: unknown) => {
			if (!fabricUp) {
				return null;
			}
			shown.push({ path, body: JSON.parse(JSON.stringify(body)) });
			return Response.json({ accepted: true });
		},
		log: () => {},
	});
	return {
		statusTile,
		shown,
		set: (next: TileState) => {
			state = next;
		},
		fabric: (up: boolean) => {
			fabricUp = up;
		},
	};
}

test("shows the state once, and again only when it changes", async () => {
	const { statusTile, shown, set } = tile();

	await statusTile.sync();
	await statusTile.sync();
	set("PAUSED");
	await statusTile.sync();

	assert.deepEqual(shown, [
		{
			path: "/api/internal/parlume/status-image",
			body: {
				sessionId: "session-1",
				botId: "bot-1",
				state: "LISTENING",
			},
		},
		{
			path: "/api/internal/parlume/status-image",
			body: { sessionId: "session-1", botId: "bot-1", state: "PAUSED" },
		},
	]);
});

test("a speech or listening event shows the state once it settles", async () => {
	const { statusTile, shown, set } = tile();
	const log = statusTile.observing(() => {});

	set("ANSWERING");
	log("info", "speech.started", {});
	log("info", "speech.synthesized", {});
	log("info", "segment.flushed", {});
	assert.equal(shown.length, 0, "not before it settles");
	await sleep(600);

	assert.equal(shown.length, 1);
	assert.equal(
		(shown[0] as { body: { state: string } }).body.state,
		"ANSWERING",
	);
});

test("a state Fabric could not take is sent again on the next sync", async () => {
	const { statusTile, shown, fabric } = tile();

	fabric(false);
	await statusTile.sync();
	fabric(true);
	await statusTile.sync();

	assert.equal(shown.length, 1);
});

test("while it answers, the state is read again until the answer ends", async () => {
	const { statusTile, shown, set } = tile();
	set("ANSWERING");
	await statusTile.sync();

	set("LISTENING");
	await sleep(2_300);

	assert.deepEqual(
		shown.map((entry) => (entry as { body: { state: string } }).body.state),
		["ANSWERING", "LISTENING"],
	);
});
