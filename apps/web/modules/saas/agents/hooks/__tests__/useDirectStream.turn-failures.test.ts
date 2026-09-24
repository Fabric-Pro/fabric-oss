/**
 * How a Direct turn ends when it does not end cleanly (Fizzy #2040 review):
 *  - F11: tool cards left pending/running when the turn fails or closes.
 *  - F12: a tool result matched by NAME as well as id overwrote every card of
 *    that tool.
 *  - F22: the cause of a failure was dropped once any text had streamed, and
 *    the turn was flipped back to "completed" when the stream closed.
 *  - F32: the whole thread was sent as history, past the route's cap.
 *  - F4: an answer from the tools-off retry was indistinguishable.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/cancel-telemetry", () => ({
	emitCancelEvent: vi.fn(),
}));

import {
	applyToolResult,
	type DirectStreamMessage,
	useDirectStream,
} from "../useDirectStream";

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

function startTurn() {
	const sse = makeSseResponse();
	const fetchSpy = vi
		.spyOn(global, "fetch")
		.mockImplementation(((..._args: unknown[]) =>
			Promise.resolve(sse.response)) as unknown as typeof fetch);
	const hook = renderHook(() => useDirectStream());
	let sendPromise: Promise<string | null | undefined> | undefined;
	act(() => {
		sendPromise = hook.result.current.sendMessage("hello");
	});
	const send = async (event: Record<string, unknown>) => {
		await act(async () => {
			sse.enqueueLine(`data: ${JSON.stringify(event)}`);
		});
	};
	const finish = async () => {
		await act(async () => {
			sse.enqueueDone();
		});
		await act(async () => {
			await sendPromise;
		});
	};
	const last = () =>
		hook.result.current.messages[hook.result.current.messages.length - 1];
	return { hook, send, finish, last, fetchSpy };
}

const originalFetch = global.fetch;
afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("applyToolResult — matching by id (F12)", () => {
	const message = (): DirectStreamMessage => ({
		id: "a1",
		role: "assistant",
		content: "",
		timestamp: new Date(0),
		toolCalls: [
			{
				id: "c1",
				name: "project_rag_query",
				args: {},
				status: "running",
			},
			{
				id: "c2",
				name: "project_rag_query",
				args: {},
				status: "running",
			},
		],
	});

	it("settles only the call the result belongs to", () => {
		const [updated] = applyToolResult([message()], "a1", {
			toolCallId: "c1",
			toolName: "project_rag_query",
			result: { hits: 3 },
			status: "complete",
		});

		expect(updated.toolCalls?.[0]).toMatchObject({
			status: "complete",
			result: { hits: 3 },
		});
		expect(updated.toolCalls?.[1].status).toBe("running");
		expect(updated.toolCalls?.[1].result).toBeUndefined();
	});

	it("falls back to the name only when exactly one such call is open", () => {
		const single: DirectStreamMessage = {
			...message(),
			toolCalls: [
				{ id: "c1", name: "search", args: {}, status: "running" },
				{ id: "c2", name: "other", args: {}, status: "running" },
			],
		};
		const [updated] = applyToolResult([single], "a1", {
			toolName: "search",
			status: "complete",
		});
		expect(updated.toolCalls?.[0].status).toBe("complete");

		const [ambiguous] = applyToolResult([message()], "a1", {
			toolName: "project_rag_query",
			status: "complete",
		});
		expect(ambiguous.toolCalls?.map((tc) => tc.status)).toEqual([
			"running",
			"running",
		]);
	});
});

describe("useDirectStream — a turn that fails", () => {
	it("keeps the partial answer AND the cause, and stays failed after the stream closes (F22)", async () => {
		const { hook, send, finish, last } = startTurn();

		await send({ type: "text", content: "Let me check the roadmap." });
		await send({
			type: "error",
			message: "Rate limit exceeded",
			partial: true,
			limit: { kind: "provider_rate_limit", message: "429" },
		});
		await send({ type: "done" });
		await finish();

		expect(last()).toMatchObject({
			content: "Let me check the roadmap.",
			isError: true,
			errorMessage: "Rate limit exceeded",
			limit: { kind: "provider_rate_limit" },
			streamStatus: "error",
			isStreaming: false,
		});
		expect(hook.result.current.state.status).toBe("error");
	});

	it("settles tool cards that were still running (F11)", async () => {
		const { send, finish, last } = startTurn();

		await send({
			type: "tool_start",
			toolCallId: "c1",
			toolName: "mcp_example_search",
			status: "running",
		});
		await send({ type: "error", message: "activity Heartbeat timeout" });
		await finish();

		expect(last().toolCalls?.[0]).toMatchObject({
			status: "error",
			error: expect.any(String),
		});
	});

	it("settles a card the stream closed on without a result (F11)", async () => {
		const { send, finish, last } = startTurn();

		await send({
			type: "tool_start",
			toolCallId: "c1",
			toolName: "mcp_example_search",
			status: "running",
		});
		await send({ type: "text", content: "Done." });
		await finish();

		expect(last().toolCalls?.[0].status).toBe("error");
		expect(last().streamStatus).toBe("completed");
	});

	it("shows the specific reason from an HTTP error body (F22)", async () => {
		vi.spyOn(global, "fetch").mockImplementation((async () => ({
			ok: false,
			json: async () => ({
				error: "Too many requests",
				message: "Rate limit exceeded. Please try again in 12 seconds.",
			}),
		})) as unknown as typeof fetch);
		const { result } = renderHook(() => useDirectStream());

		await act(async () => {
			await result.current.sendMessage("hello");
		});

		const failed = result.current.messages.at(-1);
		expect(failed?.errorMessage).toMatch(/try again in 12 seconds/);
		expect(failed?.streamStatus).toBe("error");
	});
});

describe("useDirectStream — tools-off retry notice (F4)", () => {
	it("marks an answer that was produced after the tools failed", async () => {
		const { send, finish, last } = startTurn();

		await send({ type: "text", content: "Here is what I know." });
		await send({
			type: "done",
			toolsFailed: { summary: "schema rejected" },
		});
		await finish();

		expect(last().toolsFailed).toEqual({ summary: "schema rejected" });
		expect(last().isError).toBeFalsy();
	});
});

describe("useDirectStream — answer stopped on a limit (F25)", () => {
	it("marks an answer cut at the output ceiling", async () => {
		const { send, finish, last, hook } = startTurn();

		await send({ type: "text", content: "The first half of" });
		await send({ type: "done", truncated: "output_limit" });
		await finish();

		expect(last().truncated).toBe("output_limit");
		expect(last().isError).toBeFalsy();
		expect(hook.result.current.state.status).toBe("completed");
	});

	it("marks a step-capped turn even with no text", async () => {
		const { send, finish, last } = startTurn();

		await send({ type: "done", truncated: "step_limit" });
		await finish();

		expect(last().truncated).toBe("step_limit");
	});

	it("ignores an unknown value", async () => {
		const { send, finish, last } = startTurn();

		await send({ type: "text", content: "Done." });
		await send({ type: "done", truncated: "length" });
		await finish();

		expect(last().truncated).toBeUndefined();
	});
});

describe("useDirectStream — history window (F32)", () => {
	it("sends at most the route's window, starting on a question", async () => {
		const { response, enqueueDone } = makeSseResponse();
		const fetchSpy = vi
			.spyOn(global, "fetch")
			.mockImplementation(((..._args: unknown[]) =>
				Promise.resolve(response)) as unknown as typeof fetch);
		const { result } = renderHook(() => useDirectStream());
		const history = Array.from({ length: 301 }, (_, i) => ({
			role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
			content: i === 300 ? "x".repeat(250_000) : `turn ${i}`,
		}));

		act(() => {
			void result.current.sendMessage("next", history);
		});
		await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

		const body = JSON.parse(
			(fetchSpy.mock.calls[0]?.[1] as { body: string }).body,
		) as { history: Array<{ role: string; content: string }> };
		expect(body.history.length).toBeLessThanOrEqual(200);
		expect(body.history[0].role).toBe("user");
		expect(body.history.at(-1)?.content.length).toBe(200_000);

		await act(async () => {
			enqueueDone();
		});
	});
});
