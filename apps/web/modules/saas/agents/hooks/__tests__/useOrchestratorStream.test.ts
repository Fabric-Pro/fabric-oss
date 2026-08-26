/**
 * Unit tests for `useOrchestratorStream.stop()` semantics.
 *
 * Spec: `specs/2026-05-09-stop-ai-generation/spec.md` section 8.3 +
 * decisions 11/12/19/20. Covers Task 2.6 acceptance criteria from
 * `specs/2026-05-09-stop-ai-generation/tasks.md`:
 *
 *  - `stop()` works while `pendingApproval` is true (AC-9 / decision 20).
 *  - `stop()` POSTs to the existing orchestrator-temporal cancel route.
 *  - Trailing SSE deltas after stop are dropped (AC-11 / decision 12).
 *  - Optimistic flip persists across cancel-endpoint failure
 *    (AC-10 / decision 11).
 *
 * The second suite covers the resumable streaming windows from issue #2269:
 * the server ends a long run's stream with `stream_timeout` when its Vercel
 * budget runs out, and the client reconnects with the executionId instead of
 * failing the turn.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/cancel-telemetry", () => ({
	emitCancelEvent: vi.fn(),
}));

// PartyKit hook is irrelevant for these unit tests — stub it out so we
// don't need to spin up a real WebSocket. Returning a flat object lets
// the orchestrator hook destructure without throwing.
vi.mock("../useOrchestratorPartyKit", () => ({
	useOrchestratorPartyKit: () => ({
		isConnected: false,
		toolCalls: [],
		stepProgress: undefined,
		currentPhase: "idle",
		reset: vi.fn(),
		notifyStepStart: vi.fn(),
	}),
}));

import { emitCancelEvent } from "../../lib/cancel-telemetry";
import { useOrchestratorStream } from "../useOrchestratorStream";

const emitCancelEventMock = vi.mocked(emitCancelEvent);

function makeSseResponse() {
	const encoder = new TextEncoder();
	const queue: Array<{ value?: Uint8Array; done?: boolean }> = [];
	let resolveNext: (() => void) | null = null;

	const read = () =>
		new Promise<{ value?: Uint8Array; done?: boolean }>((resolve) => {
			const drain = () => {
				const next = queue.shift();
				if (next) {
					resolve({ value: next.value, done: next.done ?? false });
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
		body: { getReader: () => ({ read }) },
		json: async () => ({}),
	};

	return { response, enqueueLine, enqueueDone };
}

const STREAM_URL = "/api/agents/fabric-ai/orchestrator-temporal/stream";

/**
 * Hands every POST to the stream route its own SSE window, in order, so a
 * test can script exactly what the client sees before and after a
 * reconnect. Any other call (the cancel POST) gets a plain ack.
 *
 * `failAttempts` maps a 0-based stream-POST index to a pre-stream failure —
 * `"reject"` for a fetch that never resolves a response, `"http"` for a 502.
 * A failed attempt consumes no window, so window indexes stay aligned with
 * the attempts that actually opened a stream.
 */
function mockStreamWindows(
	windowCount: number,
	failAttempts: Map<number, "reject" | "http"> = new Map(),
) {
	const windows = Array.from({ length: windowCount }, () =>
		makeSseResponse(),
	);
	/** Serialized request body of each stream POST, in order. */
	const streamBodies: string[] = [];
	let nextWindow = 0;
	let nextAttempt = 0;

	const fetchMock = vi
		.fn()
		.mockImplementation((input: unknown, init?: RequestInit) => {
			const url =
				typeof input === "string" ? input : (input as Request).url;
			if (url !== STREAM_URL) {
				return Promise.resolve({
					ok: true,
					json: async () => ({ success: true }),
				} as Response);
			}
			const attempt = nextAttempt++;
			streamBodies.push(String(init?.body ?? ""));

			const failure = failAttempts.get(attempt);
			if (failure === "reject") {
				return Promise.reject(new TypeError("Failed to fetch"));
			}
			if (failure === "http") {
				return Promise.resolve({
					ok: false,
					status: 502,
					json: async () => ({ error: "Bad Gateway" }),
				} as Response);
			}

			const scripted = windows[nextWindow++];
			if (!scripted) {
				throw new Error(
					`unexpected stream POST #${nextWindow} — only ${windowCount} window(s) scripted`,
				);
			}
			return Promise.resolve(scripted.response);
		});
	global.fetch = fetchMock as unknown as typeof fetch;

	return { windows, streamBodies, fetchMock };
}

describe("useOrchestratorStream.stop()", () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		emitCancelEventMock.mockClear();
	});
	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("posts to the orchestrator-temporal cancel route on stop", async () => {
		const { response, enqueueLine, enqueueDone } = makeSseResponse();
		const fetchSpy = vi
			.spyOn(global, "fetch")
			.mockImplementation(((..._args: unknown[]) =>
				Promise.resolve(response)) as unknown as typeof fetch);

		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("hello");
		});

		await act(async () => {
			enqueueLine('data: {"type":"started","executionId":"orch-aaaa"}');
		});
		await act(async () => {
			enqueueLine('data: {"type":"text_delta","content":"streaming"}');
		});

		await waitFor(() => {
			const m =
				result.current.messages[result.current.messages.length - 1];
			expect(m?.content).toContain("streaming");
		});

		act(() => {
			result.current.stop("button");
		});

		const last =
			result.current.messages[result.current.messages.length - 1];
		expect(last?.streamStatus).toBe("cancelled");
		expect(last?.cancelledAt).toBeTruthy();
		expect(result.current.state.status).toBe("cancelled");
		expect(result.current.isLoading).toBe(false);

		expect(fetchSpy).toHaveBeenCalledWith(
			"/api/agents/fabric-ai/orchestrator-temporal/cancel",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ executionId: "orch-aaaa" }),
			}),
		);

		expect(emitCancelEventMock).toHaveBeenCalledWith(
			expect.objectContaining({
				surface: "loom-orchestrator",
				agentId: null,
				executionId: "orch-aaaa",
				triggered_by: "button",
			}),
		);

		await act(async () => {
			enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	});

	it("works while pendingApproval is set (AC-9)", async () => {
		const { response, enqueueLine, enqueueDone } = makeSseResponse();
		vi.spyOn(global, "fetch").mockImplementation(((..._args: unknown[]) =>
			Promise.resolve(response)) as unknown as typeof fetch);

		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("propose a step");
		});

		await act(async () => {
			enqueueLine('data: {"type":"started","executionId":"orch-bbbb"}');
		});
		await act(async () => {
			enqueueLine(
				'data: {"type":"approval_required","approvalId":"ap-1","stepId":"s1","reason":"high risk"}',
			);
		});

		await waitFor(() => {
			expect(result.current.state.pendingApproval).toEqual({
				approvalId: "ap-1",
				stepId: "s1",
				reason: "high risk",
			});
		});

		act(() => {
			result.current.stop("button");
		});

		// Pending approval is implicitly rejected by the workflow
		// cancel; the hook clears it from state immediately.
		expect(result.current.state.pendingApproval).toBeNull();
		expect(result.current.state.status).toBe("cancelled");

		await act(async () => {
			enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	});

	it("surfaces an up-front clarifying question and answers it via /clarify", async () => {
		const { response, enqueueLine, enqueueDone } = makeSseResponse();
		const fetchSpy = vi.spyOn(global, "fetch").mockImplementation(((
			input: unknown,
		) => {
			const url =
				typeof input === "string" ? input : (input as Request).url;
			// The /clarify signal POST returns a small JSON ack; every
			// other call (the /stream POST) returns the SSE body.
			if (url.includes("/clarify")) {
				return Promise.resolve({
					ok: true,
					json: async () => ({ success: true }),
				} as Response);
			}
			return Promise.resolve(response);
		}) as unknown as typeof fetch);

		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("deploy it");
		});

		await act(async () => {
			enqueueLine('data: {"type":"started","executionId":"orch-cccc"}');
		});

		// Regression guard: the /stream POST must carry `surface` or the
		// orchestrator workflow can't scope the up-front clarification to the
		// Loom chat (it sees `surface: undefined` and never asks).
		expect(fetchSpy).toHaveBeenCalledWith(
			"/api/agents/fabric-ai/orchestrator-temporal/stream",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"surface":"loom-orchestrator"'),
			}),
		);

		await act(async () => {
			enqueueLine(
				'data: {"type":"clarifying_question","clarificationId":"clarify-upfront-orch-cccc","question":"Which environment?","options":["staging","production"]}',
			);
		});

		await waitFor(() => {
			expect(result.current.state.pendingClarification).toEqual({
				clarificationId: "clarify-upfront-orch-cccc",
				stepId: undefined,
				question: "Which environment?",
				options: ["staging", "production"],
			});
		});

		// Answering signals the workflow via the /clarify route and optimistically
		// clears the pending question.
		await act(async () => {
			await result.current.sendClarification("staging");
		});

		expect(fetchSpy).toHaveBeenCalledWith(
			"/api/agents/fabric-ai/orchestrator-temporal/clarify",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					executionId: "orch-cccc",
					answer: "staging",
					dismissed: false,
				}),
			}),
		);
		expect(result.current.state.pendingClarification).toBeNull();

		// A trailing clarifying_resolved event is also handled idempotently.
		await act(async () => {
			enqueueLine(
				'data: {"type":"clarifying_resolved","clarificationId":"clarify-upfront-orch-cccc"}',
			);
		});
		expect(result.current.state.pendingClarification).toBeNull();

		// A terminal event is what ends the turn now: a stream that just
		// closes is read as a dropped connection and triggers a reconnect
		// (issue #2269). This test is about the clarify round trip, so let
		// the run finish normally.
		await act(async () => {
			enqueueLine(
				'data: {"type":"completed","response":"staging it is"}',
			);
		});
		await act(async () => {
			enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	});

	it("drops trailing SSE deltas after stop (freeze gate)", async () => {
		const { response, enqueueLine, enqueueDone } = makeSseResponse();
		vi.spyOn(global, "fetch").mockImplementation(((..._args: unknown[]) =>
			Promise.resolve(response)) as unknown as typeof fetch);

		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("hi");
		});

		await act(async () => {
			enqueueLine('data: {"type":"started","executionId":"orch-cccc"}');
		});
		await act(async () => {
			enqueueLine('data: {"type":"text_delta","content":"before "}');
		});

		await waitFor(() => {
			const m =
				result.current.messages[result.current.messages.length - 1];
			expect(m?.content).toContain("before");
		});

		const partialBefore =
			result.current.messages[result.current.messages.length - 1]
				?.content;

		act(() => {
			result.current.stop("button");
		});

		// Server keeps streaming.
		await act(async () => {
			enqueueLine('data: {"type":"text_delta","content":"after-stop"}');
		});
		await act(async () => {
			enqueueLine('data: {"type":"completed","response":"final"}');
		});
		await act(async () => {
			enqueueDone();
		});

		const last =
			result.current.messages[result.current.messages.length - 1];
		expect(last?.content).toBe(partialBefore);
		expect(last?.streamStatus).toBe("cancelled");
		expect(result.current.state.status).toBe("cancelled");

		await act(async () => {
			await sendPromise;
		});
	});

	it("drops trailing non-AbortError thrown after stop (cancel gate)", async () => {
		// Regression for H1: a non-`AbortError` thrown after the user
		// hits Stop (e.g. `TypeError` from a chunked-transfer hiccup)
		// must NOT overwrite the cancelled assistant body or flip state
		// to `failed`. The catch block reads `cancelledMessageIdsRef`
		// and short-circuits before any state mutation.
		const encoder = new TextEncoder();
		const queue: Array<{ value?: Uint8Array; done?: boolean }> = [];
		let resolveNext: (() => void) | null = null;
		let pendingError: Error | null = null;
		let rejectActive: ((err: Error) => void) | null = null;

		const read = () =>
			new Promise<{ value?: Uint8Array; done?: boolean }>(
				(resolve, reject) => {
					if (pendingError) {
						const err = pendingError;
						pendingError = null;
						reject(err);
						return;
					}
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
					rejectActive = reject;
					resolveNext = () => {
						rejectActive = null;
						if (drain()) {
							return;
						}
					};
				},
			);

		const enqueueLine = (line: string) => {
			queue.push({ value: encoder.encode(`${line}\n`) });
			const r = resolveNext;
			resolveNext = null;
			r?.();
		};

		const triggerError = (err: Error) => {
			// If a `read()` is already pending, reject it directly;
			// otherwise stash the error for the next read() invocation.
			if (rejectActive) {
				const r = rejectActive;
				rejectActive = null;
				resolveNext = null;
				r(err);
			} else {
				pendingError = err;
			}
		};

		const response = {
			ok: true,
			body: { getReader: () => ({ read }) },
			json: async () => ({}),
		};

		vi.spyOn(global, "fetch").mockImplementation(((..._args: unknown[]) =>
			Promise.resolve(response)) as unknown as typeof fetch);

		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("hi");
		});

		// Deliver `started` so the assistant message has an
		// executionId and the optimistic flip can target it.
		await act(async () => {
			enqueueLine('data: {"type":"started","executionId":"orch-eeee"}');
		});
		await act(async () => {
			enqueueLine('data: {"type":"text_delta","content":"partial"}');
		});

		await waitFor(() => {
			expect(result.current.state.executionId).toBe("orch-eeee");
		});

		act(() => {
			result.current.stop("button");
		});

		// Snapshot the cancelled assistant body — the post-stop
		// TypeError must not modify it.
		const lastBefore =
			result.current.messages[result.current.messages.length - 1];
		expect(lastBefore?.streamStatus).toBe("cancelled");
		const contentBefore = lastBefore?.content;

		// Simulate a chunked-transfer hiccup: the next read rejects
		// with a non-AbortError after the user has cancelled. (The
		// `abort()` from `stop()` may already have rejected the
		// in-flight read with an AbortError; we still want to assert
		// the gate handles a *non*-Abort error if one races in.)
		await act(async () => {
			triggerError(new TypeError("network read failed"));
			// Yield twice so the catch block runs and any state
			// updates flush.
			await Promise.resolve();
			await Promise.resolve();
		});

		const lastAfter =
			result.current.messages[result.current.messages.length - 1];
		expect(lastAfter?.streamStatus).toBe("cancelled");
		expect(lastAfter?.content).toBe(contentBefore);
		// Crucially, state did NOT flip to "failed".
		expect(result.current.state.status).toBe("cancelled");
		expect(result.current.isLoading).toBe(false);

		await act(async () => {
			await sendPromise;
		});
	});

	it("invokes onStopFailed on cancel-endpoint 500 without reverting state", async () => {
		const { response, enqueueLine, enqueueDone } = makeSseResponse();
		const onStopFailed = vi.fn();
		const fetchImpl = vi
			.fn()
			.mockImplementationOnce(() => Promise.resolve(response))
			.mockImplementationOnce(() =>
				Promise.resolve({ ok: false, status: 500 } as Response),
			);
		global.fetch = fetchImpl as unknown as typeof fetch;

		const { result } = renderHook(() =>
			useOrchestratorStream({ onStopFailed }),
		);

		let sendPromise: Promise<string | null> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("hi");
		});

		await act(async () => {
			enqueueLine('data: {"type":"started","executionId":"orch-dddd"}');
		});

		await waitFor(() => {
			expect(result.current.state.executionId).toBe("orch-dddd");
		});

		act(() => {
			result.current.stop("button");
		});

		await waitFor(() => {
			expect(onStopFailed).toHaveBeenCalledTimes(1);
		});

		// State did NOT revert.
		expect(result.current.state.status).toBe("cancelled");
		expect(result.current.isLoading).toBe(false);
		const last =
			result.current.messages[result.current.messages.length - 1];
		expect(last?.streamStatus).toBe("cancelled");

		await act(async () => {
			enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	});
});

describe("useOrchestratorStream — resumable streaming windows (#2269)", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("reconnects with the executionId after stream_timeout and keeps streaming into the same message", async () => {
		const { windows, streamBodies } = mockStreamWindows(2);
		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null | undefined> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("long running task");
		});

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"started","executionId":"orch-1111"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"text_delta","content":"first window"}',
			);
		});

		const assistantId =
			result.current.messages[result.current.messages.length - 1]?.id;

		// Server's budget ran out; the workflow is still running.
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"stream_timeout","executionId":"orch-1111","message":"Streaming window closed; reconnect with this executionId to continue"}',
			);
		});
		await act(async () => {
			windows[0].enqueueDone();
		});

		// The reconnect POST carries the executionId and nothing that would
		// start a second run.
		expect(streamBodies).toHaveLength(2);
		expect(streamBodies[1]).toContain('"executionId":"orch-1111"');
		expect(streamBodies[1]).not.toContain('"message"');
		// The gap must not close the PartyKit socket, which is gated on
		// `isLoading && status === "running"`.
		expect(result.current.isLoading).toBe(true);
		expect(result.current.state.status).toBe("running");

		// The replayed run continues into the same assistant message.
		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"started","executionId":"orch-1111","resumed":true}',
			);
		});
		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"completed","response":"all done","status":"completed"}',
			);
		});

		expect(result.current.messages).toHaveLength(2);
		const last = result.current.messages[1];
		expect(last?.id).toBe(assistantId);
		expect(last?.content).toBe("all done");
		expect(result.current.state.status).toBe("completed");
		expect(result.current.isLoading).toBe(false);

		await act(async () => {
			windows[1].enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	});

	it("counts a replayed step_complete once and does not duplicate its step result", async () => {
		const { windows } = mockStreamWindows(2);
		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null | undefined> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("two step task");
		});

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"started","executionId":"orch-2222"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"step_complete","stepId":"s1","stepDescription":"first","status":"complete","response":"one","toolCalls":[],"durationMs":10}',
			);
		});

		expect(result.current.completedSteps).toBe(1);
		expect(result.current.stepResults).toHaveLength(1);

		await act(async () => {
			windows[0].enqueueLine('data: {"type":"stream_timeout"}');
		});
		await act(async () => {
			windows[0].enqueueDone();
		});

		// The server replays every completed step into the new window.
		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"started","executionId":"orch-2222","resumed":true}',
			);
		});
		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"step_complete","stepId":"s1","stepDescription":"first","status":"complete","response":"one","toolCalls":[],"durationMs":10}',
			);
		});

		expect(result.current.stepResults).toHaveLength(1);
		expect(result.current.completedSteps).toBe(1);

		// A genuinely new step still advances the counter.
		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"step_complete","stepId":"s2","stepDescription":"second","status":"complete","response":"two","toolCalls":[],"durationMs":20}',
			);
		});

		expect(result.current.stepResults).toHaveLength(2);
		expect(result.current.completedSteps).toBe(2);

		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"completed","response":"finished","status":"completed"}',
			);
		});
		await act(async () => {
			windows[1].enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	});

	it("keeps the streamed body across a resumed started and replaces it on the first post-resume delta", async () => {
		// CONTRACT CHANGE (post-merge review, P2): this test previously
		// asserted the resumed `started` cleared the body immediately. That
		// destroyed the only copy of the prior window's output, so a resumed
		// connection dying right after the handshake — the very failure the
		// retry loop exists for — left the exhaustion path freezing an empty
		// message. The clear is now deferred to the first replacement, which
		// still prevents the splice-across-the-gap that motivated it.
		const { windows } = mockStreamWindows(2);
		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null | undefined> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("write something long");
		});

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"started","executionId":"orch-3333"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"text_delta","content":"half a senten"}',
			);
		});

		expect(result.current.messages[1]?.content).toBe("half a senten");

		await act(async () => {
			windows[0].enqueueLine('data: {"type":"stream_timeout"}');
		});
		await act(async () => {
			windows[0].enqueueDone();
		});

		// The handshake alone must not destroy anything.
		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"started","executionId":"orch-3333","resumed":true}',
			);
		});

		expect(result.current.messages[1]?.content).toBe("half a senten");

		// The first post-resume delta REPLACES the body rather than appending
		// to it — Redis pub/sub never replays the dropped deltas, so an append
		// would splice two halves across a silent hole.
		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"text_delta","content":"half a sentence, whole again"}',
			);
		});

		expect(result.current.messages[1]?.content).toBe(
			"half a sentence, whole again",
		);

		// And the final response still replaces wholesale.
		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"completed","response":"half a sentence, whole again.","status":"completed"}',
			);
		});

		expect(result.current.messages[1]?.content).toBe(
			"half a sentence, whole again.",
		);

		await act(async () => {
			windows[1].enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	});

	it("does not reconnect when the user stops during the reconnect gap", async () => {
		// Only one window is scripted: a second stream POST would throw.
		const { windows, streamBodies } = mockStreamWindows(1);
		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null | undefined> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("hi");
		});

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"started","executionId":"orch-4444"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"text_delta","content":"partial"}',
			);
		});

		// Unclean close (no terminal event, no stream_timeout): the client
		// parks in the pre-reconnect delay.
		await act(async () => {
			windows[0].enqueueDone();
		});

		act(() => {
			result.current.stop("button");
		});
		await act(async () => {
			await Promise.resolve();
		});

		// The abort resolves the delay early and the resume is abandoned.
		expect(streamBodies).toHaveLength(1);
		expect(result.current.state.status).toBe("cancelled");
		expect(result.current.isLoading).toBe(false);
		const last = result.current.messages[1];
		expect(last?.streamStatus).toBe("cancelled");
		expect(last?.content).toBe("partial");

		await act(async () => {
			await sendPromise;
		});
	});

	it("fails the turn after the timeout-resume cap without overwriting streamed content", async () => {
		// Initial window + MAX_TIMEOUT_RESUMES (5) reconnects = 6 windows,
		// each ending in stream_timeout. The 6th exhausts the budget.
		const { windows, streamBodies } = mockStreamWindows(6);
		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null | undefined> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("a very long task");
		});

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"started","executionId":"orch-5555"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"step_complete","stepId":"s1","stepDescription":"first","status":"complete","response":"one","toolCalls":[],"durationMs":10}',
			);
		});

		for (let i = 0; i < 6; i++) {
			if (i > 0) {
				// Every reconnect replays the run so far.
				await act(async () => {
					windows[i].enqueueLine(
						'data: {"type":"started","executionId":"orch-5555","resumed":true}',
					);
				});
				await act(async () => {
					windows[i].enqueueLine(
						'data: {"type":"step_complete","stepId":"s1","stepDescription":"first","status":"complete","response":"one","toolCalls":[],"durationMs":10}',
					);
				});
				await act(async () => {
					windows[i].enqueueLine(
						'data: {"type":"text_delta","content":"still working"}',
					);
				});
			}
			await act(async () => {
				windows[i].enqueueLine('data: {"type":"stream_timeout"}');
			});
			await act(async () => {
				windows[i].enqueueDone();
			});
		}

		// Six POSTs total — the 6th stream_timeout found the budget spent.
		expect(streamBodies).toHaveLength(6);
		expect(result.current.state.status).toBe("failed");
		expect(result.current.state.result?.error).toMatch(
			/could not be resumed/i,
		);
		expect(result.current.isLoading).toBe(false);

		// Crucially, the streamed body and the step transcript survive — the
		// `error` event path would have replaced the content with "Error: …".
		const last = result.current.messages[1];
		expect(last?.content).toBe("still working");
		expect(last?.content).not.toMatch(/^Error:/);
		expect(last?.isStreaming).toBe(false);
		expect(last?.streamStatus).toBe("error");
		expect(result.current.stepResults).toHaveLength(1);

		await act(async () => {
			await sendPromise;
		});
	});

	it("retries a reconnect POST that fails before opening a stream, keeping what earlier windows streamed", async () => {
		vi.useFakeTimers();

		// Window 0 hands off with stream_timeout; the reconnect POST then 502s
		// (the likeliest real failure — it lands right after a function kill).
		// That attempt never opens a stream, so it must take the unclean-close
		// budget rather than escaping to the outer catch, which would replace
		// the assistant body with "Error: ...".
		const { windows, streamBodies } = mockStreamWindows(
			2,
			new Map<number, "reject" | "http">([[1, "http"]]),
		);
		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null | undefined> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("a long task");
		});

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"started","executionId":"orch-8888"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"text_delta","content":"kept text"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine('data: {"type":"stream_timeout"}');
		});
		await act(async () => {
			windows[0].enqueueDone();
		});

		// Two POSTs so far: the initial one and the 502'd reconnect. The turn
		// is parked in the retry delay, NOT failed, and the body is intact.
		expect(streamBodies).toHaveLength(2);
		expect(result.current.state.status).toBe("running");
		expect(result.current.isLoading).toBe(true);
		expect(result.current.messages[1]?.content).toBe("kept text");
		expect(result.current.messages[1]?.content).not.toMatch(/^Error:/);

		// The retry after the delay reaches a healthy window.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
		expect(streamBodies).toHaveLength(3);
		expect(streamBodies[2]).toContain('"executionId":"orch-8888"');

		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"completed","response":"finished after the retry","status":"completed"}',
			);
		});

		expect(result.current.messages[1]?.content).toBe(
			"finished after the retry",
		);
		expect(result.current.state.status).toBe("completed");

		await act(async () => {
			windows[1].enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	});

	it("gives up non-destructively when every reconnect POST keeps failing", async () => {
		vi.useFakeTimers();

		// Attempts 1-4 all reject: three take the unclean budget, the fourth
		// finds it spent. Only the initial window is ever scripted.
		const { windows, streamBodies } = mockStreamWindows(
			1,
			new Map<number, "reject" | "http">([
				[1, "reject"],
				[2, "reject"],
				[3, "reject"],
				[4, "reject"],
			]),
		);
		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null | undefined> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("a long task");
		});

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"started","executionId":"orch-9999"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"text_delta","content":"kept text"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine('data: {"type":"stream_timeout"}');
		});
		await act(async () => {
			windows[0].enqueueDone();
		});

		// Drain the three retry delays.
		for (let i = 0; i < 3; i++) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
			});
		}

		// Initial window + 4 failed reconnects.
		expect(streamBodies).toHaveLength(5);
		expect(result.current.state.status).toBe("failed");
		expect(result.current.state.result?.error).toMatch(
			/could not be resumed/i,
		);
		expect(result.current.isLoading).toBe(false);

		// The non-destructive exit: content preserved, not an "Error:" stub.
		const last = result.current.messages[1];
		expect(last?.content).toBe("kept text");
		expect(last?.content).not.toMatch(/^Error:/);
		expect(last?.isStreaming).toBe(false);
		expect(last?.streamStatus).toBe("error");

		await act(async () => {
			await sendPromise;
		});
	});

	it("does not splice a separator into a continuous run after a resumed replacement", async () => {
		// Post-merge review: `shouldReplace` consumed the defer-clear flag but
		// left `needsTextSeparatorRef` set, because the code that clears it sits
		// behind `!shouldReplace`. A replayed tool_start on a resumed window
		// therefore armed a separator that the SECOND delta of the same
		// continuous run spliced in — "hel" + "lo" rendering as "hel\n\nlo".
		const { windows } = mockStreamWindows(2);
		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null | undefined> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("say hello");
		});

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"started","executionId":"orch-bbb1"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine('data: {"type":"stream_timeout"}');
		});
		await act(async () => {
			windows[0].enqueueDone();
		});

		// Resumed window: handshake arms the deferred replacement, then a
		// replayed tool_start arms the separator.
		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"started","executionId":"orch-bbb1","resumed":true}',
			);
		});
		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"tool_start","toolCallId":"tc-1","toolName":"search_docs","args":{}}',
			);
		});

		// Two deltas of ONE continuous run.
		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"text_delta","content":"hel"}',
			);
		});
		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"text_delta","content":"lo"}',
			);
		});

		expect(result.current.messages[1]?.content).toBe("hello");
		expect(result.current.messages[1]?.content).not.toContain("\n\n");

		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"completed","response":"hello","status":"completed"}',
			);
		});
		await act(async () => {
			windows[1].enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	});

	it("does not splice a separator after a text_start replacement either", async () => {
		// The same stale flag on the pre-existing non-resume path: a new
		// iteration's `text_start` arms the replacement, a tool event before the
		// first delta arms the separator, and the second delta splices it.
		const { windows } = mockStreamWindows(1);
		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null | undefined> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("say hello");
		});

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"started","executionId":"orch-bbb2"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"text_delta","content":"previous iteration"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine('data: {"type":"text_start","iteration":2}');
		});
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"tool_start","toolCallId":"tc-2","toolName":"search_docs","args":{}}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"text_delta","content":"hel"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"text_delta","content":"lo"}',
			);
		});

		expect(result.current.messages[1]?.content).toBe("hello");
		expect(result.current.messages[1]?.content).not.toContain("\n\n");

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"completed","response":"hello","status":"completed"}',
			);
		});
		await act(async () => {
			windows[0].enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	});

	it("terminates a handshake-then-drop loop instead of reconnecting forever", async () => {
		vi.useFakeTimers();

		// Post-merge review P1: the server re-emits `started` on every resume
		// before it polls, so a transport that opens just long enough for the
		// handshake and then drops used to refill the unclean budget every
		// cycle and POST every 2s forever with the UI stuck loading. Control
		// events no longer count as progress, so the 3-consecutive cap binds:
		// initial window + 3 unclean resumes = 4 POSTs, then it gives up.
		const { windows, streamBodies } = mockStreamWindows(4);
		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null | undefined> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("a long task");
		});

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"started","executionId":"orch-aaa1"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"text_delta","content":"kept text"}',
			);
		});
		await act(async () => {
			windows[0].enqueueDone();
		});

		// Every later window delivers only the handshake, then drops.
		for (let i = 1; i < 4; i++) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
			});
			await act(async () => {
				windows[i].enqueueLine(
					'data: {"type":"started","executionId":"orch-aaa1","resumed":true}',
				);
			});
			await act(async () => {
				windows[i].enqueueDone();
			});
		}

		expect(streamBodies).toHaveLength(4);
		expect(result.current.state.status).toBe("failed");
		expect(result.current.state.result?.error).toMatch(
			/could not be resumed/i,
		);
		expect(result.current.isLoading).toBe(false);
		// The handshakes never destroyed the first window's output (P2).
		expect(result.current.messages[1]?.content).toBe("kept text");

		await act(async () => {
			await sendPromise;
		});
	});

	it("stops at the total-attempt cap when replayed progress keeps refilling the consecutive budget", async () => {
		vi.useFakeTimers();

		// Post-merge review P1, layer 2: a replayed `step_complete` IS real
		// progress by the consecutive counter's rule, so a window that replays
		// the same step every cycle resets that counter forever. Only the total
		// cap bounds this: initial window + MAX_TOTAL_RESUMES (12) = 13 POSTs.
		const TOTAL_POSTS = 13;
		const { windows, streamBodies } = mockStreamWindows(TOTAL_POSTS);
		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null | undefined> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("a long task");
		});

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"started","executionId":"orch-aaa2"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"text_delta","content":"kept text"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"step_complete","stepId":"s1","stepDescription":"first","status":"complete","response":"one","toolCalls":[],"durationMs":10}',
			);
		});
		await act(async () => {
			windows[0].enqueueDone();
		});

		for (let i = 1; i < TOTAL_POSTS; i++) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
			});
			await act(async () => {
				windows[i].enqueueLine(
					'data: {"type":"started","executionId":"orch-aaa2","resumed":true}',
				);
			});
			// The same step replayed — enough to reset the consecutive counter.
			await act(async () => {
				windows[i].enqueueLine(
					'data: {"type":"step_complete","stepId":"s1","stepDescription":"first","status":"complete","response":"one","toolCalls":[],"durationMs":10}',
				);
			});
			await act(async () => {
				windows[i].enqueueDone();
			});
		}

		expect(streamBodies).toHaveLength(TOTAL_POSTS);
		expect(result.current.state.status).toBe("failed");
		expect(result.current.state.result?.error).toMatch(
			/could not be resumed/i,
		);
		expect(result.current.isLoading).toBe(false);
		expect(result.current.messages[1]?.content).toBe("kept text");
		// The replay was still deduped throughout.
		expect(result.current.stepResults).toHaveLength(1);
		expect(result.current.completedSteps).toBe(1);

		await act(async () => {
			await sendPromise;
		});
	});

	it("freezes the prior window's text when a resumed stream dies right after the handshake", async () => {
		vi.useFakeTimers();

		// Post-merge review P2, the regression this guards: window 0 streams
		// text and hands off; the resumed window delivers only `started` and
		// dies; every remaining attempt fails. With the old immediate clear the
		// frozen message was EMPTY — the handshake had already destroyed the
		// only copy of the prior window's output.
		const { windows, streamBodies } = mockStreamWindows(
			2,
			new Map<number, "reject" | "http">([
				[2, "reject"],
				[3, "reject"],
				[4, "reject"],
			]),
		);
		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null | undefined> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("write something long");
		});

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"started","executionId":"orch-aaa3"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"text_delta","content":"first window text"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine('data: {"type":"stream_timeout"}');
		});
		// Timeout handoff reconnects immediately, no delay.
		await act(async () => {
			windows[0].enqueueDone();
		});

		// The resumed window gets as far as the handshake, then dies.
		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"started","executionId":"orch-aaa3","resumed":true}',
			);
		});
		await act(async () => {
			windows[1].enqueueDone();
		});

		// Three further attempts, all failing before a stream opens.
		for (let i = 0; i < 3; i++) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
			});
		}

		expect(streamBodies).toHaveLength(5);
		expect(result.current.state.status).toBe("failed");
		expect(result.current.isLoading).toBe(false);

		// The assertion that fails on the pre-fix code: content, not "".
		const last = result.current.messages[1];
		expect(last?.content).toBe("first window text");
		expect(last?.content).not.toBe("");
		expect(last?.streamStatus).toBe("error");

		await act(async () => {
			await sendPromise;
		});
	});

	it("resets the unclean-close budget on delivered events but spends it when nothing arrives", async () => {
		vi.useFakeTimers();

		// Four windows deliver an event before closing uncleanly. Without the
		// reset the fourth close would find the 3-resume budget spent and
		// fail the turn; with it, a fifth window is still reached.
		const { windows, streamBodies } = mockStreamWindows(5);
		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null | undefined> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("flaky connection");
		});

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"started","executionId":"orch-6666"}',
			);
		});

		for (let i = 0; i < 4; i++) {
			if (i > 0) {
				await act(async () => {
					windows[i].enqueueLine(
						`data: {"type":"progress","completedSteps":${i},"totalSteps":9,"message":"working"}`,
					);
				});
			}
			await act(async () => {
				windows[i].enqueueDone();
			});
			// Unclean closes wait before reconnecting.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
			});
		}

		// Four unclean cycles, each carrying one event: still going.
		expect(streamBodies).toHaveLength(5);
		expect(result.current.state.status).toBe("running");
		expect(result.current.isLoading).toBe(true);

		await act(async () => {
			windows[4].enqueueLine(
				'data: {"type":"completed","response":"survived the flapping","status":"completed"}',
			);
		});

		expect(result.current.messages[1]?.content).toBe(
			"survived the flapping",
		);
		expect(result.current.state.status).toBe("completed");

		await act(async () => {
			windows[4].enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	});

	it("gives up after MAX_UNCLEAN_RESUMES closes that deliver nothing", async () => {
		vi.useFakeTimers();

		// Initial window + 3 reconnects; the 4th close has no budget left.
		const { windows, streamBodies } = mockStreamWindows(4);
		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null | undefined> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("dead connection");
		});

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"started","executionId":"orch-7777"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"text_delta","content":"only text"}',
			);
		});

		for (let i = 0; i < 4; i++) {
			await act(async () => {
				windows[i].enqueueDone();
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(2000);
			});
		}

		expect(streamBodies).toHaveLength(4);
		expect(result.current.state.status).toBe("failed");
		expect(result.current.state.result?.error).toMatch(
			/could not be resumed/i,
		);
		expect(result.current.isLoading).toBe(false);
		expect(result.current.messages[1]?.content).toBe("only text");

		await act(async () => {
			await sendPromise;
		});
	});
});

/**
 * The Orchestrator's model picker (#2040).
 *
 * The whole server-side chain already accepted `modelOverride` — the route
 * destructures it, the workflow input declares it, and the orchestrator's own
 * reasoning and synthesis calls thread it into the model selector. Only the
 * client never sent it, so these assert the edge that was missing.
 *
 * The reconnect case is the one worth pinning: a resume re-attaches to the
 * running workflow by `executionId`, which still holds its original input.
 * Resending would be redundant — but a reconnect silently reverting to the
 * default model is precisely the class of half-wired lever that #2756 was.
 */
describe("useOrchestratorStream — model override (#2040)", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("sends the picked model on the initial POST", async () => {
		const { windows, streamBodies } = mockStreamWindows(1);
		const { result } = renderHook(() =>
			useOrchestratorStream({
				modelOverride: "anthropic/claude-sonnet-4.6",
			}),
		);

		let sendPromise: Promise<string | null | undefined> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("plan this");
		});

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"started","executionId":"orch-3333"}',
			);
		});

		expect(streamBodies).toHaveLength(1);
		expect(JSON.parse(streamBodies[0] as string).modelOverride).toBe(
			"anthropic/claude-sonnet-4.6",
		);

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"completed","response":"done","status":"completed"}',
			);
		});
		await act(async () => {
			windows[0].enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	});

	it("omits it when nothing is picked, leaving the workspace default to resolve", async () => {
		const { windows, streamBodies } = mockStreamWindows(1);
		const { result } = renderHook(() => useOrchestratorStream());

		let sendPromise: Promise<string | null | undefined> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("plan this");
		});

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"started","executionId":"orch-4444"}',
			);
		});

		expect(
			JSON.parse(streamBodies[0] as string).modelOverride,
		).toBeUndefined();

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"completed","response":"done","status":"completed"}',
			);
		});
		await act(async () => {
			windows[0].enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	});

	it("does not resend it on a reconnect — the running workflow still holds it", async () => {
		const { windows, streamBodies } = mockStreamWindows(2);
		const { result } = renderHook(() =>
			useOrchestratorStream({
				modelOverride: "anthropic/claude-sonnet-4.6",
			}),
		);

		let sendPromise: Promise<string | null | undefined> | undefined;
		act(() => {
			sendPromise = result.current.sendMessage("long running task");
		});

		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"started","executionId":"orch-5555"}',
			);
		});
		await act(async () => {
			windows[0].enqueueLine(
				'data: {"type":"stream_timeout","executionId":"orch-5555","message":"Streaming window closed; reconnect with this executionId to continue"}',
			);
		});
		await act(async () => {
			windows[0].enqueueDone();
		});

		expect(streamBodies).toHaveLength(2);
		expect(JSON.parse(streamBodies[0] as string).modelOverride).toBe(
			"anthropic/claude-sonnet-4.6",
		);
		expect(
			JSON.parse(streamBodies[1] as string).modelOverride,
		).toBeUndefined();

		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"started","executionId":"orch-5555","resumed":true}',
			);
		});
		await act(async () => {
			windows[1].enqueueLine(
				'data: {"type":"completed","response":"all done","status":"completed"}',
			);
		});
		await act(async () => {
			windows[1].enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	});
});
