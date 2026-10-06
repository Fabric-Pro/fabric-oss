/**
 * `useOrchestratorStream` and the server-owned Advisor turn.
 *
 *  - Every message carries a per-message `clientRequestKey`; a reconnect
 *    before `started` (no executionId yet) re-sends the same key, so the
 *    server attaches to the turn it already created instead of starting a
 *    second one.
 *  - Stop before `started` still reaches the server: it cancels by the key.
 *  - A `completed` event whose domain status is "cancelled" is shown as
 *    cancelled — not as a completed answer — and offers no "continue in new
 *    chat".
 *  - A 409 TURN_IN_PROGRESS (a different message is already being answered
 *    in this conversation, possibly in another tab) refuses this message:
 *    it is removed from the chat, never attached to the other turn, and the
 *    chat gets a notice to render.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/cancel-telemetry", () => ({
	emitCancelEvent: vi.fn(),
}));
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

import { useOrchestratorStream } from "../useOrchestratorStream";

const STREAM_URL = "/api/agents/fabric-ai/orchestrator-temporal/stream";
const CANCEL_URL = "/api/agents/fabric-ai/orchestrator-temporal/cancel";

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
				drain();
			};
		});
	const push = (entry: { value?: Uint8Array; done?: boolean }) => {
		queue.push(entry);
		const r = resolveNext;
		resolveNext = null;
		r?.();
	};
	return {
		response: {
			ok: true,
			status: 200,
			body: { getReader: () => ({ read }) },
			json: async () => ({}),
		},
		enqueueLine: (line: string) =>
			push({ value: encoder.encode(`${line}\n`) }),
		enqueueDone: () => push({ done: true }),
	};
}

interface Call {
	url: string;
	body: Record<string, unknown>;
}

function installFetch(streamResponses: Array<unknown | (() => unknown)>): {
	calls: Call[];
} {
	const calls: Call[] = [];
	let next = 0;
	global.fetch = vi.fn((input: unknown, init?: RequestInit) => {
		const url = typeof input === "string" ? input : (input as Request).url;
		calls.push({
			url,
			body: init?.body ? JSON.parse(String(init.body)) : {},
		});
		if (url !== STREAM_URL) {
			return Promise.resolve({
				ok: true,
				status: 200,
				json: async () => ({ success: true }),
			} as Response);
		}
		const scripted = streamResponses[next++];
		if (scripted === undefined) {
			return Promise.reject(new Error("unexpected stream POST"));
		}
		const value = typeof scripted === "function" ? scripted() : scripted;
		return value instanceof Error
			? Promise.reject(value)
			: Promise.resolve(value as Response);
	}) as unknown as typeof fetch;
	return { calls };
}

const originalFetch = global.fetch;
afterEach(() => {
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

const HOOK_OPTIONS = {
	organizationId: "org-example-1",
	conversationId: "conversation-example-1",
};

describe("useOrchestratorStream — server-owned turns", () => {
	it("sends a per-message clientRequestKey, and a new key for the next message", async () => {
		const first = makeSseResponse();
		const second = makeSseResponse();
		const { calls } = installFetch([first.response, second.response]);
		const { result } = renderHook(() =>
			useOrchestratorStream(HOOK_OPTIONS),
		);

		let sending: Promise<string | null> | undefined;
		act(() => {
			sending = result.current.sendMessage("first");
		});
		await act(async () => {
			first.enqueueLine(
				'data: {"type":"completed","status":"completed","response":"one"}',
			);
			first.enqueueDone();
			await sending;
		});
		act(() => {
			sending = result.current.sendMessage("second");
		});
		await act(async () => {
			second.enqueueLine(
				'data: {"type":"completed","status":"completed","response":"two"}',
			);
			second.enqueueDone();
			await sending;
		});

		const streamBodies = calls.filter((c) => c.url === STREAM_URL);
		expect(streamBodies).toHaveLength(2);
		const [k1, k2] = streamBodies.map((c) => c.body.clientRequestKey);
		expect(typeof k1).toBe("string");
		expect((k1 as string).length).toBeGreaterThanOrEqual(8);
		expect(k2).not.toBe(k1);
	});

	it("posts cancel with the message's key when Stop lands before `started`", async () => {
		const window = makeSseResponse();
		const { calls } = installFetch([window.response]);
		const { result } = renderHook(() =>
			useOrchestratorStream(HOOK_OPTIONS),
		);

		let sending: Promise<string | null> | undefined;
		act(() => {
			sending = result.current.sendMessage("hello");
		});
		await waitFor(() => {
			expect(calls.some((c) => c.url === STREAM_URL)).toBe(true);
		});
		const key = calls.find((c) => c.url === STREAM_URL)?.body
			.clientRequestKey;

		act(() => {
			result.current.stop("button");
		});

		await waitFor(() => {
			expect(calls.some((c) => c.url === CANCEL_URL)).toBe(true);
		});
		const cancel = calls.find((c) => c.url === CANCEL_URL);
		expect(cancel?.body).toMatchObject({
			clientRequestKey: key,
			conversationId: HOOK_OPTIONS.conversationId,
			organizationId: HOOK_OPTIONS.organizationId,
		});
		expect(cancel?.body.executionId).toBeUndefined();

		await act(async () => {
			window.enqueueDone();
			await sending;
		});
	});

	it("shows a `completed` event with status 'cancelled' as cancelled, with no handoff", async () => {
		const window = makeSseResponse();
		installFetch([window.response]);
		const { result } = renderHook(() =>
			useOrchestratorStream(HOOK_OPTIONS),
		);

		let sending: Promise<string | null> | undefined;
		act(() => {
			sending = result.current.sendMessage("hello");
		});
		await act(async () => {
			window.enqueueLine(
				'data: {"type":"started","executionId":"orch-aaaaaaaa-0000-4000-8000-000000000001"}',
			);
			window.enqueueLine(
				'data: {"type":"completed","status":"cancelled","response":"partial","handoffRecommended":{"reason":"x","summary":"y"}}',
			);
			window.enqueueDone();
			await sending;
		});

		expect(result.current.state.status).toBe("cancelled");
		expect(result.current.state.handoffRecommended).toBeUndefined();
		const last =
			result.current.messages[result.current.messages.length - 1];
		expect(last?.streamStatus).toBe("cancelled");
		expect(result.current.isLoading).toBe(false);
	});

	describe("a different message refused because another turn is live (TURN_IN_PROGRESS)", () => {
		const OTHER_TURN = "orch-bbbbbbbb-0000-4000-8000-000000000002";
		const refusal = (body: Record<string, unknown>) => ({
			ok: false,
			status: 409,
			json: async () => ({
				error: "A turn is already running in this conversation",
				code: "TURN_IN_PROGRESS",
				...body,
			}),
		});

		async function sendRefused(
			body: Record<string, unknown>,
			onTurnRefused = vi.fn(),
		) {
			const { calls } = installFetch([refusal(body)]);
			const { result } = renderHook(() =>
				useOrchestratorStream({ ...HOOK_OPTIONS, onTurnRefused }),
			);
			await act(async () => {
				await result.current.sendMessage("review the last commits");
			});
			return { calls, result, onTurnRefused };
		}

		function expectRefused(
			result: { current: ReturnType<typeof useOrchestratorStream> },
			calls: Call[],
			onTurnRefused: ReturnType<typeof vi.fn>,
		) {
			// Only the refused POST: no reconnect to the other turn.
			expect(calls.filter((c) => c.url === STREAM_URL)).toHaveLength(1);
			// Neither the question nor a placeholder answer is shown.
			expect(result.current.messages).toEqual([]);
			// The chat's failure notice renders from these two fields.
			expect(result.current.state.status).toBe("failed");
			expect(result.current.state.result?.error).toMatch(
				/already being answered/,
			);
			// No execution of this message exists, so the chat's save
			// effect (keyed on `state.executionId`) has nothing to save.
			expect(result.current.state.executionId).toBeNull();
			expect(result.current.isLoading).toBe(false);
			expect(onTurnRefused).toHaveBeenCalledWith(
				"review the last commits",
			);
		}

		it("with the other turn's executionId: not attached, not shown, notice set", async () => {
			const { calls, result, onTurnRefused } = await sendRefused({
				executionId: OTHER_TURN,
			});
			expectRefused(result, calls, onTurnRefused);
		});

		it("without an executionId: not shown, notice set (not an invisible failure)", async () => {
			const { calls, result, onTurnRefused } = await sendRefused({});
			expectRefused(result, calls, onTurnRefused);
		});

		it("appends the sentence the consumer returns to the notice", async () => {
			const { result } = await sendRefused(
				{ executionId: OTHER_TURN },
				vi.fn(() => "Its attachments were not sent."),
			);
			expect(result.current.state.result?.error).toMatch(
				/already being answered.* Its attachments were not sent\.$/,
			);
		});

		it.each([
			["Stop", "cancelled"],
			["a reset", "idle"],
		] as const)(
			"a refusal read after %s changes nothing",
			async (action, expectedStatus) => {
				let releaseBody: (body: unknown) => void = () => {};
				const body = new Promise((resolve) => {
					releaseBody = resolve;
				});
				const { calls } = installFetch([
					{ ok: false, status: 409, json: () => body },
				]);
				const onTurnRefused = vi.fn();
				const { result } = renderHook(() =>
					useOrchestratorStream({ ...HOOK_OPTIONS, onTurnRefused }),
				);

				let sending: Promise<string | null> | undefined;
				act(() => {
					sending = result.current.sendMessage(
						"review the last commits",
					);
				});
				await waitFor(() => {
					expect(calls.some((c) => c.url === STREAM_URL)).toBe(true);
				});
				act(() => {
					if (action === "Stop") {
						result.current.stop("button");
					} else {
						result.current.reset();
					}
				});
				const settled = result.current.state.status;
				expect(settled).toBe(expectedStatus);

				await act(async () => {
					releaseBody({
						error: "A turn is already running in this conversation",
						code: "TURN_IN_PROGRESS",
						executionId: OTHER_TURN,
					});
					await sending;
				});

				expect(onTurnRefused).not.toHaveBeenCalled();
				expect(result.current.state.status).toBe(expectedStatus);
				expect(result.current.state.result?.error).toBeUndefined();
			},
		);

		it("keeps earlier messages of the conversation, even when sent in the same millisecond", async () => {
			// Message ids come from `Date.now()`; the refused pair must not
			// take the earlier pair with it when their ids coincide.
			vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
			const first = makeSseResponse();
			const { calls } = installFetch([
				first.response,
				refusal({ executionId: OTHER_TURN }),
			]);
			const { result } = renderHook(() =>
				useOrchestratorStream(HOOK_OPTIONS),
			);
			let sending: Promise<string | null> | undefined;
			act(() => {
				sending = result.current.sendMessage("first");
			});
			await act(async () => {
				first.enqueueLine(
					'data: {"type":"completed","status":"completed","response":"one"}',
				);
				first.enqueueDone();
				await sending;
			});
			const before = result.current.messages.map((m) => m.id);
			expect(before).toHaveLength(2);

			await act(async () => {
				await result.current.sendMessage("second");
			});

			expect(calls.filter((c) => c.url === STREAM_URL)).toHaveLength(2);
			expect(result.current.messages.map((m) => m.id)).toEqual(before);
			expect(result.current.state.result?.error).toMatch(
				/already being answered/,
			);
		});

		it("the next message after a refusal starts clean and runs normally", async () => {
			const live = makeSseResponse();
			const { calls } = installFetch([
				refusal({ executionId: OTHER_TURN }),
				live.response,
			]);
			const { result } = renderHook(() =>
				useOrchestratorStream(HOOK_OPTIONS),
			);
			await act(async () => {
				await result.current.sendMessage("refused one");
			});
			expect(result.current.state.result?.error).toMatch(
				/already being answered/,
			);

			let sending: Promise<string | null> | undefined;
			act(() => {
				sending = result.current.sendMessage("sent again");
			});
			// The notice is gone as soon as the new message is on its way.
			expect(result.current.state.status).toBe("running");
			expect(result.current.state.result).toBeNull();
			await act(async () => {
				live.enqueueLine(
					'data: {"type":"started","executionId":"orch-dddddddd-0000-4000-8000-00000000000d"}',
				);
				live.enqueueLine(
					'data: {"type":"completed","status":"completed","response":"the answer"}',
				);
				live.enqueueDone();
				await sending;
			});

			const posts = calls.filter((c) => c.url === STREAM_URL);
			expect(posts).toHaveLength(2);
			expect(posts[1]?.body.message).toBe("sent again");
			expect(posts[1]?.body.executionId).toBeUndefined();
			expect(posts[1]?.body.clientRequestKey).not.toBe(
				posts[0]?.body.clientRequestKey,
			);
			expect(result.current.state.status).toBe("completed");
			expect(result.current.state.result?.error).toBeUndefined();
			expect(result.current.state.executionId).toBe(
				"orch-dddddddd-0000-4000-8000-00000000000d",
			);
			expect(
				result.current.messages.map((m) => [m.role, m.content]),
			).toEqual([
				["user", "sent again"],
				["assistant", "the answer"],
			]);
		});

		it("a retry whose first attempt never reached the server is refused the same way", async () => {
			// The first POST never got an answer, so the message's key has
			// no turn; by the retry another tab's turn is live, and the
			// retry is a new message as far as the server is concerned.
			const onTurnRefused = vi.fn();
			const { calls } = installFetch([
				new TypeError("Failed to fetch"),
				refusal({ executionId: OTHER_TURN }),
			]);
			const { result } = renderHook(() =>
				useOrchestratorStream({ ...HOOK_OPTIONS, onTurnRefused }),
			);
			await act(async () => {
				await result.current.sendMessage("review the last commits");
			});
			const posts = calls.filter((c) => c.url === STREAM_URL);
			expect(posts).toHaveLength(2);
			expect(posts[1]?.body.executionId).toBeUndefined();
			expect(result.current.messages).toEqual([]);
			expect(result.current.state.result?.error).toMatch(
				/already being answered/,
			);
			expect(onTurnRefused).toHaveBeenCalledTimes(1);
		});
	});

	it("a refusal that reaches the generic failure path still sets the notice the chat renders", async () => {
		const { calls } = installFetch([
			{
				ok: false,
				status: 403,
				json: async () => ({
					error: "Forbidden",
					message: "This conversation is not accessible",
				}),
			},
		]);
		const { result } = renderHook(() =>
			useOrchestratorStream(HOOK_OPTIONS),
		);
		await act(async () => {
			await result.current.sendMessage("hello");
		});
		expect(calls.filter((c) => c.url === STREAM_URL)).toHaveLength(1);
		expect(result.current.state.status).toBe("failed");
		expect(result.current.state.result?.error).toBe("Forbidden");
	});

	it("re-sends the same key when the stream drops before `started`", async () => {
		const dropped = makeSseResponse();
		const resumed = makeSseResponse();
		const { calls } = installFetch([dropped.response, resumed.response]);
		const { result } = renderHook(() =>
			useOrchestratorStream(HOOK_OPTIONS),
		);

		let sending: Promise<string | null> | undefined;
		act(() => {
			sending = result.current.sendMessage("hello");
		});
		await act(async () => {
			// The stream closes before the server sent `started`.
			dropped.enqueueDone();
		});
		await waitFor(
			() => {
				expect(calls.filter((c) => c.url === STREAM_URL)).toHaveLength(
					2,
				);
			},
			{ timeout: 5_000 },
		);
		await act(async () => {
			resumed.enqueueLine(
				'data: {"type":"completed","status":"completed","response":"ok"}',
			);
			resumed.enqueueDone();
			await sending;
		});

		const [firstPost, retry] = calls.filter((c) => c.url === STREAM_URL);
		expect(retry?.body.clientRequestKey).toBe(
			firstPost?.body.clientRequestKey,
		);
		expect(retry?.body.message).toBe("hello");
	});

	it("R1-1: Stop on the second message before its `started` never names the first message's execution", async () => {
		const first = makeSseResponse();
		const second = makeSseResponse();
		const { calls } = installFetch([first.response, second.response]);
		const { result } = renderHook(() =>
			useOrchestratorStream(HOOK_OPTIONS),
		);

		let sending: Promise<string | null> | undefined;
		act(() => {
			sending = result.current.sendMessage("first");
		});
		await act(async () => {
			first.enqueueLine(
				'data: {"type":"started","executionId":"orch-aaaaaaaa-0000-4000-8000-00000000000a"}',
			);
			first.enqueueLine(
				'data: {"type":"completed","status":"completed","response":"one"}',
			);
			first.enqueueDone();
			await sending;
		});
		expect(result.current.state.executionId).toBe(
			"orch-aaaaaaaa-0000-4000-8000-00000000000a",
		);

		act(() => {
			sending = result.current.sendMessage("second");
		});
		await waitFor(() => {
			expect(calls.filter((c) => c.url === STREAM_URL)).toHaveLength(2);
		});
		const secondKey = calls.filter((c) => c.url === STREAM_URL)[1]?.body
			.clientRequestKey;

		act(() => {
			result.current.stop("button");
		});
		await waitFor(() => {
			expect(calls.some((c) => c.url === CANCEL_URL)).toBe(true);
		});
		const cancel = calls.find((c) => c.url === CANCEL_URL);
		expect(cancel?.body.executionId).toBeUndefined();
		expect(cancel?.body.clientRequestKey).toBe(secondKey);

		await act(async () => {
			second.enqueueDone();
			await sending;
		});
	});

	it("R1-8: a 409 TURN_PENDING is retried with the same request after its delay, without failing the turn", async () => {
		const live = makeSseResponse();
		const { calls } = installFetch([
			{
				ok: false,
				status: 409,
				headers: {
					get: (h: string) => (h === "Retry-After" ? "0" : null),
				},
				json: async () => ({
					code: "TURN_PENDING",
					executionId: "orch-cccccccc-0000-4000-8000-00000000000c",
				}),
			},
			live.response,
		]);
		const { result } = renderHook(() =>
			useOrchestratorStream(HOOK_OPTIONS),
		);

		let sending: Promise<string | null> | undefined;
		act(() => {
			sending = result.current.sendMessage("hello");
		});
		await waitFor(
			() => {
				expect(calls.filter((c) => c.url === STREAM_URL)).toHaveLength(
					2,
				);
			},
			{ timeout: 5_000 },
		);
		expect(result.current.state.status).toBe("running");
		await act(async () => {
			live.enqueueLine(
				'data: {"type":"completed","status":"completed","response":"ok"}',
			);
			live.enqueueDone();
			await sending;
		});
		const [firstPost, retry] = calls.filter((c) => c.url === STREAM_URL);
		expect(retry?.body.executionId).toBe(
			"orch-cccccccc-0000-4000-8000-00000000000c",
		);
		expect(retry?.body.clientRequestKey).toBe(
			firstPost?.body.clientRequestKey,
		);
		expect(result.current.state.status).toBe("completed");
	});

	it("R2-1: a planner-mode message (no turn) is not re-sent when its stream drops before `started`", async () => {
		const dropped = makeSseResponse();
		const { calls } = installFetch([dropped.response]);
		const { result } = renderHook(() =>
			useOrchestratorStream({
				...HOOK_OPTIONS,
				executionMode: "save_reuse",
			}),
		);

		let sending: Promise<string | null> | undefined;
		act(() => {
			sending = result.current.sendMessage("plan it");
		});
		await act(async () => {
			dropped.enqueueDone();
			await sending;
		});

		// Re-sending would start a second planner run: the server gives
		// these modes no turn, so the key cannot make the resend idempotent.
		expect(calls.filter((c) => c.url === STREAM_URL)).toHaveLength(1);
		expect(result.current.state.status).toBe("failed");
	});

	describe("F-6: a lost initial response", () => {
		async function send(responses: Array<unknown>, executionMode?: string) {
			const { calls } = installFetch(responses);
			const { result } = renderHook(() =>
				useOrchestratorStream({
					...HOOK_OPTIONS,
					...(executionMode
						? { executionMode: executionMode as never }
						: {}),
				}),
			);
			let sending: Promise<string | null> | undefined;
			act(() => {
				sending = result.current.sendMessage("hello");
			});
			return { calls, result, done: () => sending };
		}

		it("retries the original request with the same key after a rejected fetch (turn mode)", async () => {
			const live = makeSseResponse();
			const { calls, result, done } = await send([
				new TypeError("Failed to fetch"),
				live.response,
			]);
			await waitFor(
				() => {
					expect(
						calls.filter((c) => c.url === STREAM_URL),
					).toHaveLength(2);
				},
				{ timeout: 5_000 },
			);
			await act(async () => {
				live.enqueueLine(
					'data: {"type":"completed","status":"completed","response":"ok"}',
				);
				live.enqueueDone();
				await done();
			});
			const [first, retry] = calls.filter((c) => c.url === STREAM_URL);
			expect(retry?.body.clientRequestKey).toBe(
				first?.body.clientRequestKey,
			);
			expect(retry?.body.message).toBe("hello");
			expect(result.current.state.status).toBe("completed");
		});

		it("retries after a 503 with no readable body (turn mode)", async () => {
			const live = makeSseResponse();
			const { calls, done } = await send([
				{
					ok: false,
					status: 503,
					json: async () => {
						throw new SyntaxError("Unexpected token <");
					},
				},
				live.response,
			]);
			await waitFor(
				() => {
					expect(
						calls.filter((c) => c.url === STREAM_URL),
					).toHaveLength(2);
				},
				{ timeout: 5_000 },
			);
			await act(async () => {
				live.enqueueLine(
					'data: {"type":"completed","status":"completed","response":"ok"}',
				);
				live.enqueueDone();
				await done();
			});
		});

		it("does not retry an authorization refusal", async () => {
			const { calls, result, done } = await send([
				{
					ok: false,
					status: 403,
					json: async () => ({ error: "Forbidden" }),
				},
			]);
			await act(async () => {
				await done();
			});
			expect(calls.filter((c) => c.url === STREAM_URL)).toHaveLength(1);
			expect(result.current.state.status).toBe("failed");
		});

		it("does not retry a planner-mode message (no turn, no idempotency)", async () => {
			const { calls, result, done } = await send(
				[new TypeError("Failed to fetch")],
				"save_reuse",
			);
			await act(async () => {
				await done();
			});
			expect(calls.filter((c) => c.url === STREAM_URL)).toHaveLength(1);
			expect(result.current.state.status).toBe("failed");
		});
	});

	describe("R2-F2: the server could not confirm the start", () => {
		// Exactly the event the stream route emits for an ambiguous start
		// (asserted in __tests__/api/orchestrator-turn-admission.test.ts,
		// "R2-F2: an ambiguous start is reported as a retryable
		// start_pending event").
		const START_PENDING_EVENT = JSON.stringify({
			type: "start_pending",
			retryable: true,
			executionId: "orch-00000000-0000-4000-8000-000000000001",
		});

		it("keeps loading and retries the same message key, then shows the run", async () => {
			const pending = makeSseResponse();
			const live = makeSseResponse();
			const { calls } = installFetch([pending.response, live.response]);
			const { result } = renderHook(() =>
				useOrchestratorStream(HOOK_OPTIONS),
			);
			let sending: Promise<string | null> | undefined;
			act(() => {
				sending = result.current.sendMessage("hello");
			});
			await act(async () => {
				pending.enqueueLine(`data: ${START_PENDING_EVENT}`);
				pending.enqueueDone();
			});
			// Between the two requests: still loading, not failed.
			expect(result.current.isLoading).toBe(true);
			expect(result.current.state.status).not.toBe("failed");
			await waitFor(
				() => {
					expect(
						calls.filter((c) => c.url === STREAM_URL),
					).toHaveLength(2);
				},
				{ timeout: 5_000 },
			);
			await act(async () => {
				live.enqueueLine(
					'data: {"type":"completed","status":"completed","response":"ok"}',
				);
				live.enqueueDone();
				await sending;
			});
			const [first, retry] = calls.filter((c) => c.url === STREAM_URL);
			expect(retry?.body.clientRequestKey).toBe(
				first?.body.clientRequestKey,
			);
			expect(retry?.body.message).toBe("hello");
			expect(result.current.state.status).toBe("completed");
		});

		it("stays within the bounded retry budget when the start is never confirmed", async () => {
			// The first request plus MAX_UNCLEAN_RESUMES (3) retries, each
			// answered start_pending. `start_pending` must not refill the
			// budget the way real progress does.
			const pendings = Array.from({ length: 4 }, () => {
				const r = makeSseResponse();
				r.enqueueLine(`data: ${START_PENDING_EVENT}`);
				r.enqueueDone();
				return r.response;
			});
			const { calls } = installFetch(pendings);
			const { result } = renderHook(() =>
				useOrchestratorStream(HOOK_OPTIONS),
			);
			await act(async () => {
				await result.current.sendMessage("hello");
			});
			expect(calls.filter((c) => c.url === STREAM_URL)).toHaveLength(4);
			expect(result.current.isLoading).toBe(false);
		}, 20_000);
	});
});
