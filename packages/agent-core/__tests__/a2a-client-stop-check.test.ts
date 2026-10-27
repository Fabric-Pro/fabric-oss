/**
 * `A2AClient` runs the caller's synchronous stop check immediately before
 * every `fetch` it makes, after awaiting the caller's asynchronous
 * admission callback (`beforeAttempt`), so a stop that lands while that
 * callback resolves — after it said yes, before the request — still keeps
 * the request from being sent. The client's own network retries are checked
 * the same way. Only `fetch` is simulated.
 */

import { fetchAgentEndpoint } from "@repo/utils/agent-endpoint";
import {
	type DispatchBudgetRequest,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { afterEach, describe, expect, it, vi } from "vitest";
import { A2AClient } from "../src/a2a/client";

const STOP = new Error("the chat turn stopped");

function stubFetch(
	impl: (url: string) => Promise<Response>,
): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn((input: unknown) =>
		impl(typeof input === "string" ? input : String(input)),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

const message = {
	role: "user" as const,
	parts: [{ type: "text" as const, text: "Plan this" }],
};

describe("A2AClient request control", () => {
	it("sends the message when nothing stops the caller", async () => {
		const fetchMock = stubFetch(async () =>
			Response.json({ id: "task-example-1", status: "completed" }),
		);
		const client = new A2AClient({ retryAttempts: 1 });
		await expect(
			client.sendMessage("https://agent.example.com", message, {
				beforeAttempt: async () => undefined,
				throwIfStopped: () => undefined,
			}),
		).resolves.toMatchObject({ id: "task-example-1" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("sends nothing when the stop latches as the admission callback resolves", async () => {
		const fetchMock = stubFetch(async () =>
			Response.json({ id: "task-example-1", status: "completed" }),
		);
		let stopped = false;
		const client = new A2AClient({ retryAttempts: 1 });
		const outcome = await client
			.sendMessage("https://agent.example.com", message, {
				// The admission check says yes; the stop lands in the
				// continuation queued right behind it, before the client
				// resumes.
				beforeAttempt: () => {
					const admitted = Promise.resolve();
					admitted.then(() => {
						stopped = true;
					});
					return admitted;
				},
				throwIfStopped: () => {
					if (stopped) {
						throw STOP;
					}
				},
			})
			.then(
				() => "sent",
				(error: unknown) => error,
			);
		expect(outcome).toBe(STOP);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("checks again before each network retry, and sends no retry after a stop", async () => {
		let stopped = false;
		const fetchMock = stubFetch(async () => {
			// The first attempt fails at the network level; the turn stops
			// while the client backs off.
			stopped = true;
			throw new TypeError("fetch failed");
		});
		const client = new A2AClient({ retryAttempts: 3, retryDelay: 1 });
		const outcome = await client
			.sendMessage("https://agent.example.com", message, {
				throwIfStopped: () => {
					if (stopped) {
						throw STOP;
					}
				},
			})
			.then(
				() => "sent",
				(error: unknown) => error,
			);
		expect(outcome).toBe(STOP);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("A2A submission turn reservations", () => {
	it("reserves the caller's fixed block for each physical retry and keeps both charges", async () => {
		const reserve = vi.fn(async (_request: DispatchBudgetRequest) => ({
			attemptId: `attempt-${reserve.mock.calls.length}`,
			outputCap: null,
		}));
		const markUnknown = vi.fn(async () => {});
		const settle = vi.fn(async () => {});
		const reservedAtSend: number[] = [];
		const fetchMock = stubFetch(async () => {
			reservedAtSend.push(reserve.mock.calls.length);
			if (reservedAtSend.length === 1) {
				throw new TypeError("fetch failed");
			}
			return Response.json({ id: "example-task", status: "completed" });
		});
		const client = new A2AClient({ retryAttempts: 2, retryDelay: 1 });
		const result = await runWithDispatchGuard(
			{
				key: "example-turn",
				assertDispatchable: async () => {},
				abortSignal: () => undefined,
				rethrowIfStopped: () => {},
				budget: {
					reserve,
					markUnknown,
					settle,
					release: vi.fn(async () => {}),
				},
			},
			() =>
				client.sendMessage("https://agent.example.com", message, {
					submissionTokenAllowance: 25_000,
				}),
		);
		expect(result.id).toBe("example-task");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(reservedAtSend).toEqual([1, 2]);
		expect(reserve).toHaveBeenNthCalledWith(1, {
			modality: "external",
			inputEstimate: 0,
			requestedOutputTokens: 25_000,
			minOutputTokens: 25_000,
			enforcesOutputCap: false,
		});
		expect(reserve).toHaveBeenNthCalledWith(2, reserve.mock.calls[0][0]);
		expect(markUnknown.mock.calls).toEqual([["attempt-1"], ["attempt-2"]]);
		expect(settle).not.toHaveBeenCalled();
	});
});

function submissionGuard() {
	const budget = {
		reserve: vi.fn(async () => ({
			attemptId: "example-attempt",
			outputCap: null,
		})),
		markUnknown: vi.fn(async () => {}),
		settle: vi.fn(async () => {}),
		release: vi.fn(async () => {}),
	};
	return {
		key: "example-turn",
		assertDispatchable: vi.fn(async () => {}),
		abortSignal: () => undefined,
		rethrowIfStopped: () => {},
		budget,
	};
}

describe("A2A transport timeout boundary", () => {
	it.each(["turn check", "reservation"])(
		"starts the timeout after a slow %s",
		async (stage) => {
			vi.useFakeTimers();
			const guard = submissionGuard();
			let resume: () => void = () => {};
			const waiting = new Promise<void>((resolve) => {
				resume = resolve;
			});
			if (stage === "turn check") {
				guard.assertDispatchable.mockImplementation(
					async () => waiting,
				);
			} else {
				guard.budget.reserve.mockImplementation(async () => {
					await waiting;
					return { attemptId: "example-attempt", outputCap: null };
				});
			}
			const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
				expect(init.signal?.aborted).toBe(false);
				return Response.json({
					id: "example-task",
					status: "completed",
				});
			});
			const client = new A2AClient({
				timeout: 20,
				retryAttempts: 2,
				retryDelay: 1,
				fetch: fetchMock,
			});
			const running = runWithDispatchGuard(guard, () =>
				client.sendMessage("https://agent.example.com", message, {
					submissionTokenAllowance: 25_000,
				}),
			).then(
				(value) => ({ value }),
				(error) => ({ error }),
			);
			await vi.advanceTimersByTimeAsync(100);
			expect(fetchMock).not.toHaveBeenCalled();
			resume();
			expect(await running).toMatchObject({
				value: { id: "example-task" },
			});
			expect(fetchMock).toHaveBeenCalledOnce();
			expect(guard.budget.markUnknown).toHaveBeenCalledOnce();
			expect(guard.budget.release).not.toHaveBeenCalled();
		},
	);
	it("wraps and retries a transport timeout before the response headers", async () => {
		vi.useFakeTimers();
		const guard = submissionGuard();
		const fetchMock = vi.fn(
			(_url: string, init: RequestInit): Promise<Response> =>
				new Promise((_resolve, reject) => {
					const signal = init.signal;
					signal?.addEventListener(
						"abort",
						() => reject(signal.reason),
						{
							once: true,
						},
					);
				}),
		);
		const client = new A2AClient({
			timeout: 20,
			retryAttempts: 2,
			retryDelay: 1,
			fetch: fetchMock,
		});
		const running = runWithDispatchGuard(guard, () =>
			client.sendMessage("https://agent.example.com", message, {
				submissionTokenAllowance: 25_000,
			}),
		).catch((error) => error);
		await vi.advanceTimersByTimeAsync(100);
		expect(await running).toMatchObject({
			code: "NETWORK_ERROR",
			details: { attempts: 2 },
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(guard.budget.reserve).toHaveBeenCalledTimes(2);
		expect(guard.budget.markUnknown).toHaveBeenCalledTimes(2);
		expect(guard.budget.release).not.toHaveBeenCalled();
	});
	it("does not time out a slow body once the response headers arrive", async () => {
		vi.useFakeTimers();
		const guard = submissionGuard();
		const fetchMock = vi.fn(
			async (_url: string, init: RequestInit): Promise<Response> =>
				new Response(
					new ReadableStream({
						start(controller) {
							// Like a real fetch body, the stream errors when the
							// request signal aborts.
							const signal = init.signal;
							signal?.addEventListener(
								"abort",
								() => controller.error(signal.reason),
								{ once: true },
							);
							setTimeout(() => {
								controller.enqueue(
									new TextEncoder().encode(
										JSON.stringify({
											id: "example-task",
											status: "completed",
										}),
									),
								);
								controller.close();
							}, 100);
						},
					}),
				),
		);
		const client = new A2AClient({
			timeout: 20,
			retryAttempts: 2,
			retryDelay: 1,
			fetch: fetchMock,
		});
		const running = runWithDispatchGuard(guard, () =>
			client.sendMessage("https://agent.example.com", message, {
				submissionTokenAllowance: 25_000,
			}),
		).then(
			(value) => ({ value }),
			(error) => ({ error }),
		);
		await vi.advanceTimersByTimeAsync(200);
		expect(await running).toMatchObject({ value: { id: "example-task" } });
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(guard.budget.reserve).toHaveBeenCalledOnce();
		expect(guard.budget.markUnknown).toHaveBeenCalledOnce();
	});
	it("keeps a malformed 200 body classified as a parse error and retains the charge", async () => {
		const guard = submissionGuard();
		const fetchMock = vi.fn(async () => new Response("not-json"));
		const client = new A2AClient({
			fetch: fetchMock,
			retryAttempts: 2,
			retryDelay: 1,
		});
		const error = await runWithDispatchGuard(guard, () =>
			client.sendMessage("https://agent.example.com", message, {
				submissionTokenAllowance: 25_000,
			}),
		).catch((error) => error);
		expect(error).toBeInstanceOf(SyntaxError);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(guard.budget.markUnknown).toHaveBeenCalledOnce();
		expect(guard.budget.release).not.toHaveBeenCalled();
	});
	it("retains an endpoint refusal without a proof-bearing unsent error", async () => {
		vi.stubEnv("AGENT_DISCOVERY_ALLOWED_HOSTS", "");
		const network = vi.fn();
		vi.stubGlobal("fetch", network);
		const guard = submissionGuard();
		const client = new A2AClient({
			fetch: fetchAgentEndpoint,
			retryAttempts: 2,
		});
		const error = await runWithDispatchGuard(guard, () =>
			client.sendMessage("http://169.254.169.254", message, {
				submissionTokenAllowance: 25_000,
			}),
		).catch((error) => error);
		expect(error).toMatchObject({ code: "NETWORK_ERROR" });
		expect(network).not.toHaveBeenCalled();
		expect(guard.budget.reserve).toHaveBeenCalledOnce();
		expect(guard.budget.markUnknown).toHaveBeenCalledOnce();
		expect(guard.budget.release).not.toHaveBeenCalled();
	});
});
