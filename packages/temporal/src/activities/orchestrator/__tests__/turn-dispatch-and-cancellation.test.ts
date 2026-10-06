/**
 * Advisor turn cancellation, activity side: a Stop must stop the provider
 * request that is running, and no new provider request may start once the
 * turn's cancel is durably recorded.
 *
 * Two mechanisms, both proven here against a mock provider transport (a
 * `fetch` the mock model calls with the abort signal it was handed, exactly
 * where a real provider SDK would):
 *
 *   1. Temporal's activity cancellation (`Context.current().cancellationSignal`)
 *      is passed as the request's abort signal, so a cancelled activity
 *      aborts its in-flight request and reports itself cancelled.
 *   2. The durable dispatch check (`checkConversationTurnDispatchable`, read
 *      immediately before every provider request of a turn that has a
 *      turnId) refuses with a NON-RETRYABLE `TurnNotDispatchable` failure,
 *      and the request is never made — including the in-activity retry of a
 *      stream and each chunk of a large-result summary.
 *
 * Every model-calling activity the orchestrator host runs in a turn is
 * covered: the round (runAgentIteration — also the synthesis call), the
 * up-front clarity check, compaction, the tool-result summarizer, and the
 * agent delegation tool.
 */

import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { APICallError } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	checkDispatchable: vi.fn(),
	model: { current: undefined as unknown },
	delegateToAgent: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	checkConversationTurnDispatchable: hoisted.checkDispatchable,
}));

vi.mock("@repo/ai", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getAIModel: vi.fn(async () => hoisted.model.current),
	getAIModelWithMetadata: vi.fn(async () => ({
		model: hoisted.model.current,
	})),
}));

vi.mock("@repo/ai/skills", () => ({
	listAvailableSkills: vi.fn(async () => []),
	createSkillTools: vi.fn(() => ({})),
	buildSkillsSystemBlock: vi.fn(() => ""),
}));

vi.mock("../../../lib/redis-publisher", () => ({
	publishExecutionEvent: vi.fn(),
}));

vi.mock("../utils", () => ({
	getAiModelWithSelection: vi.fn(async () => ({
		model: hoisted.model.current,
		provider: "ANTHROPIC_DIRECT",
		modelString: "example-model",
		canonicalName: "example-model",
	})),
}));

vi.mock("../delegation", () => ({
	resolveAgentEndpoint: vi.fn(async () => ({ id: "agent-1" })),
	delegateToAgent: hoisted.delegateToAgent,
}));

import { analyzeIntentClarityActivity } from "../clarification";
import { compactConversationHistoryActivity } from "../execution/compact-conversation";
import { executeAgentAsTool } from "../execution/execute-agent-as-tool";
import { runAgentIteration } from "../execution/run-agent-iteration";
import { summarizeLargeToolResult } from "../execution/summarize-tool-result";

// ---------------------------------------------------------------------------
// Mock provider transport
// ---------------------------------------------------------------------------

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-00000000-0000-4000-8000-000000000001",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

const USAGE = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 4, text: 4, reasoning: 0 },
};

interface RecordedRequest {
	aborted: boolean;
}

/**
 * Stands in for the provider's HTTP call. It answers after `latencyMs`
 * unless the signal it was given aborts first, in which case it rejects with
 * the abort reason — what `fetch` does.
 */
function createTransport(latencyMs = 1_500) {
	const requests: RecordedRequest[] = [];
	const fetchMock = vi.fn(
		(_url: string, init: { signal?: AbortSignal }) =>
			new Promise<void>((resolve, reject) => {
				const record: RecordedRequest = { aborted: false };
				requests.push(record);
				const timer = setTimeout(resolve, latencyMs);
				const signal = init.signal;
				if (signal?.aborted) {
					clearTimeout(timer);
					record.aborted = true;
					reject(signal.reason);
					return;
				}
				signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					record.aborted = true;
					reject(signal.reason);
				});
			}),
	);
	return { fetchMock, requests };
}

function textStreamChunks(text: string) {
	return [
		{ type: "stream-start" as const, warnings: [] },
		{ type: "text-start" as const, id: "t1" },
		{ type: "text-delta" as const, id: "t1", delta: text },
		{ type: "text-end" as const, id: "t1" },
		{
			type: "finish" as const,
			finishReason: { unified: "stop" as const, raw: undefined },
			usage: USAGE,
		},
	];
}

/**
 * A model whose every request goes through `transport` with the abort
 * signal the AI SDK handed it. `failFirstStream` makes the first stream end
 * in a transient provider error, so the activity's in-activity retry runs.
 */
/** A retryable provider failure (HTTP 503), which the AI SDK retries itself. */
function retryableProviderError() {
	return new APICallError({
		message: "Service Unavailable",
		url: "https://provider.example.com/v1",
		requestBodyValues: {},
		statusCode: 503,
		isRetryable: true,
	});
}

function installModel(
	transport: ReturnType<typeof createTransport>,
	opts: {
		failFirstStream?: boolean;
		text?: string;
		/** The first physical request fails retryably; `onFirstFailure` runs then. */
		failFirstRequestRetryably?: { onFirstFailure: () => void };
	} = {},
) {
	let streams = 0;
	let requests = 0;
	const maybeFailRetryably = () => {
		requests++;
		if (opts.failFirstRequestRetryably && requests === 1) {
			opts.failFirstRequestRetryably.onFirstFailure();
			throw retryableProviderError();
		}
	};
	hoisted.model.current = new MockLanguageModelV4({
		doStream: async (options) => {
			streams++;
			await transport.fetchMock(
				"https://provider.example.com/v1/stream",
				{
					signal: options.abortSignal,
				},
			);
			maybeFailRetryably();
			if (opts.failFirstStream && streams === 1) {
				return {
					stream: simulateReadableStream({
						chunks: [
							{ type: "stream-start" as const, warnings: [] },
							{
								type: "error" as const,
								error: new Error("upstream connection reset"),
							},
						],
					}),
				};
			}
			return {
				stream: simulateReadableStream({
					chunks: textStreamChunks(opts.text ?? "A final answer."),
				}),
			};
		},
		doGenerate: async (options) => {
			await transport.fetchMock(
				"https://provider.example.com/v1/generate",
				{ signal: options.abortSignal },
			);
			maybeFailRetryably();
			return {
				content: [
					{
						type: "text" as const,
						text: opts.text ?? '{"needsClarification": false}',
					},
				],
				finishReason: { unified: "stop" as const, raw: undefined },
				usage: USAGE,
				warnings: [],
			};
		},
	});
}

function iterationInput(withScope: boolean) {
	return {
		conversationHistory: [
			{
				role: "user" as const,
				content: "Summarize the launch plan.",
				timestamp: "2026-10-01T00:00:00.000Z",
			},
		],
		availableTools: {},
		systemPrompt: "You are a helpful agent.",
		userId: TURN_SCOPE.userId,
		organizationId: TURN_SCOPE.organizationId,
		executionId: TURN_SCOPE.executionId,
		iteration: 1,
		enableSkillTools: false,
		...(withScope ? { turnScope: TURN_SCOPE } : {}),
	};
}

/** Resolves once the transport has seen `count` requests. */
async function waitForRequests(
	transport: ReturnType<typeof createTransport>,
	count: number,
) {
	await vi.waitFor(
		() => {
			expect(transport.requests.length).toBeGreaterThanOrEqual(count);
		},
		{ timeout: 5_000, interval: 10 },
	);
}

function expectTurnNotDispatchable(error: unknown, reason: string) {
	expect(error).toBeInstanceOf(ApplicationFailure);
	const failure = error as ApplicationFailure;
	expect(failure.type).toBe("TurnNotDispatchable");
	expect(failure.nonRetryable).toBe(true);
	expect(failure.details?.[0]).toMatchObject({ reason });
}

beforeEach(() => {
	hoisted.checkDispatchable.mockReset();
	hoisted.checkDispatchable.mockResolvedValue({ ok: true });
	hoisted.delegateToAgent.mockReset();
	hoisted.delegateToAgent.mockResolvedValue({
		response: "delegated",
		durationMs: 1,
	});
});

// ---------------------------------------------------------------------------
// 1. A cancelled activity aborts the in-flight provider request
// ---------------------------------------------------------------------------

describe("a cancelled activity aborts its in-flight provider request", () => {
	it("runAgentIteration: the stream request is aborted and the activity reports cancelled", async () => {
		const transport = createTransport();
		installModel(transport);
		const env = new MockActivityEnvironment();

		const running = env.run(runAgentIteration, iterationInput(true));
		await waitForRequests(transport, 1);
		env.cancel();

		const error = await running.then(
			(value) => ({ resolvedWith: value }),
			(err: unknown) => err,
		);
		expect(transport.requests[0]?.aborted).toBe(true);
		expect(error).toBeInstanceOf(CancelledFailure);
		// One request, no retry after the cancel.
		expect(transport.fetchMock).toHaveBeenCalledTimes(1);
	});

	it("analyzeIntentClarityActivity: the request is aborted and the cancel is not converted into 'proceed without clarification'", async () => {
		const transport = createTransport();
		installModel(transport);
		const env = new MockActivityEnvironment();

		const running = env.run(analyzeIntentClarityActivity, {
			message: "Plan the launch",
			userId: TURN_SCOPE.userId,
			organizationId: TURN_SCOPE.organizationId,
			turnScope: TURN_SCOPE,
		});
		await waitForRequests(transport, 1);
		env.cancel();

		const error = await running.then(
			(value) => ({ resolvedWith: value }),
			(err: unknown) => err,
		);
		expect(transport.requests[0]?.aborted).toBe(true);
		expect(error).toBeInstanceOf(CancelledFailure);
	});

	it("summarizeLargeToolResult: the request is aborted", async () => {
		const transport = createTransport();
		installModel(transport, { text: "summary" });
		const env = new MockActivityEnvironment();

		const running = env.run(summarizeLargeToolResult, {
			toolName: "example_tool",
			toolResult: "x".repeat(1_000),
			userQuery: "launch",
			maxOutputLength: 500,
			userId: TURN_SCOPE.userId,
			organizationId: TURN_SCOPE.organizationId,
			turnScope: TURN_SCOPE,
		});
		await waitForRequests(transport, 1);
		env.cancel();

		const error = await running.then(
			(value) => ({ resolvedWith: value }),
			(err: unknown) => err,
		);
		expect(transport.requests[0]?.aborted).toBe(true);
		expect(error).toBeInstanceOf(CancelledFailure);
	});

	it("compactConversationHistoryActivity: the request is aborted", async () => {
		const transport = createTransport();
		installModel(transport, { text: "PROGRESS SO FAR" });
		const env = new MockActivityEnvironment();

		const running = env.run(compactConversationHistoryActivity, {
			oldTurns: [
				{
					role: "user" as const,
					content: "earlier",
					timestamp: "2026-10-01T00:00:00.000Z",
				},
			],
			currentTask: "Plan the launch",
			userId: TURN_SCOPE.userId,
			organizationId: TURN_SCOPE.organizationId,
			maxSummaryTokens: 200,
			turnScope: TURN_SCOPE,
		});
		await waitForRequests(transport, 1);
		env.cancel();

		const error = await running.then(
			(value) => ({ resolvedWith: value }),
			(err: unknown) => err,
		);
		expect(transport.requests[0]?.aborted).toBe(true);
		expect(error).toBeInstanceOf(CancelledFailure);
	});
});

// ---------------------------------------------------------------------------
// 2. A denied dispatch check makes no request at all
// ---------------------------------------------------------------------------

describe("a denied dispatch check produces zero provider requests", () => {
	it("runAgentIteration: refused before the first stream attempt", async () => {
		const transport = createTransport(5);
		installModel(transport);
		hoisted.checkDispatchable.mockResolvedValue({
			ok: false,
			reason: "cancelled",
		});

		const error = await new MockActivityEnvironment()
			.run(runAgentIteration, iterationInput(true))
			.then(
				(value) => ({ resolvedWith: value }),
				(err: unknown) => err,
			);

		expectTurnNotDispatchable(error, "cancelled");
		expect(transport.fetchMock).not.toHaveBeenCalled();
		expect(hoisted.checkDispatchable).toHaveBeenCalledWith(TURN_SCOPE);
	});

	it("runAgentIteration: refused before the in-activity retry, after one failed attempt", async () => {
		const transport = createTransport(5);
		installModel(transport, { failFirstStream: true });
		hoisted.checkDispatchable
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValue({ ok: false, reason: "cancelled" });

		const error = await new MockActivityEnvironment()
			.run(runAgentIteration, iterationInput(true))
			.then(
				(value) => ({ resolvedWith: value }),
				(err: unknown) => err,
			);

		expectTurnNotDispatchable(error, "cancelled");
		// The first attempt ran; the retry was never sent.
		expect(transport.fetchMock).toHaveBeenCalledTimes(1);
		expect(hoisted.checkDispatchable).toHaveBeenCalledTimes(2);
	});

	it("runAgentIteration: a scope mismatch is refused the same way", async () => {
		const transport = createTransport(5);
		installModel(transport);
		hoisted.checkDispatchable.mockResolvedValue({
			ok: false,
			reason: "scope_mismatch",
		});

		const error = await new MockActivityEnvironment()
			.run(runAgentIteration, iterationInput(true))
			.then(
				(value) => ({ resolvedWith: value }),
				(err: unknown) => err,
			);

		expectTurnNotDispatchable(error, "scope_mismatch");
		expect(transport.fetchMock).not.toHaveBeenCalled();
	});

	it("runAgentIteration: a run without a turnId (a legacy or non-chat run) is not checked", async () => {
		const transport = createTransport(5);
		installModel(transport);

		const result = (await new MockActivityEnvironment().run(
			runAgentIteration,
			iterationInput(false),
		)) as { type: string };

		expect(result.type).toBe("response");
		expect(hoisted.checkDispatchable).not.toHaveBeenCalled();
		expect(transport.fetchMock).toHaveBeenCalledTimes(1);
	});

	it("analyzeIntentClarityActivity: refused, and the refusal is not converted into 'proceed without clarification'", async () => {
		const transport = createTransport(5);
		installModel(transport);
		hoisted.checkDispatchable.mockResolvedValue({
			ok: false,
			reason: "cancelled",
		});

		const error = await new MockActivityEnvironment()
			.run(analyzeIntentClarityActivity, {
				message: "Plan the launch",
				userId: TURN_SCOPE.userId,
				organizationId: TURN_SCOPE.organizationId,
				turnScope: TURN_SCOPE,
			})
			.then(
				(value) => ({ resolvedWith: value }),
				(err: unknown) => err,
			);

		expectTurnNotDispatchable(error, "cancelled");
		expect(transport.fetchMock).not.toHaveBeenCalled();
	});

	it("summarizeLargeToolResult: each chunk is checked, and the refusal stops the rest", async () => {
		const transport = createTransport(5);
		installModel(transport, { text: "chunk summary" });
		// 250,000 characters is three chunks plus a combining pass.
		hoisted.checkDispatchable
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValue({ ok: false, reason: "cancelled" });

		const error = await new MockActivityEnvironment()
			.run(summarizeLargeToolResult, {
				toolName: "example_tool",
				toolResult: "y".repeat(250_000),
				userQuery: "launch",
				maxOutputLength: 4_000,
				userId: TURN_SCOPE.userId,
				organizationId: TURN_SCOPE.organizationId,
				turnScope: TURN_SCOPE,
			})
			.then(
				(value) => ({ resolvedWith: value }),
				(err: unknown) => err,
			);

		expectTurnNotDispatchable(error, "cancelled");
		expect(transport.fetchMock).toHaveBeenCalledTimes(1);
		expect(hoisted.checkDispatchable).toHaveBeenCalledTimes(2);
	});

	it("compactConversationHistoryActivity: refused", async () => {
		const transport = createTransport(5);
		installModel(transport, { text: "PROGRESS SO FAR" });
		hoisted.checkDispatchable.mockResolvedValue({
			ok: false,
			reason: "terminal",
		});

		const error = await new MockActivityEnvironment()
			.run(compactConversationHistoryActivity, {
				oldTurns: [
					{
						role: "user" as const,
						content: "earlier",
						timestamp: "2026-10-01T00:00:00.000Z",
					},
				],
				currentTask: "Plan the launch",
				userId: TURN_SCOPE.userId,
				organizationId: TURN_SCOPE.organizationId,
				maxSummaryTokens: 200,
				turnScope: TURN_SCOPE,
			})
			.then(
				(value) => ({ resolvedWith: value }),
				(err: unknown) => err,
			);

		expectTurnNotDispatchable(error, "terminal");
		expect(transport.fetchMock).not.toHaveBeenCalled();
	});

	it("executeAgentAsTool: refused before the delegated agent is launched", async () => {
		hoisted.checkDispatchable.mockResolvedValue({
			ok: false,
			reason: "cancelled",
		});

		const error = await new MockActivityEnvironment()
			.run(executeAgentAsTool, {
				agentId: "agent-1",
				input: { message: "do the sub-task" },
				userId: TURN_SCOPE.userId,
				organizationId: TURN_SCOPE.organizationId,
				turnScope: TURN_SCOPE,
			})
			.then(
				(value) => ({ resolvedWith: value }),
				(err: unknown) => err,
			);

		expectTurnNotDispatchable(error, "cancelled");
		expect(hoisted.delegateToAgent).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 3. The AI SDK's own retries are guarded too (review round 1, finding 2)
// ---------------------------------------------------------------------------

describe("a retry the AI SDK makes on its own is checked against the turn record", () => {
	/**
	 * The first physical request fails retryably; while it is failing, the
	 * user's Stop is recorded. The SDK then retries by itself — that retry
	 * must be refused before it reaches the provider. Counts PHYSICAL
	 * requests (the transport), not checks.
	 */
	function cancelRecordedDuringFirstFailure() {
		const transport = createTransport(5);
		let cancelled = false;
		hoisted.checkDispatchable.mockImplementation(async () =>
			cancelled ? { ok: false, reason: "cancelled" } : { ok: true },
		);
		return {
			transport,
			onFirstFailure: () => {
				cancelled = true;
			},
		};
	}

	it("analyzeIntentClarityActivity", async () => {
		const { transport, onFirstFailure } =
			cancelRecordedDuringFirstFailure();
		installModel(transport, {
			failFirstRequestRetryably: { onFirstFailure },
		});
		const error = await new MockActivityEnvironment()
			.run(analyzeIntentClarityActivity, {
				message: "Plan the launch",
				userId: TURN_SCOPE.userId,
				organizationId: TURN_SCOPE.organizationId,
				turnScope: TURN_SCOPE,
			})
			.then(
				(value) => ({ resolvedWith: value }),
				(err: unknown) => err,
			);
		expect(transport.fetchMock).toHaveBeenCalledTimes(1);
		expectTurnNotDispatchable(error, "cancelled");
	}, 20_000);

	it("runAgentIteration", async () => {
		const { transport, onFirstFailure } =
			cancelRecordedDuringFirstFailure();
		installModel(transport, {
			failFirstRequestRetryably: { onFirstFailure },
		});
		const error = await new MockActivityEnvironment()
			.run(runAgentIteration, iterationInput(true))
			.then(
				(value) => ({ resolvedWith: value }),
				(err: unknown) => err,
			);
		expect(transport.fetchMock).toHaveBeenCalledTimes(1);
		expectTurnNotDispatchable(error, "cancelled");
	}, 20_000);

	it("summarizeLargeToolResult", async () => {
		const { transport, onFirstFailure } =
			cancelRecordedDuringFirstFailure();
		installModel(transport, {
			text: "summary",
			failFirstRequestRetryably: { onFirstFailure },
		});
		const error = await new MockActivityEnvironment()
			.run(summarizeLargeToolResult, {
				toolName: "example_tool",
				toolResult: "x".repeat(1_000),
				userQuery: "launch",
				maxOutputLength: 500,
				userId: TURN_SCOPE.userId,
				organizationId: TURN_SCOPE.organizationId,
				turnScope: TURN_SCOPE,
			})
			.then(
				(value) => ({ resolvedWith: value }),
				(err: unknown) => err,
			);
		expect(transport.fetchMock).toHaveBeenCalledTimes(1);
		expectTurnNotDispatchable(error, "cancelled");
	}, 20_000);

	it("compactConversationHistoryActivity", async () => {
		const { transport, onFirstFailure } =
			cancelRecordedDuringFirstFailure();
		installModel(transport, {
			text: "PROGRESS SO FAR",
			failFirstRequestRetryably: { onFirstFailure },
		});
		const error = await new MockActivityEnvironment()
			.run(compactConversationHistoryActivity, {
				oldTurns: [
					{
						role: "user" as const,
						content: "earlier",
						timestamp: "2026-10-01T00:00:00.000Z",
					},
				],
				currentTask: "Plan the launch",
				userId: TURN_SCOPE.userId,
				organizationId: TURN_SCOPE.organizationId,
				maxSummaryTokens: 200,
				turnScope: TURN_SCOPE,
			})
			.then(
				(value) => ({ resolvedWith: value }),
				(err: unknown) => err,
			);
		expect(transport.fetchMock).toHaveBeenCalledTimes(1);
		expectTurnNotDispatchable(error, "cancelled");
	}, 20_000);

	it("a run without a turn keeps the SDK's retry (legacy behaviour)", async () => {
		const transport = createTransport(5);
		installModel(transport, {
			text: '{"needsClarification": false}',
			failFirstRequestRetryably: { onFirstFailure: () => undefined },
		});
		const result = (await new MockActivityEnvironment().run(
			analyzeIntentClarityActivity,
			{
				message: "Plan the launch",
				userId: TURN_SCOPE.userId,
				organizationId: TURN_SCOPE.organizationId,
			},
		)) as { needsClarification: boolean };
		expect(transport.fetchMock).toHaveBeenCalledTimes(2);
		expect(result.needsClarification).toBe(false);
		expect(hoisted.checkDispatchable).not.toHaveBeenCalled();
	}, 20_000);
});

// ---------------------------------------------------------------------------
// 4. Every step of a multi-step SDK call is guarded (review round 2,
//    advisory 4) — also when the model arrives as a bare model id
// ---------------------------------------------------------------------------

describe("a Stop recorded between two successful SDK steps stops the next step", () => {
	/**
	 * Step 1 answers with a tool call; the tool runs inside the SDK call and
	 * the user's Stop is recorded while it runs; the SDK would then send
	 * step 2 to the provider within the same invocation. Counts PHYSICAL
	 * requests.
	 */
	async function runTwoStepCall(useModelId: boolean) {
		const { generateText, customProvider, isStepCount, jsonSchema, tool } =
			await import("ai");
		const { guardTurnModel } = await import("../turn-dispatch");
		let physical = 0;
		let cancelled = false;
		hoisted.checkDispatchable.mockImplementation(async () =>
			cancelled ? { ok: false, reason: "cancelled" } : { ok: true },
		);
		const mockModel = new MockLanguageModelV4({
			doGenerate: async () => {
				physical++;
				return physical === 1
					? {
							content: [
								{
									type: "tool-call" as const,
									toolCallId: "call-1",
									toolName: "lookup",
									input: "{}",
								},
							],
							finishReason: {
								unified: "tool-calls" as const,
								raw: undefined,
							},
							usage: USAGE,
							warnings: [],
						}
					: {
							content: [{ type: "text" as const, text: "done" }],
							finishReason: {
								unified: "stop" as const,
								raw: undefined,
							},
							usage: USAGE,
							warnings: [],
						};
			},
		});
		const previous = (globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown })
			.AI_SDK_DEFAULT_PROVIDER;
		(
			globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }
		).AI_SDK_DEFAULT_PROVIDER = customProvider({
			languageModels: { "example-model": mockModel },
		});
		try {
			const guarded = guardTurnModel(
				useModelId ? "example-model" : mockModel,
				TURN_SCOPE,
			);
			const outcome = await generateText({
				...guarded,
				prompt: "Look it up",
				stopWhen: isStepCount(3),
				tools: {
					lookup: tool({
						description: "Look something up",
						inputSchema: jsonSchema({
							type: "object",
							properties: {},
						}),
						execute: async () => {
							cancelled = true;
							return "result";
						},
					}),
				},
			}).then(
				(value) => ({ resolvedWith: value.text }),
				(err: unknown) => err,
			);
			return { physical, outcome };
		} finally {
			(
				globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown }
			).AI_SDK_DEFAULT_PROVIDER = previous;
		}
	}

	it("with a model object", async () => {
		const { physical, outcome } = await runTwoStepCall(false);
		expect(physical).toBe(1);
		expect(outcome).not.toHaveProperty("resolvedWith");
	});

	it("with a bare model id (resolved to a model before it is guarded)", async () => {
		const { physical, outcome } = await runTwoStepCall(true);
		expect(physical).toBe(1);
		expect(outcome).not.toHaveProperty("resolvedWith");
	});
});
