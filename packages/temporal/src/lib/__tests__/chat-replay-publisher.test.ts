import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	append: vi.fn(),
	purge: vi.fn(),
	publish: vi.fn(),
	current: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	appendConversationTurnEventFromWorker: h.append,
	ChatEventReplayError: class ChatEventReplayError extends Error {},
	purgeExpiredConversationTurnEvents: h.purge,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({ Context: { current: h.current } }));
vi.mock("ioredis", () => ({
	default: class {
		on() {
			return this;
		}
		async connect() {}
		publish = h.publish;
		async quit() {}
	},
}));
const executionId = "orch-example";
const cursor = { turnId: "example-turn", runId: "example-run", sequence: "1" };

describe("worker replay publication", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.resetAllMocks();
		vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379");
		vi.stubEnv("CACHE_HOST", "");
		h.current.mockReturnValue({
			info: {
				workflowExecution: {
					workflowId: executionId,
					runId: cursor.runId,
				},
				activityId: "example-activity",
				attempt: 1,
			},
		});
		h.append.mockResolvedValue(cursor);
		h.purge.mockResolvedValue(0);
		h.publish.mockResolvedValue(1);
	});
	afterEach(() => vi.unstubAllEnvs());
	it("persists before publishing an acknowledged event", async () => {
		let release: (value: typeof cursor) => void = () => {};
		h.append.mockReturnValue(
			new Promise((resolve) => {
				release = resolve;
			}),
		);
		const { publishExecutionEvent } = await import("../redis-publisher");
		const pending = publishExecutionEvent(executionId, {
			event: "execution.text_delta",
			data: { text: "Example" },
		});
		await vi.waitFor(() => expect(h.append).toHaveBeenCalledOnce());
		expect(h.publish).not.toHaveBeenCalled();
		release(cursor);
		await pending;
		expect(JSON.parse(h.publish.mock.calls[0][1])).toMatchObject({
			eventCursor: cursor,
		});
	});
	it("coalesces small text deltas without delaying provider chunks for database writes", async () => {
		const { publishExecutionEvent } = await import("../redis-publisher");
		await Promise.all([
			publishExecutionEvent(executionId, {
				event: "execution.text_delta",
				data: { text: "First" },
			}),
			publishExecutionEvent(executionId, {
				event: "execution.text_delta",
				data: { text: "Second" },
			}),
		]);
		expect(h.append.mock.calls.map(([input]) => input.sourceKey)).toEqual([
			"example-activity:1:0",
		]);
		expect(h.append.mock.calls.map(([input]) => input.data.text)).toEqual([
			"FirstSecond",
		]);
	});
	it("drains buffered text ahead of a later tool/iteration event and activity completion", async () => {
		const { publishExecutionEvent } = await import("../redis-publisher");
		const { flushExecutionEvents } = await import(
			"../execution-output-drain"
		);
		const text = publishExecutionEvent(executionId, {
			event: "execution.text_delta",
			data: { text: "First" },
		});
		const iteration = publishExecutionEvent(executionId, {
			event: "execution.iteration_start",
			data: { iteration: 2 },
		});
		await flushExecutionEvents();
		await Promise.all([text, iteration]);
		expect(h.append.mock.calls.map(([input]) => input.event)).toEqual([
			"execution.text_delta",
			"execution.iteration_start",
		]);
		expect(h.append.mock.calls.map(([input]) => input.sourceKey)).toEqual([
			"example-activity:1:0",
			"example-activity:1:1",
		]);
	});
	it("retries one transient append with the same idempotency key", async () => {
		h.append.mockRejectedValueOnce(new Error("Pool wait timeout"));
		const { publishExecutionEvent } = await import("../redis-publisher");
		await publishExecutionEvent(executionId, {
			event: "execution.iteration_start",
			data: { iteration: 1 },
		});
		expect(h.append).toHaveBeenCalledTimes(2);
		expect(h.append.mock.calls[0][0]).toEqual(h.append.mock.calls[1][0]);
		expect(JSON.parse(h.publish.mock.calls[0][1])).toMatchObject({
			eventCursor: cursor,
		});
	});
	it("does not announce a cursor when persistence fails", async () => {
		h.append.mockRejectedValue(new Error("Unavailable"));
		const { publishExecutionEvent } = await import("../redis-publisher");
		await publishExecutionEvent(executionId, {
			event: "execution.text_delta",
			data: { text: "Example" },
		});
		const payload = JSON.parse(h.publish.mock.calls[0][1]);
		expect(payload.eventCursor).toBeUndefined();
		expect(payload.replayUnavailable).toBe(true);
	});

	it("marks an incomplete run durably before later publication can skip the gap", async () => {
		const { ChatEventReplayError } = await import("@repo/database");
		h.append.mockRejectedValueOnce(
			new ChatEventReplayError("Output limit"),
		);
		const { publishExecutionEvent } = await import("../redis-publisher");
		await publishExecutionEvent(executionId, {
			event: "execution.text_delta",
			data: { text: "First" },
		});
		await publishExecutionEvent(executionId, {
			event: "execution.text_delta",
			data: { text: "Second" },
		});
		expect(h.append.mock.calls.map(([input]) => input.event)).toEqual([
			"execution.text_delta",
			"execution.replay_unavailable",
		]);
		expect(
			h.publish.mock.calls.every(
				([, payload]) => JSON.parse(payload).replayUnavailable === true,
			),
		).toBe(true);
	});
	it("keeps persisting output when no live Redis transport is configured", async () => {
		vi.stubEnv("REDIS_URL", "");
		const { publishExecutionEvent } = await import("../redis-publisher");
		await publishExecutionEvent(executionId, {
			event: "execution.text_delta",
			data: { text: "Example" },
		});
		expect(h.append).toHaveBeenCalledOnce();
		expect(h.publish).not.toHaveBeenCalled();
	});
	it("bounds a slow journal backlog and records its loss before activity completion", async () => {
		let release: (value: typeof cursor) => void = () => {};
		h.append.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const { publishExecutionEvent } = await import("../redis-publisher");
		const { flushExecutionEvents, executionReplayUnavailable } =
			await import("../execution-output-drain");
		const first = publishExecutionEvent(executionId, {
			event: "execution.iteration_start",
			data: { iteration: 1 },
		});
		await vi.waitFor(() => expect(h.append).toHaveBeenCalledOnce());
		const backlog = Array.from({ length: 40 }, (_, iteration) =>
			publishExecutionEvent(executionId, {
				event: "execution.iteration_start",
				data: { iteration: iteration + 2 },
			}),
		);
		release(cursor);
		await Promise.all([first, ...backlog]);
		await flushExecutionEvents();
		expect(h.append.mock.calls.length).toBeLessThanOrEqual(2);
		expect(executionReplayUnavailable(h.current())).toBe(true);
		expect(h.append).toHaveBeenCalledWith(
			expect.objectContaining({ event: "execution.replay_unavailable" }),
		);
	});
	it("does not splice a retried producer into an uncertain earlier attempt", async () => {
		h.current().info.attempt = 2;
		const { publishExecutionEvent } = await import("../redis-publisher");
		await publishExecutionEvent(executionId, {
			event: "execution.text_delta",
			data: { text: "Retried" },
		});
		expect(
			h.append.mock.calls.every(
				([input]) => input.event === "execution.replay_unavailable",
			),
		).toBe(true);
		expect(JSON.parse(h.publish.mock.calls[0][1]).replayUnavailable).toBe(
			true,
		);
	});
	it("does not attach another workflow's events to this run's replay log", async () => {
		const { publishExecutionEvent } = await import("../redis-publisher");
		await publishExecutionEvent("orch-example-other", {
			event: "execution.text_delta",
			data: { text: "Example" },
		});
		expect(h.append).not.toHaveBeenCalled();
	});
});
