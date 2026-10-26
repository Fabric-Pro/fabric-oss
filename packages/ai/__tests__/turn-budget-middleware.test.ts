/**
 * The turn-budget middleware every factory model carries
 * (turn-budget-middleware.ts), against the real AI SDK request path with mock
 * provider models and a recording ledger.
 *
 * Pins:
 *  - every physical request (each SDK retry, each step) reserves a fresh
 *    attempt before it is sent, and settles it after;
 *  - a stream's `finish` reaches the caller only once its settlement is
 *    written, or once the settlement timeout passes — and then the
 *    settlement is left to land on its own (SETTLED with its usage), with
 *    nothing else written to the attempt;
 *  - a settlement write that fails leaves the attempt RESERVED (charged);
 *  - no path starts two transitions for one attempt;
 *  - only complete usage settles; an error or abort after the send, a stream
 *    that closes without `finish`, or partial usage marks the attempt
 *    UNKNOWN; an `error` chunk followed by a full `finish` settles;
 *  - the ledger's output cap is what an enforced model is sent, a model that
 *    cannot be capped is sent as asked, and a denial sends nothing;
 *  - no guard, a guard without a ledger, or a ledger that answers
 *    "unledgered" reserve nothing; a refusal that happens before the send
 *    (the usage-limit check) leaves no reservation; an abort that fired
 *    before the send releases the reservation.
 */

import {
	type DispatchBudget,
	type DispatchBudgetRequest,
	type DispatchGuard,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { APICallError, embedMany, generateText, streamText } from "ai";
import {
	MockEmbeddingModelV4,
	MockLanguageModelV4,
	simulateReadableStream,
} from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { wrapModelWithDispatchGuard } from "../lib/dispatch-guard-middleware";
import {
	estimateLanguageRequestInputTokens,
	estimateModelRequestInputTokens,
} from "../lib/turn-budget-estimate";
import {
	completeLanguageUsage,
	wrapEmbeddingModelWithTurnBudget,
	wrapModelWithTurnBudget,
} from "../lib/turn-budget-middleware";
import { wrapModelWithUsageLimits } from "../lib/usage-limit-middleware";

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const USAGE = {
	inputTokens: { total: 120, noCache: 100, cacheRead: 20, cacheWrite: 0 },
	outputTokens: { total: 30, text: 20, reasoning: 10 },
};

const GENERATE_RESULT = {
	content: [{ type: "text" as const, text: "ok" }],
	finishReason: { unified: "stop" as const, raw: undefined },
	usage: USAGE,
	warnings: [],
};

type Chunk = Record<string, unknown>;

function finishChunk(usage: unknown = USAGE): Chunk {
	return {
		type: "finish",
		finishReason: { unified: "stop", raw: undefined },
		usage,
	};
}

function textChunks(text = "ok"): Chunk[] {
	return [
		{ type: "stream-start", warnings: [] },
		{ type: "text-start", id: "t1" },
		{ type: "text-delta", id: "t1", delta: text },
		{ type: "text-end", id: "t1" },
	];
}

function streamOf(chunks: Chunk[]) {
	return {
		stream: simulateReadableStream({ chunks }) as ReadableStream<never>,
	};
}

function retryableProviderError() {
	return new APICallError({
		message: "provider overloaded",
		url: "https://provider.example.com/v1",
		requestBodyValues: {},
		statusCode: 503,
		isRetryable: true,
	});
}

class BudgetDenied extends Error {
	constructor() {
		super("allowance used");
		this.name = "BudgetDenied";
	}
}

/**
 * A recording ledger. `outputCap` is what each reservation grants (a
 * number, null for "send as asked", or "unledgered" to answer null).
 */
function makeBudget(
	options: {
		outputCap?: number | null | "unledgered";
		deny?: boolean;
		settle?: () => Promise<void>;
	} = {},
) {
	let seq = 0;
	const reserved: Array<{ id: string; request: DispatchBudgetRequest }> = [];
	const events: string[] = [];
	const budget: DispatchBudget = {
		reserve: vi.fn(async (request: DispatchBudgetRequest) => {
			if (options.deny) {
				throw new BudgetDenied();
			}
			if (options.outputCap === "unledgered") {
				return null;
			}
			seq += 1;
			const id = `attempt-${seq}`;
			reserved.push({ id, request });
			events.push(`reserve:${id}`);
			return {
				attemptId: id,
				outputCap:
					options.outputCap === undefined ? 2_000 : options.outputCap,
			};
		}),
		settle: vi.fn(async (attemptId, usage) => {
			await options.settle?.();
			events.push(
				`settle:${attemptId}:${usage.inputTokens}/${usage.outputTokens}`,
			);
		}),
		markUnknown: vi.fn(async (attemptId) => {
			events.push(`unknown:${attemptId}`);
		}),
		release: vi.fn(async (attemptId) => {
			events.push(`release:${attemptId}`);
		}),
	};
	return { budget, reserved, events };
}

function guardWith(
	budget: DispatchBudget | undefined,
	signal?: AbortSignal,
): DispatchGuard {
	return {
		key: "turn-1",
		assertDispatchable: async () => undefined,
		abortSignal: () => signal,
		rethrowIfStopped: () => undefined,
		...(budget ? { budget } : {}),
	};
}

/** The factory's stack: guard, usage limits, ledger, provider. */
function factoryModel(
	provider: MockLanguageModelV4,
	options: {
		enforcesOutputCap?: boolean;
		assertWithinLimits?: () => Promise<void>;
	} = {},
) {
	return wrapModelWithDispatchGuard(
		wrapModelWithUsageLimits(
			wrapModelWithTurnBudget(provider, {
				enforcesOutputCap: options.enforcesOutputCap ?? true,
			}),
			options.assertWithinLimits ?? (async () => undefined),
		),
	);
}

describe("completeLanguageUsage", () => {
	it("reads the provider totals: input with cache counted once, output with reasoning", () => {
		expect(completeLanguageUsage(USAGE)).toEqual({
			inputTokens: 120,
			cacheReadTokens: 20,
			outputTokens: 30,
		});
		expect(
			completeLanguageUsage({ inputTokens: 7, outputTokens: 3 }),
		).toEqual({ inputTokens: 7, outputTokens: 3 });
	});

	it("keeps cache writes fully charged by exposing only reported cache reads", () => {
		expect(
			completeLanguageUsage({
				inputTokens: {
					total: 120,
					noCache: 20,
					cacheWrite: 80,
					cacheRead: 20,
				},
				outputTokens: 3,
			}),
		).toEqual({ inputTokens: 120, cacheReadTokens: 20, outputTokens: 3 });
		expect(
			completeLanguageUsage({
				inputTokens: { total: 120 },
				outputTokens: 3,
			}),
		).toEqual({ inputTokens: 120, outputTokens: 3 });
	});

	it("rejects partial or missing usage instead of reading it as zero", () => {
		expect(completeLanguageUsage(undefined)).toBeNull();
		expect(
			completeLanguageUsage({
				inputTokens: { total: 10 },
				outputTokens: { total: undefined, text: 4 },
			}),
		).toBeNull();
		expect(
			completeLanguageUsage({ inputTokens: { total: Number.NaN } }),
		).toBeNull();
	});
});

describe("language models under a ledger", () => {
	it.each(["generate", "stream"])(
		"passes raw input and the read bucket through %s settlement",
		async (mode) => {
			const provider = new MockLanguageModelV4({
				doGenerate: async () => GENERATE_RESULT,
				doStream: async () =>
					streamOf([...textChunks(), finishChunk()]),
			});
			const { budget } = makeBudget();
			await runWithDispatchGuard(guardWith(budget), async () => {
				const model = wrapModelWithTurnBudget(provider, {
					enforcesOutputCap: true,
				});
				if (mode === "generate") {
					const result = await generateText({
						model,
						prompt: "Example",
						maxRetries: 0,
					});
					expect(result.usage.inputTokens).toBe(120);
				} else {
					const result = streamText({
						model,
						prompt: "Example",
						maxRetries: 0,
					});
					await result.consumeStream();
					expect((await result.usage).inputTokens).toBe(120);
				}
			});
			expect(budget.settle).toHaveBeenCalledWith("attempt-1", {
				inputTokens: 120,
				cacheReadTokens: 20,
				outputTokens: 30,
			});
		},
	);

	it("reserves a fresh attempt for every SDK retry, and settles each one", async () => {
		let calls = 0;
		const provider = new MockLanguageModelV4({
			doGenerate: async () => {
				calls += 1;
				if (calls === 1) {
					throw retryableProviderError();
				}
				return GENERATE_RESULT;
			},
		});
		const { budget, events } = makeBudget();

		const result = await runWithDispatchGuard(guardWith(budget), () =>
			generateText({
				model: factoryModel(provider),
				prompt: "Hi",
				maxRetries: 1,
			}),
		);

		expect(result.text).toBe("ok");
		expect(provider.doGenerateCalls).toHaveLength(2);
		// The failed send stays charged (UNKNOWN); the retry is its own
		// attempt, settled to what it used.
		expect(events).toEqual([
			"reserve:attempt-1",
			"unknown:attempt-1",
			"reserve:attempt-2",
			"settle:attempt-2:120/30",
		]);
	});

	it("reserves a fresh attempt for every step of a multi-step call", async () => {
		let calls = 0;
		const provider = new MockLanguageModelV4({
			doGenerate: async () => {
				calls += 1;
				return calls === 1
					? {
							...GENERATE_RESULT,
							content: [
								{
									type: "tool-call" as const,
									toolCallId: "c1",
									toolName: "lookup",
									input: "{}",
								},
							],
							finishReason: {
								unified: "tool-calls" as const,
								raw: undefined,
							},
						}
					: GENERATE_RESULT;
			},
		});
		const { budget, events } = makeBudget();
		const { jsonSchema, tool, isStepCount } = await import("ai");

		await runWithDispatchGuard(guardWith(budget), () =>
			generateText({
				model: factoryModel(provider),
				prompt: "Hi",
				tools: {
					lookup: tool({
						inputSchema: jsonSchema({
							type: "object",
							properties: {},
						}),
						execute: async () => "found",
					}),
				},
				stopWhen: isStepCount(3),
			}),
		);

		expect(provider.doGenerateCalls).toHaveLength(2);
		expect(events).toEqual([
			"reserve:attempt-1",
			"settle:attempt-1:120/30",
			"reserve:attempt-2",
			"settle:attempt-2:120/30",
		]);
	});

	it("sends an enforced model the ledger's output cap", async () => {
		const provider = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});
		const { budget, reserved } = makeBudget({ outputCap: 2_000 });

		await runWithDispatchGuard(guardWith(budget), () =>
			generateText({
				model: factoryModel(provider),
				prompt: "Hi",
				maxOutputTokens: 16_384,
			}),
		);

		expect(provider.doGenerateCalls[0]?.maxOutputTokens).toBe(2_000);
		expect(reserved[0]?.request).toMatchObject({
			modality: "language",
			requestedOutputTokens: 16_384,
			minOutputTokens: 1_024,
			enforcesOutputCap: true,
		});
		expect(reserved[0]?.request.inputEstimate).toBeGreaterThan(0);
	});

	it("sends a model that cannot be capped as asked, and tells the ledger so", async () => {
		const provider = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});
		const { budget, reserved, events } = makeBudget({ outputCap: null });

		await runWithDispatchGuard(guardWith(budget), () =>
			generateText({
				model: factoryModel(provider, { enforcesOutputCap: false }),
				prompt: "Hi",
				maxOutputTokens: 4_000,
			}),
		);

		expect(provider.doGenerateCalls[0]?.maxOutputTokens).toBe(4_000);
		expect(reserved[0]?.request.enforcesOutputCap).toBe(false);
		expect(events).toEqual([
			"reserve:attempt-1",
			"settle:attempt-1:120/30",
		]);
	});

	it("sends nothing when the ledger denies the request, and surfaces the denial", async () => {
		const provider = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});
		const { budget } = makeBudget({ deny: true });

		await expect(
			runWithDispatchGuard(guardWith(budget), () =>
				generateText({
					model: factoryModel(provider),
					prompt: "Hi",
					maxRetries: 0,
				}),
			),
		).rejects.toBeInstanceOf(BudgetDenied);
		expect(provider.doGenerateCalls).toHaveLength(0);
	});

	it("marks an attempt with partial usage UNKNOWN, never settled to zero", async () => {
		const provider = new MockLanguageModelV4({
			doGenerate: async () => ({
				...GENERATE_RESULT,
				usage: {
					inputTokens: { total: 50 },
					outputTokens: { total: undefined },
				} as never,
			}),
		});
		const { budget, events } = makeBudget();

		await runWithDispatchGuard(guardWith(budget), () =>
			generateText({ model: factoryModel(provider), prompt: "Hi" }),
		);

		expect(events).toEqual(["reserve:attempt-1", "unknown:attempt-1"]);
	});

	it("leaves no reservation when a check before the send refuses the request", async () => {
		const provider = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});
		const { budget } = makeBudget();
		const limitError = new Error("usage limit reached");

		await expect(
			runWithDispatchGuard(guardWith(budget), () =>
				generateText({
					model: factoryModel(provider, {
						assertWithinLimits: async () => {
							throw limitError;
						},
					}),
					prompt: "Hi",
					maxRetries: 0,
				}),
			),
		).rejects.toBe(limitError);
		expect(budget.reserve).not.toHaveBeenCalled();
		expect(provider.doGenerateCalls).toHaveLength(0);
	});

	it("releases the reservation when the abort fired before the send", async () => {
		const provider = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});
		const controller = new AbortController();
		const { budget, events } = makeBudget({
			settle: async () => undefined,
		});
		const reserving = budget.reserve;
		budget.reserve = vi.fn(async (request) => {
			const granted = await reserving(request);
			// The turn is stopped while the reservation is being written.
			controller.abort(new Error("stopped"));
			return granted;
		});

		await expect(
			runWithDispatchGuard(guardWith(budget, controller.signal), () =>
				generateText({
					model: factoryModel(provider),
					prompt: "Hi",
					maxRetries: 0,
				}),
			),
		).rejects.toThrow("stopped");
		expect(provider.doGenerateCalls).toHaveLength(0);
		expect(events).toEqual(["reserve:attempt-1", "release:attempt-1"]);
	});

	it.each([
		["no guard", undefined, false],
		["a guard without a ledger", guardWith(undefined), false],
		[
			"a ledger that answers unledgered",
			guardWith(makeBudget({ outputCap: "unledgered" }).budget),
			true,
		],
	] as const)(
		"reserves nothing with %s",
		async (_label, guard, consulted) => {
			const provider = new MockLanguageModelV4({
				doGenerate: async () => GENERATE_RESULT,
			});
			const call = () =>
				generateText({
					model: factoryModel(provider),
					prompt: "Hi",
					maxOutputTokens: 777,
				});
			const result = guard
				? await runWithDispatchGuard(guard, call)
				: await call();

			expect(result.text).toBe("ok");
			expect(provider.doGenerateCalls[0]?.maxOutputTokens).toBe(777);
			if (guard?.budget) {
				expect(guard.budget.reserve).toHaveBeenCalledTimes(
					consulted ? 1 : 0,
				);
				expect(guard.budget.settle).not.toHaveBeenCalled();
				expect(guard.budget.markUnknown).not.toHaveBeenCalled();
			}
		},
	);
});

/** Every transition call the middleware made, per attempt, in call order. */
function transitionsByAttempt(budget: DispatchBudget): Map<string, string[]> {
	const byAttempt = new Map<string, string[]>();
	const record = (name: string, calls: unknown[][]) => {
		for (const [attemptId] of calls) {
			const id = String(attemptId);
			byAttempt.set(id, [...(byAttempt.get(id) ?? []), name]);
		}
	};
	record("settle", vi.mocked(budget.settle).mock.calls);
	record("unknown", vi.mocked(budget.markUnknown).mock.calls);
	record("release", vi.mocked(budget.release).mock.calls);
	return byAttempt;
}

describe("sizing a request before it is sent", () => {
	it("estimates exactly the input the middleware reserves, for a conversation with tool calls and results", async () => {
		const provider = new MockLanguageModelV4({
			doStream: async () => streamOf([...textChunks(), finishChunk()]),
		});
		const { budget, reserved } = makeBudget();
		const instructions = "You are writing the final answer.";
		const messages = [
			{ role: "user" as const, content: "Is the launch flag enabled?" },
			{
				role: "assistant" as const,
				content: [
					{ type: "text" as const, text: "Checking the flags file." },
					{
						type: "tool-call" as const,
						toolCallId: "call-1",
						toolName: "example_get_file",
						input: { path: "src/flags.ts", ref: "main" },
					},
					{
						type: "tool-call" as const,
						toolCallId: "call-2",
						toolName: "example_get_file",
						input: { path: "src/app.ts", ref: "main" },
					},
				],
			},
			// Two tool messages in a row: the SDK merges them into one before
			// the middleware sees the request, so counting the messages as
			// written would not give the middleware's number.
			{
				role: "tool" as const,
				content: [
					{
						type: "tool-result" as const,
						toolCallId: "call-1",
						toolName: "example_get_file",
						output: {
							type: "json" as const,
							value: { text: 'export const launch = "on";\n' },
						},
					},
				],
			},
			{
				role: "tool" as const,
				content: [
					{
						type: "tool-result" as const,
						toolCallId: "call-2",
						toolName: "example_get_file",
						output: {
							type: "text" as const,
							value: "import { launch }",
						},
					},
				],
			},
			{ role: "user" as const, content: "And who reads it?" },
		];

		const estimated = await estimateModelRequestInputTokens({
			instructions,
			messages,
		});
		await runWithDispatchGuard(guardWith(budget), async () => {
			const result = streamText({
				model: factoryModel(provider),
				instructions,
				messages,
			});
			await result.consumeStream();
		});

		expect(reserved).toHaveLength(1);
		expect(reserved[0]?.request.inputEstimate).toBe(estimated);
		// Not the count of the messages as written (one framing fewer).
		expect(
			estimateLanguageRequestInputTokens({
				prompt: [
					{ role: "system", content: instructions },
					...messages,
				],
			}),
		).not.toBe(estimated);
	});
});

describe("settlement timing", () => {
	it("forwards the finish at the timeout and lets a settlement that resolves later land as SETTLED with its usage", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			let releaseSettle: () => void = () => undefined;
			const stalled = new Promise<void>((resolve) => {
				releaseSettle = resolve;
			});
			const provider = new MockLanguageModelV4({
				doStream: async () =>
					streamOf([...textChunks(), finishChunk()]),
			});
			const { budget, events } = makeBudget({ settle: () => stalled });

			const text = runWithDispatchGuard(guardWith(budget), async () => {
				const result = streamText({
					model: factoryModel(provider),
					prompt: "Hi",
				});
				return result.text;
			});
			await vi.waitFor(() => expect(budget.settle).toHaveBeenCalled());
			let finished = false;
			void text.then(() => {
				finished = true;
			});
			await vi.advanceTimersByTimeAsync(9_000);
			expect(finished).toBe(false);

			// The timeout passes: the finish is forwarded, the attempt is
			// left as it is (RESERVED, charged at its reservation) and no
			// second transition is started.
			await vi.advanceTimersByTimeAsync(1_000);
			await expect(text).resolves.toBe("ok");
			expect(budget.markUnknown).not.toHaveBeenCalled();

			// The settlement lands afterwards with the authoritative usage.
			releaseSettle();
			await vi.waitFor(() =>
				expect(events).toEqual([
					"reserve:attempt-1",
					"settle:attempt-1:120/30",
				]),
			);
			expect(budget.settle).toHaveBeenCalledTimes(1);
			expect(budget.markUnknown).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves an attempt whose settlement write fails RESERVED: no other transition is written", async () => {
		const provider = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});
		const { budget, events } = makeBudget({
			settle: async () => {
				throw new Error("connection reset");
			},
		});

		const result = await runWithDispatchGuard(guardWith(budget), () =>
			generateText({ model: factoryModel(provider), prompt: "Hi" }),
		);

		expect(result.text).toBe("ok");
		expect(budget.settle).toHaveBeenCalledTimes(1);
		expect(budget.markUnknown).not.toHaveBeenCalled();
		expect(budget.release).not.toHaveBeenCalled();
		expect(events).toEqual(["reserve:attempt-1"]);
	});

	it.each([
		["a settled generate", "generate", "ok"],
		["a generate whose settlement times out", "generate", "stall"],
		["a generate whose settlement fails", "generate", "fail"],
		["a generate whose send fails", "generate", "send-error"],
		["a settled stream", "stream", "ok"],
		["a stream whose settlement times out", "stream", "stall"],
		["a stream whose settlement fails", "stream", "fail"],
		["a stream without a finish", "stream", "no-finish"],
		["a stream the consumer cancels after the finish", "stream", "cancel"],
	] as const)(
		"never starts two transitions for one attempt: %s",
		async (_label, mode, outcome) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				const settle =
					outcome === "stall"
						? () => new Promise<void>(() => undefined)
						: outcome === "fail"
							? async () => {
									throw new Error("connection reset");
								}
							: async () => undefined;
				const { budget } = makeBudget({ settle });
				const chunks =
					outcome === "no-finish"
						? textChunks()
						: [...textChunks(), finishChunk()];
				const provider = new MockLanguageModelV4({
					doGenerate: async () => {
						if (outcome === "send-error") {
							throw new Error("connection reset");
						}
						return GENERATE_RESULT;
					},
					doStream: async () => streamOf(chunks),
				});
				const run = runWithDispatchGuard(
					guardWith(budget),
					async () => {
						if (mode === "generate") {
							await generateText({
								model: factoryModel(provider),
								prompt: "Hi",
								maxRetries: 0,
							}).catch(() => undefined);
							return;
						}
						const result = streamText({
							model: factoryModel(provider),
							prompt: "Hi",
							onError: () => undefined,
						});
						if (outcome === "cancel") {
							const reader = result.fullStream.getReader();
							for (;;) {
								const { value, done } = await reader.read();
								if (done || value?.type === "finish") {
									break;
								}
							}
							await reader.cancel();
							return;
						}
						await result.consumeStream({
							onError: () => undefined,
						});
					},
				);
				await vi.advanceTimersByTimeAsync(20_000);
				await run;
				await vi.advanceTimersByTimeAsync(20_000);

				const transitions = transitionsByAttempt(budget);
				expect(transitions.size).toBe(1);
				for (const calls of transitions.values()) {
					expect(calls).toHaveLength(1);
				}
			} finally {
				vi.useRealTimers();
			}
		},
	);
});

describe("streams under a ledger", () => {
	it("holds the finish until the settlement is written", async () => {
		let releaseSettle: () => void = () => undefined;
		const settleGate = new Promise<void>((resolve) => {
			releaseSettle = resolve;
		});
		const provider = new MockLanguageModelV4({
			doStream: async () => streamOf([...textChunks(), finishChunk()]),
		});
		const { budget, events } = makeBudget({ settle: () => settleGate });

		const done = runWithDispatchGuard(guardWith(budget), async () => {
			const result = streamText({
				model: factoryModel(provider),
				prompt: "Hi",
			});
			return result.text;
		});
		let finished = false;
		void done.then(() => {
			finished = true;
		});

		await vi.waitFor(() => expect(budget.settle).toHaveBeenCalledTimes(1));
		// Settlement in progress: the caller has not seen completion yet.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(finished).toBe(false);

		releaseSettle();
		await expect(done).resolves.toBe("ok");
		expect(events).toEqual([
			"reserve:attempt-1",
			"settle:attempt-1:120/30",
		]);
		expect(provider.doStreamCalls[0]?.maxOutputTokens).toBe(2_000);
	});

	it("marks a stream that closes without a finish UNKNOWN", async () => {
		const provider = new MockLanguageModelV4({
			doStream: async () => streamOf(textChunks()),
		});
		const { budget, events } = makeBudget();

		await runWithDispatchGuard(guardWith(budget), async () => {
			const result = streamText({
				model: factoryModel(provider),
				prompt: "Hi",
			});
			await result.consumeStream();
		});

		expect(events).toEqual(["reserve:attempt-1", "unknown:attempt-1"]);
	});

	it("marks a stream that fails to open UNKNOWN (it may have been sent)", async () => {
		const provider = new MockLanguageModelV4({
			doStream: async () => {
				throw new Error("connection reset");
			},
		});
		const { budget, events } = makeBudget();

		await runWithDispatchGuard(guardWith(budget), async () => {
			const result = streamText({
				model: factoryModel(provider),
				prompt: "Hi",
				maxRetries: 0,
				onError: () => undefined,
			});
			await result.consumeStream();
		});

		expect(events).toEqual(["reserve:attempt-1", "unknown:attempt-1"]);
	});

	it("marks a stream aborted after the send UNKNOWN", async () => {
		const controller = new AbortController();
		const provider = new MockLanguageModelV4({
			doStream: async () => ({
				stream: new ReadableStream<never>({
					start(streamController) {
						for (const chunk of textChunks()) {
							streamController.enqueue(chunk as never);
						}
						controller.signal.addEventListener("abort", () =>
							streamController.error(controller.signal.reason),
						);
					},
				}),
			}),
		});
		const { budget, events } = makeBudget();

		await runWithDispatchGuard(guardWith(budget), async () => {
			const result = streamText({
				model: factoryModel(provider),
				prompt: "Hi",
				abortSignal: controller.signal,
				onError: () => undefined,
			});
			const reading = result.consumeStream({ onError: () => undefined });
			await vi.waitFor(() => expect(budget.reserve).toHaveBeenCalled());
			controller.abort(new Error("stopped"));
			await reading;
		});

		await vi.waitFor(() =>
			expect(events).toEqual(["reserve:attempt-1", "unknown:attempt-1"]),
		);
		expect(budget.settle).not.toHaveBeenCalled();
	});

	it("settles from a full finish that follows an error chunk", async () => {
		const provider = new MockLanguageModelV4({
			doStream: async () =>
				streamOf([
					...textChunks(),
					{ type: "error", error: new Error("tool_use malformed") },
					finishChunk(),
				]),
		});
		const { budget, events } = makeBudget();

		await runWithDispatchGuard(guardWith(budget), async () => {
			const result = streamText({
				model: factoryModel(provider),
				prompt: "Hi",
				onError: () => undefined,
			});
			await result.consumeStream({ onError: () => undefined });
		});

		expect(events).toEqual([
			"reserve:attempt-1",
			"settle:attempt-1:120/30",
		]);
	});

	it("marks a finish with partial usage UNKNOWN", async () => {
		const provider = new MockLanguageModelV4({
			doStream: async () =>
				streamOf([
					...textChunks(),
					finishChunk({
						inputTokens: { total: 10 },
						outputTokens: { total: undefined },
					}),
				]),
		});
		const { budget, events } = makeBudget();

		await runWithDispatchGuard(guardWith(budget), async () => {
			const result = streamText({
				model: factoryModel(provider),
				prompt: "Hi",
			});
			await result.consumeStream();
		});

		expect(events).toEqual(["reserve:attempt-1", "unknown:attempt-1"]);
	});
});

describe("embeddings under a ledger", () => {
	it("reserves each physical embed request's input and settles its reported tokens", async () => {
		const provider = new MockEmbeddingModelV4({
			maxEmbeddingsPerCall: 2,
			supportsParallelCalls: false,
			doEmbed: async ({ values }) => ({
				embeddings: values.map(() => [0.1, 0.2]),
				usage: { tokens: values.length * 5 },
				warnings: [],
			}),
		});
		const { budget, reserved, events } = makeBudget({ outputCap: null });

		await runWithDispatchGuard(guardWith(budget), () =>
			embedMany({
				model: wrapEmbeddingModelWithTurnBudget(provider),
				values: ["a", "bb", "ccc"],
			}),
		);

		expect(reserved.map((entry) => entry.request.modality)).toEqual([
			"embedding",
			"embedding",
		]);
		expect(reserved[0]?.request.requestedOutputTokens).toBe(0);
		expect(events).toEqual([
			"reserve:attempt-1",
			"settle:attempt-1:10/0",
			"reserve:attempt-2",
			"settle:attempt-2:5/0",
		]);
	});

	it("marks an embed request with no reported usage UNKNOWN", async () => {
		const provider = new MockEmbeddingModelV4({
			doEmbed: async ({ values }) => ({
				embeddings: values.map(() => [0.1]),
				warnings: [],
			}),
		});
		const { budget, events } = makeBudget({ outputCap: null });

		await runWithDispatchGuard(guardWith(budget), () =>
			embedMany({
				model: wrapEmbeddingModelWithTurnBudget(provider),
				values: ["a"],
			}),
		);

		expect(events).toEqual(["reserve:attempt-1", "unknown:attempt-1"]);
	});
});

describe("catalog cap on ledger reservations", () => {
	describe.each(["generate", "stream"] as const)("%s", (mode) => {
		it.each([8192, 32768, undefined])(
			"caps an omitted budget reservation for model limit %s",
			async (cap) => {
				const provider = new MockLanguageModelV4({
					doGenerate: async () => GENERATE_RESULT,
					doStream: async () =>
						streamOf([...textChunks(), finishChunk()]),
				});
				const { budget, reserved } = makeBudget();
				const model = wrapModelWithTurnBudget(provider, {
					enforcesOutputCap: true,
					maxOutputTokens: cap,
				});
				await runWithDispatchGuard(guardWith(budget), async () => {
					if (mode === "generate") {
						await generateText({
							model,
							prompt: "Example",
							maxRetries: 0,
						});
					} else {
						await streamText({
							model,
							prompt: "Example",
							maxRetries: 0,
						}).consumeStream();
					}
				});
				expect(reserved[0]?.request.requestedOutputTokens).toBe(
					cap === 8192 ? 8192 : 16384,
				);
			},
		);
	});
});

describe.each(["generate", "stream"] as const)(
	"catalog cap without reservation: %s",
	(mode) => {
		describe.each(["no guard", "no budget", "null reservation"] as const)(
			"%s",
			(path) => {
				it.each([
					{ requested: 16384, cap: 8192, expected: 8192 },
					{ requested: 16384, cap: 32768, expected: 16384 },
					{ requested: 16384, cap: undefined, expected: 16384 },
					{ requested: 1000, cap: 8192, expected: 1000 },
					{ requested: undefined, cap: 8192, expected: undefined },
				])(
					"sends $expected for requested $requested and catalog $cap",
					async ({ requested, cap, expected }) => {
						const provider = new MockLanguageModelV4({
							doGenerate: async () => GENERATE_RESULT,
							doStream: async () =>
								streamOf([...textChunks(), finishChunk()]),
						});
						const model = wrapModelWithTurnBudget(provider, {
							enforcesOutputCap: true,
							maxOutputTokens: cap,
						});
						const { budget } = makeBudget({
							outputCap: "unledgered",
						});
						const send = async () => {
							if (mode === "generate") {
								await generateText({
									model,
									prompt: "Example",
									maxOutputTokens: requested,
									maxRetries: 0,
								});
							} else {
								await streamText({
									model,
									prompt: "Example",
									maxOutputTokens: requested,
									maxRetries: 0,
								}).consumeStream();
							}
						};
						if (path === "no guard") {
							await send();
						} else {
							await runWithDispatchGuard(
								guardWith(
									path === "null reservation"
										? budget
										: undefined,
								),
								send,
							);
						}
						const calls =
							mode === "generate"
								? provider.doGenerateCalls
								: provider.doStreamCalls;
						expect(calls[0]?.maxOutputTokens).toBe(expected);
					},
				);
			},
		);
	},
);
