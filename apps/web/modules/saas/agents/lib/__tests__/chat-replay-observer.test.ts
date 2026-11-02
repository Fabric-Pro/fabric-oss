import { QueryNotRegisteredError } from "@repo/temporal/temporal-client-errors";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatReplayAuthorizationError } from "../server/chat-event-replay";
import {
	createChatReplayObserver,
	isFatalChatReplayError,
} from "../server/chat-replay-observer";
import { ChatRunAccessError } from "../server/chat-run-control";

const h = vi.hoisted(() => ({
	read: vi.fn(),
	authorize: vi.fn(),
	query: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	readConversationTurnEvents: h.read,
	hasConversationTurnReplayGap: vi.fn().mockResolvedValue(false),
	ChatEventReplayError: class extends Error {},
}));
vi.mock("@repo/observability", () => ({
	metricsTracker: { trackAiLimitSignal: vi.fn() },
}));
vi.mock("../server/chat-run-control", () => ({
	getAuthorizedChatRun: h.authorize,
	ChatRunAccessError: class extends Error {},
}));
const cursor = (sequence = "1") => ({
	turnId: "example-turn",
	runId: "example-run",
	sequence,
});
const event = (sequence = "1") =>
	({
		event: "execution.text_delta",
		data: { text: sequence },
		eventCursor: cursor(sequence),
	}) as const;
function observer() {
	const send = vi.fn();
	const onFailure = vi.fn();
	return {
		send,
		onFailure,
		observer: createChatReplayObserver({
			enabled: true,
			turnId: "example-turn",
			executionId: "orch-example",
			organizationId: "example-org",
			userId: "example-user",
			send,
			onFailure,
			isClosed: () => false,
		}),
	};
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(10000);
	vi.resetAllMocks();
	h.read.mockResolvedValue([]);
	h.query.mockResolvedValue({ version: 1, unavailable: false });
	h.authorize.mockResolvedValue({
		description: { runId: "example-run" },
		handle: { query: h.query },
	});
});
afterEach(() => vi.useRealTimers());
it.each([
	new Error("storage down"),
	new QueryNotRegisteredError("unknown"),
	new Error("query failed"),
])(
	"degrades nonfatal read/query errors and keeps status polling usable: %s",
	async (error) => {
		const run = observer();
		await run.observer.initialize();
		h.read.mockResolvedValue([{ ...event(), cursor: cursor() }]);
		h.query.mockRejectedValue(error);
		await expect(run.observer.beforeState(false)).resolves.toBeUndefined();
		expect(run.send).toHaveBeenCalledWith(
			error instanceof QueryNotRegisteredError
				? { type: "replay_unavailable", reason: "query_not_registered" }
				: { type: "replay_unavailable" },
		);
		expect(run.observer.onExecutionEvent(event("2"))).toBe(false);
		expect(run.onFailure).not.toHaveBeenCalled();
	},
);
it("forwards buffered live output on a gap without duplicating delivered rows", async () => {
	const run = observer();
	await run.observer.initialize();
	h.read.mockResolvedValueOnce([{ ...event(), cursor: cursor() }]);
	await run.observer.beforeState(false);
	run.observer.onExecutionEvent(event());
	run.observer.onExecutionEvent({ ...event("2"), replayUnavailable: true });
	expect(run.send.mock.calls.map(([e]) => [e.type, e.content])).toEqual([
		["text_delta", "1"],
		["replay_unavailable", undefined],
		["text_delta", "2"],
	]);
});
it("bounds integrity queries and forces a terminal query even without rows", async () => {
	const run = observer();
	await run.observer.initialize();
	h.read.mockResolvedValue([{ ...event(), cursor: cursor() }]);
	await run.observer.beforeState(false);
	run.observer.onExecutionEvent(event("2"));
	await vi.advanceTimersByTimeAsync(0);
	expect(h.query).toHaveBeenCalledTimes(1);
	h.read.mockResolvedValue([]);
	await run.observer.beforeState(true);
	expect(h.query).toHaveBeenCalledTimes(2);
});
it("degrades a successfully authorized continue-as-new", async () => {
	const run = observer();
	await run.observer.initialize();
	h.authorize.mockResolvedValue({
		description: { runId: "example-next-run" },
	});
	await run.observer.beforeState(false);
	expect(run.send).toHaveBeenCalledWith({ type: "replay_unavailable" });
});
it("keeps access failures fatal", async () => {
	const run = observer();
	await run.observer.initialize();
	h.authorize.mockRejectedValue(new ChatRunAccessError());
	await expect(run.observer.beforeState(false)).rejects.toSatisfy(
		isFatalChatReplayError,
	);
	expect(run.send).not.toHaveBeenCalled();
});
it("bounds pending wakeups and falls back to live", async () => {
	const run = observer();
	await run.observer.initialize();
	h.read.mockReturnValue(new Promise(() => {}));
	for (let i = 1; i <= 200; i++) {
		run.observer.onExecutionEvent(event(String(i)));
	}
	expect(run.send).toHaveBeenCalledTimes(201);
	expect(run.observer.onExecutionEvent(event("201"))).toBe(false);
});

it("detects output from an old worker without a cursor", async () => {
	const run = observer();
	await run.observer.initialize();
	expect(
		run.observer.onExecutionEvent({
			event: "execution.text_delta",
			data: { text: "Legacy prefix" },
		}),
	).toBe(false);
	expect(run.send).toHaveBeenCalledWith({ type: "replay_unavailable" });
});

it("bounds a hanging integrity query so polling can continue", async () => {
	const run = observer();
	await run.observer.initialize();
	h.read.mockResolvedValue([{ ...event(), cursor: cursor() }]);
	h.query.mockReturnValue(new Promise(() => {}));
	const poll = run.observer.beforeState(false);
	await vi.advanceTimersByTimeAsync(1000);
	await poll;
	expect(run.send).toHaveBeenCalledWith({ type: "replay_unavailable" });
});
it("disables replay without a turn or physical run", async () => {
	h.authorize.mockResolvedValue({ description: {}, handle: {} });
	const run = observer();
	await run.observer.initialize();
	expect(run.send).toHaveBeenCalledWith({ type: "replay_unavailable" });
});
it("does not drain after fallback when a delayed journal read resolves", async () => {
	let release = (_rows: unknown[]) => {};
	h.read.mockReturnValue(
		new Promise((resolve) => {
			release = resolve;
		}),
	);
	const run = observer();
	await run.observer.initialize();
	const poll = run.observer.beforeState(false);
	await vi.advanceTimersByTimeAsync(0);
	run.observer.onExecutionEvent({ ...event(), replayUnavailable: true });
	release([{ ...event(), cursor: cursor() }]);
	await poll;
	expect(run.send.mock.calls.map(([e]) => e.type)).toEqual([
		"replay_unavailable",
		"text_delta",
	]);
});

it("disables replay when the workflow reports an incomplete journal", async () => {
	const run = observer();
	await run.observer.initialize();
	h.read.mockResolvedValue([{ ...event(), cursor: cursor() }]);
	h.query.mockResolvedValue({ version: 1, unavailable: true });
	await run.observer.beforeState(false);
	expect(run.send).toHaveBeenCalledExactlyOnceWith({
		type: "replay_unavailable",
	});
});
it("does not forward a delayed Redis notification for a row already delivered before fallback", async () => {
	const run = observer();
	await run.observer.initialize();
	h.read.mockResolvedValue([{ ...event(), cursor: cursor() }]);
	await run.observer.beforeState(false);
	run.observer.onExecutionEvent({ ...event("2"), replayUnavailable: true });
	expect(run.observer.onExecutionEvent(event())).toBe(true);
	expect(run.observer.onExecutionEvent(event("3"))).toBe(false);
});

it.each(["initialize", "recheck"])(
	"keeps live output open after temporary authorization error at %s",
	async (phase) => {
		const run = observer();
		if (phase === "recheck") {
			await run.observer.initialize();
		}
		h.authorize.mockRejectedValue(new Error("Temporary database failure"));
		if (phase === "initialize") {
			await expect(run.observer.initialize()).resolves.toBeNull();
		} else {
			await expect(
				run.observer.beforeState(false),
			).resolves.toBeUndefined();
		}
		expect(run.send).toHaveBeenCalledExactlyOnceWith({
			type: "replay_unavailable",
		});
		expect(run.observer.onExecutionEvent(event("2"))).toBe(false);
		expect(run.onFailure).not.toHaveBeenCalled();
	},
);
it.each([
	new ChatRunAccessError(),
	new ChatReplayAuthorizationError(new ChatRunAccessError()),
])(
	"keeps definite direct or wrapped denial fatal at initialization: %s",
	async (error) => {
		const run = observer();
		h.authorize.mockRejectedValue(error);
		await expect(run.observer.initialize()).rejects.toBe(error);
		expect(isFatalChatReplayError(error)).toBe(true);
		expect(run.send).not.toHaveBeenCalled();
	},
);
