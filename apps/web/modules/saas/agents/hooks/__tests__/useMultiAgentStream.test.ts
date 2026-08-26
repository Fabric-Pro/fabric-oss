/**
 * Unit tests for `useMultiAgentStream.stopAll()` semantics.
 *
 * Spec: `specs/2026-05-09-stop-ai-generation/spec.md` section 8.4 +
 * decisions 12 / 18 (Honest record). Covers Task 2.7 acceptance
 * criteria from `specs/2026-05-09-stop-ai-generation/tasks.md`:
 *
 *  - `stopAll()` aborts only in-flight controllers.
 *  - Already-`completed` agents stay `completed` (decision 18 / AC-6).
 *  - Cancelled agents flip to `"cancelled"` with `cancelledAt`.
 *  - Subsequent SSE deltas for cancelled agents are dropped.
 *  - Race test: an agent that flips to `"completed"` between the
 *    click and the `stopAll()` iteration stays `"completed"`.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/cancel-telemetry", () => ({
	emitCancelEvent: vi.fn(),
}));

import { emitCancelEvent } from "../../lib/cancel-telemetry";
import { useMultiAgentStream } from "../useMultiAgentStream";

const emitCancelEventMock = vi.mocked(emitCancelEvent);

interface Sse {
	response: {
		ok: boolean;
		body: { getReader: () => { read: () => Promise<unknown> } };
		json: () => Promise<unknown>;
	};
	enqueueLine: (line: string) => void;
	enqueueDone: () => void;
}

function makeSseResponse(): Sse {
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

	return {
		response: {
			ok: true,
			body: { getReader: () => ({ read }) },
			json: async () => ({}),
		},
		enqueueLine,
		enqueueDone,
	};
}

/**
 * Parse a request body that the hook would serialize. The hook fires
 * fetch with `JSON.stringify({ executionId })` for the cancel POST; we
 * only inspect that for assertion purposes.
 */
function parseBody(init: unknown): Record<string, unknown> {
	const body = (init as { body?: string } | undefined)?.body;
	if (!body) {
		return {};
	}
	try {
		return JSON.parse(body);
	} catch {
		return {};
	}
}

describe("useMultiAgentStream.stopAll()", () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		emitCancelEventMock.mockClear();
	});
	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("flips only in-flight agents to cancelled and leaves completed agents alone", async () => {
		// Two agents: A streaming, B completes before stopAll.
		const sseA = makeSseResponse();
		const sseB = makeSseResponse();
		const fetchSpy = vi
			.fn()
			// First two fetches are the parallel SSE streams.
			.mockImplementationOnce(() => Promise.resolve(sseA.response))
			.mockImplementationOnce(() => Promise.resolve(sseB.response))
			// Subsequent fetches are the cancel POSTs (one per cancelled
			// agent that has an executionId).
			.mockImplementation(() =>
				Promise.resolve({ ok: true, status: 200 } as Response),
			);
		global.fetch = fetchSpy as unknown as typeof fetch;

		const { result } = renderHook(() =>
			useMultiAgentStream({ organizationId: "org-1" }),
		);

		act(() => {
			result.current.sendToAgents(
				"draft a plan",
				[
					{ agentId: "agent-a", name: "Alpha" },
					{ agentId: "agent-b", name: "Beta" },
				],
				[],
			);
		});

		await waitFor(() => {
			expect(result.current.turns).toHaveLength(1);
		});

		// Both streams emit `started`.
		await act(async () => {
			sseA.enqueueLine(
				'data: {"type":"started","executionId":"orch-aaaa"}',
			);
			sseB.enqueueLine(
				'data: {"type":"started","executionId":"orch-bbbb"}',
			);
		});

		await act(async () => {
			sseA.enqueueLine('data: {"type":"text","content":"alpha "}');
		});

		// B completes BEFORE the user clicks Stop (decision 18 race).
		await act(async () => {
			sseB.enqueueLine(
				'data: {"type":"completed","response":"beta done"}',
			);
		});
		await act(async () => {
			sseB.enqueueDone();
		});

		await waitFor(() => {
			const turn = result.current.turns[0];
			const b = turn?.agentResponses.get("agent-b");
			expect(b?.status).toBe("completed");
		});

		// User clicks Stop.
		act(() => {
			result.current.stopAll("button");
		});

		const turn = result.current.turns[0];
		const a = turn?.agentResponses.get("agent-a");
		const b = turn?.agentResponses.get("agent-b");

		// A flipped to cancelled.
		expect(a?.status).toBe("cancelled");
		expect(a?.cancelledAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		expect(a?.isLoading).toBe(false);

		// B stays completed (honest record / decision 18 / AC-6).
		expect(b?.status).toBe("completed");
		expect(b?.cancelledAt).toBeUndefined();

		// Telemetry — exactly one event for the cancelled agent. The
		// completed agent does NOT get a telemetry event.
		expect(emitCancelEventMock).toHaveBeenCalledTimes(1);
		expect(emitCancelEventMock).toHaveBeenCalledWith(
			expect.objectContaining({
				surface: "nexus",
				agentId: "agent-a",
				executionId: "orch-aaaa",
				triggered_by: "button",
			}),
		);

		// Cancel POST fired against the orchestrator-temporal cancel
		// route for the cancelled agent only. Nexus's parallel-agent
		// SSE stream is backed by `orchestratorTemporalWorkflow`
		// (executionIds prefixed `orch-`), so the direct-chat cancel
		// route at `/api/agents/fabric-ai/stream/cancel` is the wrong
		// target — its regex rejects `orch-…` ids with a 400.
		const cancelCalls = fetchSpy.mock.calls.filter(
			(call) =>
				call[0] ===
				"/api/agents/fabric-ai/orchestrator-temporal/cancel",
		);
		expect(cancelCalls).toHaveLength(1);
		expect(parseBody(cancelCalls[0]?.[1])).toEqual({
			executionId: "orch-aaaa",
		});

		// Drain the still-open stream A.
		await act(async () => {
			sseA.enqueueDone();
		});
	});

	it("ends an agent's turn honestly on stream_timeout instead of reading as completed (#2269)", async () => {
		// The orchestrator route closes a long run's HTTP window with
		// `stream_timeout` rather than `error: "Execution timed out"`. Nexus
		// has no resume loop, so an unhandled event would fall through to the
		// end-of-stream cleanup and mark a truncated run "completed".
		const sse = makeSseResponse();
		const fetchSpy = vi
			.fn()
			.mockImplementationOnce(() => Promise.resolve(sse.response))
			.mockImplementation(() =>
				Promise.resolve({ ok: true, status: 200 } as Response),
			);
		global.fetch = fetchSpy as unknown as typeof fetch;

		const { result } = renderHook(() =>
			useMultiAgentStream({ organizationId: "org-1" }),
		);

		act(() => {
			result.current.sendToAgents(
				"a long task",
				[{ agentId: "agent-a", name: "Alpha" }],
				[],
			);
		});

		await waitFor(() => {
			expect(result.current.turns).toHaveLength(1);
		});

		await act(async () => {
			sse.enqueueLine(
				'data: {"type":"started","executionId":"orch-aaaa"}',
			);
		});
		await act(async () => {
			sse.enqueueLine('data: {"type":"text","content":"partial work"}');
		});
		await act(async () => {
			sse.enqueueLine(
				'data: {"type":"stream_timeout","executionId":"orch-aaaa"}',
			);
		});
		await act(async () => {
			sse.enqueueDone();
		});

		await waitFor(() => {
			const a = result.current.turns[0]?.agentResponses.get("agent-a");
			expect(a?.isLoading).toBe(false);
		});

		const a = result.current.turns[0]?.agentResponses.get("agent-a");
		expect(a?.status).toBe("error");
		// The text streamed before the window closed is kept.
		expect(a?.content).toContain("partial work");
	});

	it("drops trailing SSE deltas for cancelled agents (freeze gate)", async () => {
		const sseA = makeSseResponse();
		const fetchSpy = vi
			.fn()
			.mockImplementationOnce(() => Promise.resolve(sseA.response))
			.mockImplementation(() =>
				Promise.resolve({ ok: true, status: 200 } as Response),
			);
		global.fetch = fetchSpy as unknown as typeof fetch;

		const { result } = renderHook(() =>
			useMultiAgentStream({ organizationId: "org-1" }),
		);

		act(() => {
			result.current.sendToAgents(
				"hi",
				[{ agentId: "agent-a", name: "Alpha" }],
				[],
			);
		});

		await waitFor(() => expect(result.current.turns).toHaveLength(1));

		await act(async () => {
			sseA.enqueueLine(
				'data: {"type":"started","executionId":"orch-cccc"}',
			);
		});
		await act(async () => {
			sseA.enqueueLine('data: {"type":"text","content":"before "}');
		});

		// Wait for the buffered text to flush so we can snapshot it.
		await waitFor(() => {
			const turn = result.current.turns[0];
			const a = turn?.agentResponses.get("agent-a");
			expect(a?.content).toContain("before");
		});

		const partialBefore =
			result.current.turns[0]?.agentResponses.get("agent-a")?.content ??
			"";

		act(() => {
			result.current.stopAll("button");
		});

		await act(async () => {
			sseA.enqueueLine('data: {"type":"text","content":"after-stop"}');
			sseA.enqueueLine('data: {"type":"completed","response":"final"}');
			sseA.enqueueDone();
		});

		const a = result.current.turns[0]?.agentResponses.get("agent-a");
		expect(a?.status).toBe("cancelled");
		expect(a?.content).toBe(partialBefore);
	});

	it("invokes onStopFailed when the cancel POST returns non-2xx", async () => {
		const sseA = makeSseResponse();
		const onStopFailed = vi.fn();
		const fetchSpy = vi
			.fn()
			.mockImplementationOnce(() => Promise.resolve(sseA.response))
			.mockImplementation(() =>
				Promise.resolve({ ok: false, status: 500 } as Response),
			);
		global.fetch = fetchSpy as unknown as typeof fetch;

		const { result } = renderHook(() =>
			useMultiAgentStream({ organizationId: "org-1", onStopFailed }),
		);

		act(() => {
			result.current.sendToAgents(
				"hi",
				[{ agentId: "agent-a", name: "Alpha" }],
				[],
			);
		});

		await waitFor(() => expect(result.current.turns).toHaveLength(1));
		await act(async () => {
			sseA.enqueueLine(
				'data: {"type":"started","executionId":"orch-eeee"}',
			);
		});
		await waitFor(() => {
			const a = result.current.turns[0]?.agentResponses.get("agent-a");
			expect(a?.executionId).toBe("orch-eeee");
		});

		act(() => {
			result.current.stopAll("button");
		});

		await waitFor(() => {
			expect(onStopFailed).toHaveBeenCalled();
		});

		// State did NOT revert.
		const a = result.current.turns[0]?.agentResponses.get("agent-a");
		expect(a?.status).toBe("cancelled");

		await act(async () => {
			sseA.enqueueDone();
		});
	});

	it("is a no-op when no in-flight agents remain", async () => {
		const sseA = makeSseResponse();
		const fetchSpy = vi
			.fn()
			.mockImplementationOnce(() => Promise.resolve(sseA.response))
			.mockImplementation(() =>
				Promise.resolve({ ok: true, status: 200 } as Response),
			);
		global.fetch = fetchSpy as unknown as typeof fetch;

		const { result } = renderHook(() =>
			useMultiAgentStream({ organizationId: "org-1" }),
		);

		act(() => {
			result.current.sendToAgents(
				"hi",
				[{ agentId: "agent-a", name: "Alpha" }],
				[],
			);
		});

		await waitFor(() => expect(result.current.turns).toHaveLength(1));

		// Agent finishes before the click.
		await act(async () => {
			sseA.enqueueLine(
				'data: {"type":"started","executionId":"orch-ffff"}',
			);
			sseA.enqueueLine(
				'data: {"type":"completed","response":"all done"}',
			);
			sseA.enqueueDone();
		});
		await waitFor(() => {
			const a = result.current.turns[0]?.agentResponses.get("agent-a");
			expect(a?.status).toBe("completed");
		});

		emitCancelEventMock.mockClear();
		// Track the fetch call count BEFORE the click so we can assert
		// no additional cancel POST was sent.
		const callsBefore = fetchSpy.mock.calls.length;

		act(() => {
			result.current.stopAll("button");
		});

		// No telemetry, no cancel POST.
		expect(emitCancelEventMock).not.toHaveBeenCalled();
		expect(fetchSpy.mock.calls.length).toBe(callsBefore);
	});
});
