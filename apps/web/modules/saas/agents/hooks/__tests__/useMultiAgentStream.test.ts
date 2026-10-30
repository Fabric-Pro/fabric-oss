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
		queue.push({ value: encoder.encode(`${line}\n\n`) });
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
			body: {
				getReader: () => ({
					read,
					releaseLock: vi.fn(),
					cancel: vi.fn(async () => {}),
				}),
			},
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

	it("resumes a timed-out window with only the existing run identity and authorization scope", async () => {
		const sse = makeSseResponse();
		const resumed = makeSseResponse();
		const fetchSpy = vi
			.fn()
			.mockImplementationOnce(() => Promise.resolve(sse.response))
			.mockImplementationOnce(() => Promise.resolve(resumed.response));
		global.fetch = fetchSpy as unknown as typeof fetch;

		const { result } = renderHook(() =>
			useMultiAgentStream({ organizationId: "example-org" }),
		);

		act(() => {
			result.current.sendToAgents(
				"a long task",
				[{ agentId: "agent-a", name: "Alpha" }],
				[],
				{
					conversationId: "example-conversation",
					attachedDocumentIds: ["example-document"],
				},
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
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		});
		expect(parseBody(fetchSpy.mock.calls[1]?.[1])).toEqual({
			eventReplay: true,
			executionId: "orch-aaaa",
			organizationId: "example-org",
			conversationId: "example-conversation",
		});
		expect(
			result.current.turns[0]?.agentResponses.get("agent-a"),
		).toMatchObject({
			status: "streaming",
			isLoading: true,
			isError: false,
		});
		await act(async () => {
			resumed.enqueueLine(
				'data: {"type":"started","executionId":"orch-aaaa","resumed":true}',
			);
			resumed.enqueueLine(
				'data: {"type":"completed","response":"partial work finished"}',
			);
		});
		await waitFor(() => {
			expect(
				result.current.turns[0]?.agentResponses.get("agent-a")?.status,
			).toBe("completed");
		});

		const a = result.current.turns[0]?.agentResponses.get("agent-a");
		expect(a?.content).toBe("partial work finished");
		expect(a?.errorMessage).toBeUndefined();
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

describe("Research interrupted replies", () => {
	afterEach(() => vi.restoreAllMocks());
	it("saves acknowledged text and its cursor together and resumes without duplicating output", async () => {
		const first = makeSseResponse();
		const second = makeSseResponse();
		const fetch = vi
			.spyOn(global, "fetch")
			.mockResolvedValueOnce(first.response as unknown as Response)
			.mockResolvedValueOnce(second.response as unknown as Response);
		const cursor = (sequence: string) => ({
			turnId: "example-turn",
			runId: "example-run",
			sequence,
		});
		const { result } = renderHook(() =>
			useMultiAgentStream({ organizationId: "example-org" }),
		);
		act(() =>
			result.current.sendToAgents(
				"Example",
				[{ agentId: "example-agent", name: "Example" }],
				[],
			),
		);
		await act(async () => {
			first.enqueueLine(
				'data: {"type":"started","executionId":"orch-example"}',
			);
			first.enqueueLine(
				`data: ${JSON.stringify({ type: "text_delta", content: "First", eventCursor: cursor("1") })}`,
			);
		});
		expect(
			result.current.turns[0]?.agentResponses.get("example-agent"),
		).toMatchObject({ content: "First", eventCursor: cursor("1") });
		await act(async () => {
			first.enqueueLine('data: {"type":"stream_timeout"}');
		});
		expect(parseBody(fetch.mock.calls[1][1])).toMatchObject({
			executionId: "orch-example",
			afterEvent: cursor("1"),
			eventReplay: true,
		});
		await act(async () => {
			second.enqueueLine(
				'data: {"type":"started","executionId":"orch-example","resumed":true}',
			);
			second.enqueueLine(
				`data: ${JSON.stringify({ type: "text_delta", content: "First", eventCursor: cursor("1") })}`,
			);
			second.enqueueLine(
				`data: ${JSON.stringify({ type: "text_delta", content: " Second", eventCursor: cursor("2") })}`,
			);
			second.enqueueLine('data: {"type":"completed"}');
		});
		expect(
			result.current.turns[0]?.agentResponses.get("example-agent"),
		).toMatchObject({
			content: "First Second",
			eventCursor: cursor("2"),
			status: "completed",
		});
	});
	it.each(["unidentified disconnect", "error", "invalid event"])(
		"preserves buffered text and explains %s without starting another run",
		async (failure) => {
			const stream = makeSseResponse();
			const fetchMock = vi
				.spyOn(global, "fetch")
				.mockResolvedValue(stream.response as unknown as Response);
			const { result } = renderHook(() =>
				useMultiAgentStream({ organizationId: "example-org" }),
			);
			act(() => {
				result.current.sendToAgents(
					"Research",
					[{ agentId: "agent-1", name: "Example" }],
					[],
				);
			});
			await act(async () => {
				if (failure !== "unidentified disconnect") {
					stream.enqueueLine(
						'data: {"type":"started","executionId":"execution-1"}',
					);
				}
				stream.enqueueLine(
					'data: {"type":"text_delta","content":"Partial answer"}',
				);
				stream.enqueueLine(
					'data: {"type":"tool_start","toolName":"search","toolCallId":"tool-1"}',
				);
				if (failure === "error") {
					stream.enqueueLine(
						'data: {"type":"error","message":"Provider unavailable"}',
					);
				}
				if (failure === "invalid event") {
					stream.enqueueLine(
						'data: {"type":"text_delta","content":123}',
					);
				}
				stream.enqueueDone();
			});
			await waitFor(() =>
				expect(
					result.current.turns[0]?.agentResponses.get("agent-1")
						?.status,
				).toBe("error"),
			);
			const response =
				result.current.turns[0]?.agentResponses.get("agent-1");
			expect(response?.content).toBe("Partial answer");
			expect(response?.errorMessage).toBeTruthy();
			expect(response?.toolCalls[0]?.status).toBe("error");
			expect(fetchMock).toHaveBeenCalledOnce();
		},
	);

	it("keeps partial content and settles tools when reattachment loses authorization", async () => {
		const stream = makeSseResponse();
		const fetchMock = vi
			.spyOn(global, "fetch")
			.mockResolvedValueOnce(stream.response as unknown as Response)
			.mockResolvedValueOnce(new Response(null, { status: 403 }));
		const { result } = renderHook(() =>
			useMultiAgentStream({ organizationId: "example-org" }),
		);
		act(() =>
			result.current.sendToAgents(
				"Research",
				[{ agentId: "agent-1", name: "Example" }],
				[],
			),
		);
		await act(async () => {
			stream.enqueueLine(
				'data: {"type":"started","executionId":"orch-example"}',
			);
			stream.enqueueLine(
				'data: {"type":"text_delta","content":"Partial answer"}',
			);
			stream.enqueueLine(
				'data: {"type":"tool_start","toolName":"search","toolCallId":"tool-1"}',
			);
			stream.enqueueLine(
				'data: {"type":"stream_timeout","executionId":"orch-example"}',
			);
		});
		await waitFor(() =>
			expect(
				result.current.turns[0]?.agentResponses.get("agent-1")?.status,
			).toBe("error"),
		);
		expect(
			result.current.turns[0]?.agentResponses.get("agent-1"),
		).toMatchObject({
			content: "Partial answer",
			errorMessage: expect.stringContaining("could not be resumed"),
			toolCalls: [{ id: "tool-1", status: "error" }],
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("Stop during a reconnect gap freezes the partial answer and prevents another stream", async () => {
		vi.useFakeTimers();
		try {
			const stream = makeSseResponse();
			const fetchMock = vi
				.spyOn(global, "fetch")
				.mockResolvedValueOnce(stream.response as unknown as Response)
				.mockResolvedValue(new Response(null));
			const { result } = renderHook(() =>
				useMultiAgentStream({ organizationId: "example-org" }),
			);
			act(() =>
				result.current.sendToAgents(
					"Research",
					[{ agentId: "agent-1", name: "Example" }],
					[],
				),
			);
			await act(async () => {
				stream.enqueueLine(
					'data: {"type":"started","executionId":"orch-example"}',
				);
				stream.enqueueLine(
					'data: {"type":"text_delta","content":"Partial answer"}',
				);
				stream.enqueueDone();
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(result.current.isLoading).toBe(true);
			act(() => result.current.stopAll("button"));
			expect(
				result.current.turns[0]?.agentResponses.get("agent-1")?.content,
			).toBe("Partial answer");
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
			});
			expect(
				result.current.turns[0]?.agentResponses.get("agent-1"),
			).toMatchObject({
				content: "Partial answer",
				status: "cancelled",
				isLoading: false,
			});
			expect(
				fetchMock.mock.calls.filter(([url]) =>
					String(url).endsWith("/stream"),
				),
			).toHaveLength(1);
			expect(
				fetchMock.mock.calls.filter(([url]) =>
					String(url).endsWith("/cancel"),
				),
			).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("unmount aborts an open observation without sending a workflow cancellation", async () => {
		const stream = makeSseResponse();
		const fetchMock = vi
			.spyOn(global, "fetch")
			.mockResolvedValue(stream.response as unknown as Response);
		const { result, unmount } = renderHook(() =>
			useMultiAgentStream({ organizationId: "example-org" }),
		);
		act(() =>
			result.current.sendToAgents(
				"Research",
				[{ agentId: "agent-1", name: "Example" }],
				[],
			),
		);
		await act(async () => {
			stream.enqueueLine(
				'data: {"type":"started","executionId":"orch-example"}',
			);
		});
		unmount();
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("hydrating a conversation discards buffered text from its previous observer", async () => {
		vi.useFakeTimers();
		try {
			const stream = makeSseResponse();
			vi.spyOn(global, "fetch").mockResolvedValue(
				stream.response as unknown as Response,
			);
			const { result } = renderHook(() =>
				useMultiAgentStream({ organizationId: "example-org" }),
			);
			act(() =>
				result.current.sendToAgents(
					"Research",
					[{ agentId: "agent-1", name: "Example" }],
					[],
				),
			);
			await act(async () => {
				stream.enqueueLine(
					'data: {"type":"started","executionId":"orch-example"}',
				);
				stream.enqueueLine(
					'data: {"type":"text_delta","content":"Old buffered text"}',
				);
			});
			const turn = result.current.turns[0];
			const response = turn?.agentResponses.get("agent-1");
			if (!turn || !response) {
				throw new Error("Expected an active turn");
			}
			expect(response.content).toBe("");
			act(() =>
				result.current.hydrateTurns([
					{
						...turn,
						agentResponses: new Map([
							[
								"agent-1",
								{ ...response, content: "Restored answer" },
							],
						]),
					},
				]),
			);
			await act(async () => {
				await vi.advanceTimersByTimeAsync(100);
			});
			expect(
				result.current.turns[0]?.agentResponses.get("agent-1")?.content,
			).toBe("Restored answer");
		} finally {
			vi.useRealTimers();
		}
	});

	it("resumes hydrated history without resubmitting the message or tool configuration", async () => {
		const stream = makeSseResponse();
		const fetchMock = vi
			.spyOn(global, "fetch")
			.mockResolvedValue(stream.response as unknown as Response);
		const { result } = renderHook(() =>
			useMultiAgentStream({ organizationId: "example-org" }),
		);
		act(() => {
			result.current.hydrateTurns([
				{
					id: "example-turn",
					userMessage: "Research",
					timestamp: new Date(),
					agentResponses: new Map([
						[
							"agent-1",
							{
								agentId: "agent-1",
								agentName: "Example",
								executionId: "orch-example",
								content: "Partial answer",
								toolCalls: [],
								isLoading: true,
								isError: false,
								status: "streaming",
							},
						],
					]),
				},
			]);
			result.current.resumeAgents([
				{
					turnId: "example-turn",
					agent: { agentId: "agent-1", name: "Example" },
					executionId: "orch-example",
				},
			]);
		});
		expect(parseBody(fetchMock.mock.calls[0]?.[1])).toEqual({
			eventReplay: true,
			executionId: "orch-example",
			organizationId: "example-org",
		});
		await act(async () => {
			stream.enqueueLine(
				'data: {"type":"started","executionId":"orch-example","resumed":true}',
			);
			stream.enqueueLine(
				'data: {"type":"completed","response":"Partial answer finished"}',
			);
		});
		await waitFor(() =>
			expect(
				result.current.turns[0]?.agentResponses.get("agent-1")?.status,
			).toBe("completed"),
		);
		expect(
			result.current.turns[0]?.agentResponses.get("agent-1")?.content,
		).toBe("Partial answer finished");
	});
});
