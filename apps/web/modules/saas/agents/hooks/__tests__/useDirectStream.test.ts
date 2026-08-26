/**
 * Unit tests for `useDirectStream.stop()` semantics.
 *
 * Spec: `specs/2026-05-09-stop-ai-generation/spec.md` section 8.2 +
 * decisions 11/12/19. Covers Task 2.5 acceptance criteria from
 * `specs/2026-05-09-stop-ai-generation/tasks.md`:
 *
 *  - `stop()` aborts the controller and flips `streamStatus` to
 *    `"cancelled"`.
 *  - Trailing SSE deltas after `stop()` are dropped (freeze gate /
 *    AC-11).
 *  - `stop()` is a no-op when no in-flight stream exists.
 *  - `onStopFailed` fires on cancel-endpoint 5xx; visual state does
 *    NOT revert (decision 11 / AC-10).
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Group 3 owns this module — the unit tests mock it so the hook tests
// don't depend on Group 3 having landed.
vi.mock("../../lib/cancel-telemetry", () => ({
	emitCancelEvent: vi.fn(),
}));

import { emitCancelEvent } from "../../lib/cancel-telemetry";
import { useDirectStream } from "../useDirectStream";

const emitCancelEventMock = vi.mocked(emitCancelEvent);

/**
 * Build a `Response`-shaped object whose body yields the given SSE
 * data lines on demand. The reader resolves chunks one by one in the
 * order they're queued; if the queue is empty when `read()` is
 * called, it waits (returning a promise that the test can resolve
 * by enqueueing more) so we can interleave deltas with `stop()`.
 */
function makeSseResponse() {
	const encoder = new TextEncoder();
	const queue: Array<{ value?: Uint8Array; done?: boolean }> = [];
	let resolveNext: (() => void) | null = null;

	const read = () =>
		new Promise<{ value?: Uint8Array; done?: boolean }>((resolve) => {
			const drain = () => {
				const next = queue.shift();
				if (next) {
					resolve({
						value: next.value,
						done: next.done ?? false,
					});
					return true;
				}
				return false;
			};
			if (drain()) {
				return;
			}
			resolveNext = () => {
				if (drain()) {
					return;
				}
			};
		});

	const enqueueLine = (line: string) => {
		queue.push({ value: encoder.encode(`${line}\n`) });
		const r = resolveNext;
		resolveNext = null;
		r?.();
	};

	const enqueueDone = () => {
		queue.push({ done: true });
		const r = resolveNext;
		resolveNext = null;
		r?.();
	};

	const response = {
		ok: true,
		body: {
			getReader: () => ({ read }),
		},
		json: async () => ({}),
	};

	return { response, enqueueLine, enqueueDone };
}

describe("useDirectStream.stop()", () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		emitCancelEventMock.mockClear();
	});

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("is a no-op when no stream is in-flight", () => {
		const { result } = renderHook(() => useDirectStream());

		// No sendMessage has been called — stop should silently bail.
		act(() => {
			result.current.stop("button");
		});

		expect(emitCancelEventMock).not.toHaveBeenCalled();
		expect(result.current.isLoading).toBe(false);
	});

	it("aborts the controller and flips streamStatus to cancelled", async () => {
		const { response, enqueueLine, enqueueDone } = makeSseResponse();
		const fetchSpy = vi
			.spyOn(global, "fetch")
			.mockImplementation(((..._args: unknown[]) =>
				Promise.resolve(response)) as unknown as typeof fetch);

		const { result } = renderHook(() => useDirectStream());

		// Start streaming.
		let sendPromise: Promise<string | null> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("hello");
		});

		// Server emits the "started" event with a workflow id.
		await act(async () => {
			enqueueLine(
				'data: {"type":"started","executionId":"direct-chat-aaaa"}',
			);
		});

		// Some text streamed.
		await act(async () => {
			enqueueLine('data: {"type":"text","content":"part 1 "}');
		});

		await waitFor(() => {
			const lastMessage =
				result.current.messages[result.current.messages.length - 1];
			expect(lastMessage?.content).toContain("part 1");
			expect(lastMessage?.executionId).toBe("direct-chat-aaaa");
		});

		// User clicks Stop.
		act(() => {
			result.current.stop("button");
		});

		// Synchronous flip — the message must be in cancelled state and
		// the hook must no longer be loading.
		const cancelled =
			result.current.messages[result.current.messages.length - 1];
		expect(cancelled?.streamStatus).toBe("cancelled");
		expect(cancelled?.cancelledAt).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
		);
		expect(result.current.isLoading).toBe(false);
		expect(result.current.state.status).toBe("cancelled");

		// Cancel POST fired against the new stream/cancel endpoint.
		expect(fetchSpy).toHaveBeenCalledWith(
			"/api/agents/fabric-ai/stream/cancel",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ executionId: "direct-chat-aaaa" }),
			}),
		);

		// Telemetry event was emitted with `triggered_by: "button"`.
		expect(emitCancelEventMock).toHaveBeenCalledTimes(1);
		expect(emitCancelEventMock).toHaveBeenCalledWith(
			expect.objectContaining({
				surface: "loom-direct",
				agentId: null,
				executionId: "direct-chat-aaaa",
				triggered_by: "button",
			}),
		);

		// Drain the in-flight reader to settle the sendMessage promise.
		await act(async () => {
			enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	});

	it("drops trailing SSE text deltas after stop() (freeze gate)", async () => {
		const { response, enqueueLine, enqueueDone } = makeSseResponse();
		vi.spyOn(global, "fetch").mockImplementation(((..._args: unknown[]) =>
			Promise.resolve(response)) as unknown as typeof fetch);

		const { result } = renderHook(() => useDirectStream());

		let sendPromise: Promise<string | null> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("hi");
		});

		await act(async () => {
			enqueueLine(
				'data: {"type":"started","executionId":"direct-chat-bbbb"}',
			);
		});
		await act(async () => {
			enqueueLine('data: {"type":"text","content":"before "}');
		});

		await waitFor(() => {
			const m =
				result.current.messages[result.current.messages.length - 1];
			expect(m?.content).toContain("before");
		});

		// Snapshot the partial body BEFORE stop.
		const partialBefore =
			result.current.messages[result.current.messages.length - 1]
				?.content;

		// User clicks Stop.
		act(() => {
			result.current.stop("button");
		});

		// Server keeps streaming after the click.
		await act(async () => {
			enqueueLine('data: {"type":"text","content":"after-stop"}');
		});
		await act(async () => {
			enqueueLine('data: {"type":"done"}');
		});
		await act(async () => {
			enqueueDone();
		});

		// The post-stop deltas must NOT have advanced the message.
		const last =
			result.current.messages[result.current.messages.length - 1];
		expect(last?.content).toBe(partialBefore);
		expect(last?.streamStatus).toBe("cancelled");

		await act(async () => {
			await sendPromise;
		});
	});

	it("invokes onStopFailed when the cancel POST returns 500 and does NOT revert state", async () => {
		const { response, enqueueLine, enqueueDone } = makeSseResponse();
		const onStopFailed = vi.fn();
		const fetchImpl = vi
			.fn()
			.mockImplementationOnce(() => Promise.resolve(response))
			.mockImplementationOnce(() =>
				// Cancel endpoint failure
				Promise.resolve({ ok: false, status: 500 } as Response),
			);
		global.fetch = fetchImpl as unknown as typeof fetch;

		const { result } = renderHook(() => useDirectStream({ onStopFailed }));

		let sendPromise: Promise<string | null> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("hi");
		});
		await act(async () => {
			enqueueLine(
				'data: {"type":"started","executionId":"direct-chat-cccc"}',
			);
		});

		await waitFor(() => {
			const m =
				result.current.messages[result.current.messages.length - 1];
			expect(m?.executionId).toBe("direct-chat-cccc");
		});

		act(() => {
			result.current.stop("button");
		});

		// Wait for the fire-and-forget POST to settle.
		await waitFor(() => {
			expect(onStopFailed).toHaveBeenCalledTimes(1);
		});

		// Visual state must NOT have reverted — message is still
		// cancelled, hook is not loading.
		const last =
			result.current.messages[result.current.messages.length - 1];
		expect(last?.streamStatus).toBe("cancelled");
		expect(result.current.isLoading).toBe(false);
		expect(result.current.state.status).toBe("cancelled");

		await act(async () => {
			enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	});

	it("threads triggered_by=esc into telemetry", async () => {
		const { response, enqueueLine, enqueueDone } = makeSseResponse();
		vi.spyOn(global, "fetch").mockImplementation(((..._args: unknown[]) =>
			Promise.resolve(response)) as unknown as typeof fetch);

		const { result } = renderHook(() =>
			useDirectStream({ surface: "fabric-agent-launcher" }),
		);

		let sendPromise: Promise<string | null> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("hi");
		});
		await act(async () => {
			enqueueLine(
				'data: {"type":"started","executionId":"direct-chat-dddd"}',
			);
		});
		await waitFor(() => {
			expect(result.current.isLoading).toBe(true);
		});

		act(() => {
			result.current.stop("esc");
		});

		expect(emitCancelEventMock).toHaveBeenCalledWith(
			expect.objectContaining({
				surface: "fabric-agent-launcher",
				triggered_by: "esc",
			}),
		);

		await act(async () => {
			enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	});
});

describe("useDirectStream — focused entity context", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	// The Fabric Agent (page copilot) forwards the id of the feature/document/
	// task the user is currently viewing so the backend can ground the agent on
	// that item's FULL content. They must reach the send POST body verbatim.
	it("forwards focused entity ids (storyId/documentId/taskId/projectId) in the send body", async () => {
		const { response, enqueueDone } = makeSseResponse();
		const fetchSpy = vi
			.spyOn(global, "fetch")
			.mockImplementation(((..._args: unknown[]) =>
				Promise.resolve(response)) as unknown as typeof fetch);

		const { result } = renderHook(() =>
			useDirectStream({
				projectId: "proj-1",
				storyId: "story-1",
				documentId: "doc-1",
				taskId: "task-1",
			}),
		);

		act(() => {
			void result.current.sendMessage("hi");
		});

		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith(
				"/api/agents/fabric-ai/stream",
				expect.any(Object),
			);
		});

		const streamCall = fetchSpy.mock.calls.find(
			(call) => call[0] === "/api/agents/fabric-ai/stream",
		);
		const body = JSON.parse(
			(streamCall?.[1] as { body: string }).body,
		) as Record<string, unknown>;
		expect(body).toMatchObject({
			projectId: "proj-1",
			storyId: "story-1",
			documentId: "doc-1",
			taskId: "task-1",
		});

		await act(async () => {
			enqueueDone();
		});
	});

	// When the agent is NOT on a focused page, the ids are absent (undefined) and
	// must serialize away entirely — no `storyId: null` noise on the wire.
	it("omits focused ids from the body when not provided", async () => {
		const { response, enqueueDone } = makeSseResponse();
		const fetchSpy = vi
			.spyOn(global, "fetch")
			.mockImplementation(((..._args: unknown[]) =>
				Promise.resolve(response)) as unknown as typeof fetch);

		const { result } = renderHook(() => useDirectStream({}));
		act(() => {
			void result.current.sendMessage("hi");
		});

		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith(
				"/api/agents/fabric-ai/stream",
				expect.any(Object),
			);
		});
		const streamCall = fetchSpy.mock.calls.find(
			(call) => call[0] === "/api/agents/fabric-ai/stream",
		);
		const body = JSON.parse(
			(streamCall?.[1] as { body: string }).body,
		) as Record<string, unknown>;
		expect(body).not.toHaveProperty("storyId");
		expect(body).not.toHaveProperty("documentId");
		expect(body).not.toHaveProperty("taskId");

		await act(async () => {
			enqueueDone();
		});
	});
});

describe("useDirectStream — model override", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	// The stream route has always accepted `modelOverride`; the Loom client
	// simply never sent it, so picking a raw model in the agent picker had
	// nowhere to land (#2040). The canonical model name must reach the send
	// POST body verbatim or the picker silently runs the org default.
	it("forwards the canonical model name in the send body", async () => {
		const { response, enqueueDone } = makeSseResponse();
		const fetchSpy = vi
			.spyOn(global, "fetch")
			.mockImplementation(((..._args: unknown[]) =>
				Promise.resolve(response)) as unknown as typeof fetch);

		const { result } = renderHook(() =>
			useDirectStream({ modelOverride: "claude-opus-5" }),
		);

		act(() => {
			void result.current.sendMessage("hi");
		});

		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith(
				"/api/agents/fabric-ai/stream",
				expect.any(Object),
			);
		});

		const streamCall = fetchSpy.mock.calls.find(
			(call) => call[0] === "/api/agents/fabric-ai/stream",
		);
		const body = JSON.parse(
			(streamCall?.[1] as { body: string }).body,
		) as Record<string, unknown>;
		expect(body).toMatchObject({ modelOverride: "claude-opus-5" });

		await act(async () => {
			enqueueDone();
		});
	});

	// No pick means no override — the backend resolves the configured model.
	// The field must serialize away entirely rather than ride the wire as
	// `modelOverride: null`, matching the focused-id convention above.
	it("omits the override from the body when no model is picked", async () => {
		const { response, enqueueDone } = makeSseResponse();
		const fetchSpy = vi
			.spyOn(global, "fetch")
			.mockImplementation(((..._args: unknown[]) =>
				Promise.resolve(response)) as unknown as typeof fetch);

		const { result } = renderHook(() => useDirectStream({}));

		act(() => {
			void result.current.sendMessage("hi");
		});

		await waitFor(() => {
			expect(fetchSpy).toHaveBeenCalledWith(
				"/api/agents/fabric-ai/stream",
				expect.any(Object),
			);
		});

		const streamCall = fetchSpy.mock.calls.find(
			(call) => call[0] === "/api/agents/fabric-ai/stream",
		);
		const body = JSON.parse(
			(streamCall?.[1] as { body: string }).body,
		) as Record<string, unknown>;
		expect(body).not.toHaveProperty("modelOverride");

		await act(async () => {
			enqueueDone();
		});
	});
});
