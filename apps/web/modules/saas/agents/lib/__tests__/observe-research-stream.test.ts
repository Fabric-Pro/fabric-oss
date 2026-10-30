import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeResearchStream } from "../observe-research-stream";

function stream(...events: Record<string, unknown>[]) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(
					new TextEncoder().encode(
						`data: ${JSON.stringify(event)}\n\n`,
					),
				);
			}
			controller.close();
		},
	});
}

const started = { type: "started", executionId: "orch-example" };
const completed = { type: "completed", response: "Finished" };
const timeout = { type: "stream_timeout", executionId: "orch-example" };

function observe(body: ReadableStream<Uint8Array>, executionId?: string) {
	const controller = new AbortController();
	const onEvent = vi.fn();
	const reattach = vi.fn(
		async () => new Response(stream(started, completed)),
	);
	const result = observeResearchStream(body, {
		executionId,
		signal: controller.signal,
		onEvent,
		reattach,
	});
	// Attach rejection handling immediately so fake timer advances cannot
	// create unhandled rejections before the test asserts the failure.
	const outcome = result.then(
		() => null,
		(error: Error) => error,
	);
	return { controller, onEvent, reattach, result, outcome };
}

describe("Research stream observation", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("reattaches to the same run on a window timeout without exposing a failure", async () => {
		const run = observe(
			stream(
				started,
				{ type: "text_delta", content: "Partial" },
				timeout,
			),
		);
		await run.result;
		expect(run.reattach).toHaveBeenCalledExactlyOnceWith(
			"orch-example",
			run.controller.signal,
			undefined,
		);
		expect(run.onEvent.mock.calls.map(([event]) => event.type)).toEqual([
			"started",
			"text_delta",
			"started",
			"completed",
		]);
	});

	it("recovers an unclean EOF after a delay", async () => {
		const run = observe(stream(started));
		await vi.advanceTimersByTimeAsync(1999);
		expect(run.reattach).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await run.result;
		expect(run.reattach).toHaveBeenCalledOnce();
	});

	it("resumes after the last applied cursor and drops duplicate text from replay", async () => {
		const cursor = (sequence: string) => ({
			turnId: "example-turn",
			runId: "example-run",
			sequence,
		});
		const run = observe(
			stream(
				started,
				{
					type: "text_delta",
					content: "First",
					eventCursor: cursor("1"),
				},
				timeout,
			),
		);
		run.reattach.mockResolvedValueOnce(
			new Response(
				stream(
					started,
					{
						type: "text_delta",
						content: "First",
						eventCursor: cursor("1"),
					},
					{
						type: "text_delta",
						content: " Second",
						eventCursor: cursor("2"),
					},
					completed,
				),
			),
		);
		await run.result;
		expect(run.reattach).toHaveBeenCalledWith(
			"orch-example",
			run.controller.signal,
			cursor("1"),
		);
		expect(
			run.onEvent.mock.calls
				.filter(([event]) => event.type === "text_delta")
				.map(([event]) => event.content),
		).toEqual(["First", " Second"]);
	});

	it("does not retry an initial stream that never identifies its run", async () => {
		const run = observe(stream({ type: "text", content: "Partial" }));
		expect(await run.outcome).toMatchObject({
			message: expect.stringContaining("partial reply"),
		});
		expect(run.reattach).not.toHaveBeenCalled();
	});

	it("can observe a hydrated run when the first resumed window closes before started", async () => {
		const run = observe(stream(), "orch-example");
		await vi.advanceTimersByTimeAsync(2000);
		await run.result;
		expect(run.reattach).toHaveBeenCalledOnce();
	});

	it.each([
		{ type: "text_delta", content: 123 },
		{ type: "text_delta", content: "Unsupported", version: 99 },
		{ type: "started", executionId: "orch-other" },
		{ type: "started", executionId: " " },
	])("never retries a contract failure: %j", async (invalid) => {
		const run = observe(stream(started, invalid));
		expect(await run.outcome).toBeInstanceOf(Error);
		expect(run.reattach).not.toHaveBeenCalled();
	});

	it.each([
		completed,
		{ type: "done" },
		{ type: "error", message: "Provider failed" },
	])("does not retry a terminal event: %j", async (terminal) => {
		const run = observe(stream(started, terminal));
		await run.result;
		expect(run.reattach).not.toHaveBeenCalled();
	});

	it("has a finite timeout budget", async () => {
		const run = observe(stream(started, timeout));
		run.reattach.mockImplementation(
			async () => new Response(stream(started, timeout)),
		);
		expect(await run.outcome).toBeInstanceOf(Error);
		expect(run.reattach).toHaveBeenCalledTimes(15);
	});

	it("replayed progress cannot refill the transport failure budget", async () => {
		const run = observe(stream(started));
		run.reattach.mockImplementation(
			async () =>
				new Response(
					stream(started, {
						type: "progress",
						message: "Still running",
					}),
				),
		);
		await vi.advanceTimersByTimeAsync(6000);
		expect(await run.outcome).toBeInstanceOf(Error);
		expect(run.reattach).toHaveBeenCalledTimes(3);
	});

	it.each([502, 503, 504])(
		"recovers a transient HTTP %i on reattach",
		async (status) => {
			const run = observe(stream(started, timeout));
			run.reattach.mockResolvedValueOnce(new Response(null, { status }));
			await vi.advanceTimersByTimeAsync(2000);
			await run.result;
			expect(run.reattach).toHaveBeenCalledTimes(2);
		},
	);

	it.each([400, 401, 403, 404, 409, 429, 500])(
		"stops immediately on a definite HTTP %i refusal",
		async (status) => {
			const run = observe(stream(started, timeout));
			run.reattach.mockResolvedValueOnce(new Response(null, { status }));
			expect(await run.outcome).toMatchObject({
				message: expect.stringContaining("could not be resumed"),
			});
			expect(run.reattach).toHaveBeenCalledOnce();
		},
	);

	it.each(["network", "no body"])(
		"recovers a reconnect with %s",
		async (failure) => {
			const run = observe(stream(started, timeout));
			if (failure === "network") {
				run.reattach.mockRejectedValueOnce(
					new TypeError("Network unavailable"),
				);
			} else {
				run.reattach.mockResolvedValueOnce(new Response(null));
			}
			await vi.advanceTimersByTimeAsync(2000);
			await run.result;
			expect(run.reattach).toHaveBeenCalledTimes(2);
		},
	);

	it("does not retry an access refusal even when disposing its body fails", async () => {
		const run = observe(stream(started, timeout));
		run.reattach.mockResolvedValueOnce(
			new Response(
				new ReadableStream({
					cancel: () =>
						Promise.reject(new Error("Connection already closed")),
				}),
				{ status: 403 },
			),
		);
		expect(await run.outcome).toMatchObject({
			message: expect.stringContaining("could not be resumed"),
		});
		expect(run.reattach).toHaveBeenCalledOnce();
	});

	it("Stop during the retry delay prevents another observation request", async () => {
		const run = observe(stream(started));
		await vi.advanceTimersByTimeAsync(1000);
		run.controller.abort();
		await vi.advanceTimersByTimeAsync(2000);
		expect(await run.outcome).toMatchObject({ name: "AbortError" });
		expect(run.reattach).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("recovers a silent stream and releases its reader", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		const run = observe(body, "orch-example");
		await vi.advanceTimersByTimeAsync(47_000);
		await run.result;
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
		expect(run.reattach).toHaveBeenCalledOnce();
	});

	it("aborts a silent reader immediately without leaving timers or locks", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		const run = observe(body, "orch-example");
		run.controller.abort();
		expect(await run.outcome).toMatchObject({ name: "AbortError" });
		expect(cancel).toHaveBeenCalledOnce();
		expect(body.locked).toBe(false);
		expect(run.reattach).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
