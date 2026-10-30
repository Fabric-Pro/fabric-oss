/**
 * The Redis side of a durable AG-UI run (`agui-run-stream.ts`), against a
 * recording ioredis stand-in:
 *
 *   - each event is one `XADD … MAXLEN ~` entry, and every append renews the
 *     stream's expiry (`EXPIRE`) in the same transaction;
 *   - the input record (the run's input and AI token) is parked with a short
 *     TTL, never overwritten (`NX`), and taken with GET and DEL in one
 *     transaction, so the token leaves Redis on pickup;
 *   - the thread record is a hash that expires with the run's events;
 *   - a failed command inside a transaction rejects instead of passing
 *     silently (ioredis resolves per-command errors);
 *   - no Redis configured, or plaintext Redis in production, refuses to open.
 */
import { EventType } from "@ag-ui/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	commands: [] as unknown[][],
	execResults: null as Array<[Error | null, unknown]> | null,
	urls: [] as string[],
	hash: {} as Record<string, string>,
	entries: [] as Array<[string, string[]]>,
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("ioredis", () => {
	class FakeTransaction {
		private readonly queued: unknown[][] = [];
		xadd(...args: unknown[]) {
			this.queued.push(["xadd", ...args]);
			return this;
		}
		expire(...args: unknown[]) {
			this.queued.push(["expire", ...args]);
			return this;
		}
		hset(...args: unknown[]) {
			this.queued.push(["hset", ...args]);
			return this;
		}
		get(...args: unknown[]) {
			this.queued.push(["get", ...args]);
			return this;
		}
		del(...args: unknown[]) {
			this.queued.push(["del", ...args]);
			return this;
		}
		async exec() {
			h.commands.push(["multi"], ...this.queued, ["exec"]);
			return (
				h.execResults ??
				this.queued.map((): [null, string] => [null, "OK"])
			);
		}
	}
	class FakeRedis {
		constructor(url: string) {
			h.urls.push(url);
		}
		on() {
			return this;
		}
		async connect() {}
		disconnect() {}
		async quit() {
			h.commands.push(["quit"]);
		}
		multi() {
			return new FakeTransaction();
		}
		async set(...args: unknown[]) {
			h.commands.push(["set", ...args]);
			return "OK";
		}
		async get() {
			return null;
		}
		async hgetall(...args: unknown[]) {
			h.commands.push(["hgetall", ...args]);
			return h.hash;
		}
		async xrange(...args: unknown[]) {
			h.commands.push(["xrange", ...args]);
			return h.entries;
		}
		async xrevrange(...args: unknown[]) {
			h.commands.push(["xrevrange", ...args]);
			return h.entries.slice(-1);
		}
		async xread(...args: unknown[]) {
			h.commands.push(["xread", ...args]);
			return [["stream", h.entries]];
		}
	}
	return { default: FakeRedis };
});

const { openAgUiRunStore } = await import("../agui-run-stream");

const RUN = "run-example-0001";
const EVENTS_KEY = `agui:run:${RUN}:events`;
const INPUT_KEY = `agui:run:${RUN}:input`;
const INPUT_RECORD = {
	input: {
		threadId: "thread-example-0001",
		runId: RUN,
		state: {},
		messages: [],
		tools: [],
		context: [],
		forwardedProps: {},
	},
	aiToken: "route-minted-ai-token",
};

beforeEach(() => {
	h.commands.length = 0;
	h.execResults = null;
	h.urls.length = 0;
	h.hash = {};
	h.entries = [];
	vi.stubEnv("CACHE_HOST", "");
	vi.stubEnv("CACHE_PASSWORD", "");
	vi.stubEnv("REDIS_PASSWORD", "");
	vi.stubEnv("REDIS_URL", "redis://cache.example:6379");
	vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("openAgUiRunStore", () => {
	it("appends each event with XADD MAXLEN ~ and renews the stream's expiry", async () => {
		const store = await openAgUiRunStore();
		const event = {
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "answer-1",
			delta: "Hi",
		};

		await store.appendEvent(RUN, event);

		expect(h.urls).toEqual(["redis://cache.example:6379"]);
		expect(h.commands).toEqual([
			["multi"],
			[
				"xadd",
				EVENTS_KEY,
				"MAXLEN",
				"~",
				50_000,
				"*",
				"event",
				JSON.stringify(event),
			],
			["expire", EVENTS_KEY, 6 * 60 * 60],
			["exec"],
		]);
	});

	it("rejects an append whose XADD failed inside the transaction", async () => {
		const store = await openAgUiRunStore();
		h.execResults = [
			[new Error("OOM command not allowed"), null],
			[null, 1],
		];

		await expect(
			store.appendEvent(RUN, { type: EventType.RUN_STARTED }),
		).rejects.toThrow("OOM command not allowed");
	});

	it("parks the input record, token included, for at most half an hour without overwriting it", async () => {
		const store = await openAgUiRunStore();

		await expect(store.writeInput(RUN, INPUT_RECORD)).resolves.toBe(
			INPUT_KEY,
		);
		expect(h.commands).toEqual([
			[
				"set",
				INPUT_KEY,
				JSON.stringify(INPUT_RECORD),
				"EX",
				30 * 60,
				"NX",
			],
		]);
	});

	it("takes the input record with GET and DEL in one transaction", async () => {
		const store = await openAgUiRunStore();
		h.execResults = [
			[null, JSON.stringify(INPUT_RECORD)],
			[null, 1],
		];

		await expect(store.takeInput(INPUT_KEY)).resolves.toEqual(INPUT_RECORD);
		expect(h.commands).toEqual([
			["multi"],
			["get", INPUT_KEY],
			["del", INPUT_KEY],
			["exec"],
		]);
	});

	it("takes nothing when the record is gone or is not a record", async () => {
		const store = await openAgUiRunStore();
		h.execResults = [
			[null, null],
			[null, 0],
		];
		await expect(store.takeInput(INPUT_KEY)).resolves.toBeNull();

		// A bare RunAgentInput (no token) is not a record.
		h.execResults = [
			[null, JSON.stringify(INPUT_RECORD.input)],
			[null, 1],
		];
		await expect(store.takeInput(INPUT_KEY)).resolves.toBeNull();
	});

	it("rejects a take whose transaction failed", async () => {
		const store = await openAgUiRunStore();
		h.execResults = [
			[new Error("LOADING Redis is loading the dataset"), null],
			[null, 0],
		];

		await expect(store.takeInput(INPUT_KEY)).rejects.toThrow(
			"LOADING Redis is loading the dataset",
		);
	});

	it("writes the thread record as a hash that expires with the run's events", async () => {
		const store = await openAgUiRunStore();
		const record = {
			userId: "user-example-1",
			organizationId: "org-example-1",
			latestRunId: RUN,
			workflowId: `agui-run-${RUN}`,
		};

		await store.writeThread("thread-example-0001", record);

		expect(h.commands).toEqual([
			["multi"],
			["hset", "agui:thread:thread-example-0001", record],
			["expire", "agui:thread:thread-example-0001", 6 * 60 * 60],
			["exec"],
		]);
	});

	it("reads a thread record only when all of its fields are there", async () => {
		const store = await openAgUiRunStore();
		h.hash = { userId: "user-example-1", latestRunId: RUN };

		await expect(
			store.readThread("thread-example-0001"),
		).resolves.toBeNull();
	});

	it("reads events after an entry id, from the start, and by blocking", async () => {
		const store = await openAgUiRunStore();
		h.entries = [
			["1-0", ["event", JSON.stringify({ type: EventType.RUN_STARTED })]],
			["2-0", ["event", JSON.stringify({ type: "NOT_AN_EVENT" })]],
		];

		await expect(store.readEvents(RUN, "0")).resolves.toEqual([
			{ id: "1-0", event: { type: EventType.RUN_STARTED } },
		]);
		await store.readEvents(RUN, "1-0");
		await store.readEvents(RUN, "1-0", 5000);
		expect(h.commands).toEqual([
			["xrange", EVENTS_KEY, "-", "+"],
			["xrange", EVENTS_KEY, "(1-0", "+"],
			["xread", "BLOCK", 5000, "STREAMS", EVENTS_KEY, "1-0"],
		]);
	});

	it("refuses to open without a configured Redis", async () => {
		vi.stubEnv("REDIS_URL", "");

		await expect(openAgUiRunStore()).rejects.toThrow(/need Redis/);
	});

	it("refuses plaintext Redis in production", async () => {
		vi.stubEnv("NODE_ENV", "production");

		await expect(openAgUiRunStore()).rejects.toThrow(/plaintext/);
		expect(h.urls).toEqual([]);
	});
});
