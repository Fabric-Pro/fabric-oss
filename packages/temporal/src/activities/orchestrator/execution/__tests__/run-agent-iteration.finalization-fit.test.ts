/**
 * The finalization synthesis of a ledgered turn fits the room its ledger has
 * left.
 *
 * The ledger holds 8,000 tokens back for the answer, but the synthesis was
 * sent as built for the whole run: the compacted conversation plus a
 * 16,384-token output request. At a budget stop that never fit, the ledger
 * refused it, and the user got the static summary instead of an answer.
 *
 * Real `runAgentIteration`, real AI SDK `streamText`, the real factory
 * middleware (dispatch guard and turn budget) under the real turn guard
 * (`runWithTurnDispatch`), and an in-memory ledger whose admission is the
 * ledger's own arithmetic (`planConversationTurnReservation`, the function
 * `reserveConversationTurnAttempt` runs under the row lock). Only the
 * provider and the database rows are stand-ins.
 *
 * Pins:
 *  - a budget stop with a large history: the request's input estimate plus
 *    its output cap fits the room; the FINALIZATION attempt is reserved and
 *    settled, not refused; the result is the model's answer;
 *  - a room below the smallest bounded request: nothing is reserved or
 *    sent, and the round leaves as a FINALIZATION `TurnBudgetExhausted`;
 *  - a room the full synthesis fits: the request is sent as built;
 *  - a second synthesis call is sized to the room left after the first
 *    settled, or not sent when that is below the smallest request;
 *  - the in-activity retry after a failed send is sized again;
 *  - at the boundary (room exactly the planned request) the real
 *    middleware's reservation admits the request with the planned cap;
 *  - a round without FINALIZATION, or a scope without the contract, is sent
 *    exactly as before.
 */

import { estimateLanguageRequestInputTokens } from "@repo/ai/lib/turn-budget-estimate";
import { ApplicationFailure } from "@temporalio/common";
import { wrapLanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/ai", async () => {
	const ai = await import("ai");
	return {
		streamText: ai.streamText,
		tool: ai.tool,
		jsonSchema: ai.jsonSchema,
		isStepCount: ai.isStepCount,
	};
});
vi.mock("@repo/ai/limits", () => ({
	classifyLimitError: vi.fn(() => null),
}));
vi.mock("@repo/ai/skills", () => ({
	listAvailableSkills: vi.fn(async () => []),
	createSkillTools: vi.fn(() => ({})),
	buildSkillsSystemBlock: vi.fn(() => ""),
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@temporalio/activity", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	heartbeat: vi.fn(),
}));
vi.mock("../../../../lib/redis-publisher", () => ({
	publishExecutionEvent: vi.fn(),
}));

interface Attempt {
	id: string;
	kind: string;
	inputEstimate: number;
	requestedOutputTokens: number;
	reservedTokens: number;
	outputCap: number | null;
	/** The room this attempt's kind had when it reserved. */
	roomAtReserve: number;
	status: "RESERVED" | "SETTLED" | "UNKNOWN" | "RELEASED";
}

const store = vi.hoisted(() => ({
	ledger: {
		allowance: 100_000,
		finalizationReserve: 8_000,
		measured: 0,
		outstanding: 0,
	},
	attempts: [] as Attempt[],
	refusals: [] as Array<{ kind: string; room: number; needed: number }>,
	snapshotReads: 0,
}));

vi.mock("@repo/database", async () => {
	const room = await import(
		"@repo/database/prisma/queries/lib/conversation-turn-room"
	);
	const snapshot = () => ({
		contractVersion: 1,
		...store.ledger,
		enforcement: "ENFORCED" as const,
	});
	return {
		conversationTurnRoom: room.conversationTurnRoom,
		checkConversationTurnDispatchable: vi.fn(async () => ({ ok: true })),
		getConversationTurnLedgerSnapshot: vi.fn(async () => {
			store.snapshotReads += 1;
			return snapshot();
		}),
		reserveConversationTurnAttempt: vi.fn(
			async (input: {
				kind: string;
				inputEstimate: number;
				requestedOutputTokens: number;
				minOutputTokens: number;
				enforced: boolean;
			}) => {
				const plan = room.planConversationTurnReservation({
					totals: store.ledger,
					kind: input.kind as "FINALIZATION",
					inputEstimate: input.inputEstimate,
					requestedOutputTokens: input.requestedOutputTokens,
					minOutputTokens: input.minOutputTokens,
					enforced: input.enforced,
				});
				if (plan.outcome === "exhausted") {
					store.refusals.push({
						kind: input.kind,
						room: plan.room,
						needed: plan.needed,
					});
					return {
						outcome: "exhausted",
						snapshot: snapshot(),
						room: plan.room,
						needed: plan.needed,
					};
				}
				const attempt: Attempt = {
					id: `attempt-${store.attempts.length + 1}`,
					kind: input.kind,
					inputEstimate: input.inputEstimate,
					requestedOutputTokens: input.requestedOutputTokens,
					reservedTokens: plan.reservedTokens,
					outputCap: plan.outputCap,
					roomAtReserve: room.conversationTurnRoom(
						store.ledger,
						input.kind as "FINALIZATION",
					),
					status: "RESERVED",
				};
				store.attempts.push(attempt);
				store.ledger.outstanding += plan.reservedTokens;
				return {
					outcome: "reserved",
					attemptId: attempt.id,
					reservedTokens: plan.reservedTokens,
					outputCap: plan.outputCap,
				};
			},
		),
		settleConversationTurnAttempt: vi.fn(
			async (args: {
				attemptId: string;
				settlement:
					| {
							status: "SETTLED";
							inputTokens: number;
							outputTokens: number;
					  }
					| { status: "UNKNOWN" | "RELEASED" };
			}) => {
				const attempt = store.attempts.find(
					(a) => a.id === args.attemptId,
				);
				if (!attempt || attempt.status !== "RESERVED") {
					return { outcome: "not_found" };
				}
				const { settlement } = args;
				attempt.status = settlement.status;
				if (settlement.status === "SETTLED") {
					store.ledger.measured +=
						settlement.inputTokens + settlement.outputTokens;
					store.ledger.outstanding -= attempt.reservedTokens;
				} else if (settlement.status === "RELEASED") {
					store.ledger.outstanding -= attempt.reservedTokens;
				}
				return { outcome: "settled", status: settlement.status };
			},
		),
	};
});

const provider = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("../../utils", () => ({
	getAiModelWithSelection: vi.fn(async () => ({
		model: provider.current,
		canonicalName: "example-model",
	})),
}));

import { wrapModelWithDispatchGuard } from "@repo/ai/lib/dispatch-guard-middleware";
import { wrapModelWithTurnBudget } from "@repo/ai/lib/turn-budget-middleware";
import type { IterativeMessage } from "../../../../workflows/orchestrator/types";
import {
	runWithTurnDispatch,
	TURN_BUDGET_EXHAUSTED,
} from "../../turn-dispatch";
import { FINALIZATION_FIT, planFinalizationRequest } from "../finalization-fit";
import {
	type RunAgentIterationInput,
	runAgentIteration,
} from "../run-agent-iteration";

const SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
	generation: 1,
	budgetContractVersion: 1,
};

const QUESTION = "Which services read the launch flag, and is it enabled?";
const SYSTEM_PROMPT = `You are writing the FINAL response. ${"Use the headers verbatim. ".repeat(40)}`;
const ANSWER = `## Summary\nThe launch flag is enabled. ${"It is read in src/service-7.ts. ".repeat(12)}`;

interface SentRequest {
	prompt: Array<{ role: string; content: unknown }>;
	maxOutputTokens?: number;
	tools?: unknown[];
}

/**
 * A provider that answers every send, recording what it was sent.
 * `enforcesOutputCap: false` is a model that cannot be capped (the ChatGPT
 * plan: MEASURED_ONLY). `fallback` puts the answering model behind a primary
 * physical model that refuses the model as unsupported, with the plan's
 * model-fallback shape around them: the same request is resent through the
 * second physical model, each carrying its own turn-budget middleware.
 */
function answeringProvider(
	options: {
		answer?: string;
		failFirst?: boolean;
		enforcesOutputCap?: boolean;
		fallback?: boolean;
	} = {},
) {
	const sent: SentRequest[] = [];
	const enforcesOutputCap = options.enforcesOutputCap ?? true;
	const model = new MockLanguageModelV4({
		doStream: async (params) => {
			sent.push(params as unknown as SentRequest);
			if (options.failFirst && sent.length === 1) {
				return {
					stream: simulateReadableStream({
						chunks: [
							{ type: "stream-start", warnings: [] },
							{ type: "error", error: new Error("gateway 502") },
						],
					}) as ReadableStream<never>,
				};
			}
			const text = options.answer ?? ANSWER;
			return {
				stream: simulateReadableStream({
					chunks: [
						{ type: "stream-start", warnings: [] },
						{ type: "text-start", id: "t1" },
						{ type: "text-delta", id: "t1", delta: text },
						{ type: "text-end", id: "t1" },
						{
							type: "finish",
							finishReason: { unified: "stop", raw: undefined },
							usage: {
								inputTokens: {
									total: 2_500,
									noCache: 2_500,
									cacheRead: 0,
									cacheWrite: 0,
								},
								outputTokens: {
									total: 600,
									text: 600,
									reasoning: 0,
								},
							},
						},
					],
				}) as ReadableStream<never>,
			};
		},
	});
	const answering = wrapModelWithTurnBudget(model, { enforcesOutputCap });
	if (!options.fallback) {
		provider.current = wrapModelWithDispatchGuard(answering);
		return sent;
	}
	const primary = wrapModelWithTurnBudget(
		new MockLanguageModelV4({
			doStream: async (params) => {
				sent.push(params as unknown as SentRequest);
				throw new Error("The model is not supported on this plan.");
			},
		}),
		{ enforcesOutputCap },
	);
	provider.current = wrapModelWithDispatchGuard(
		wrapLanguageModel({
			model: primary as unknown as MockLanguageModelV4,
			middleware: {
				specificationVersion: "v4",
				wrapStream: async ({ doStream, params }) => {
					try {
						return await doStream();
					} catch {
						return (
							answering as unknown as MockLanguageModelV4
						).doStream(params);
					}
				},
			},
		}),
	);
	return sent;
}

/** A turn with `results` tool results of `chars` characters each. */
function largeHistory(results = 12, chars = 6_000): IterativeMessage[] {
	const history: IterativeMessage[] = [
		{ role: "user", content: QUESTION, timestamp: "2026-01-01" },
	];
	for (let i = 0; i < results; i++) {
		history.push({
			role: "assistant",
			content: "",
			toolCalls: [
				{
					id: `call-${i}`,
					name: "example_get_file",
					args: { path: `src/service-${i}.ts` },
				},
			],
			timestamp: "2026-01-01",
			iteration: i + 1,
		});
		history.push({
			role: "tool",
			toolCallId: `call-${i}`,
			content:
				`// src/service-${i}.ts\n${"export const readsLaunchFlag = true; ".repeat(Math.ceil(chars / 38))}`.slice(
					0,
					chars,
				),
			timestamp: "2026-01-01",
			iteration: i + 1,
		});
	}
	return history;
}

function finalizationInput(
	history: IterativeMessage[],
	overrides: Partial<RunAgentIterationInput> = {},
): RunAgentIterationInput {
	return {
		conversationHistory: history,
		availableTools: {},
		systemPrompt: SYSTEM_PROMPT,
		userId: SCOPE.userId,
		organizationId: SCOPE.organizationId,
		executionId: SCOPE.executionId,
		iteration: 7,
		maxStepsPerIteration: 1,
		enableSkillTools: false,
		turnScope: SCOPE,
		budgetAttemptKind: "FINALIZATION",
		finalizationQuestion: QUESTION,
		...overrides,
	};
}

function run(input: RunAgentIterationInput) {
	return runWithTurnDispatch(
		input.turnScope,
		() => runAgentIteration(input),
		{
			attemptKind: input.budgetAttemptKind,
		},
	);
}

/** Sets the ledger so a FINALIZATION reservation finds exactly `room`. */
function ledgerWithFinalizationRoom(room: number) {
	store.ledger.allowance = 100_000;
	store.ledger.finalizationReserve = 8_000;
	store.ledger.outstanding = 0;
	store.ledger.measured = 100_000 - room;
}

function finalizationRoom(): number {
	return (
		store.ledger.allowance -
		store.ledger.measured -
		store.ledger.outstanding
	);
}

function userText(request: SentRequest): string {
	const user = request.prompt.find((m) => m.role === "user");
	const content = user?.content as Array<{ text?: string }> | undefined;
	return content?.map((part) => part.text ?? "").join("") ?? "";
}

beforeEach(() => {
	store.attempts = [];
	store.refusals = [];
	store.snapshotReads = 0;
	ledgerWithFinalizationRoom(8_500);
});

describe("the finalization synthesis of a ledgered turn", () => {
	it("at a budget stop with a large history, fits the room, is reserved and settled, and returns the model's answer", async () => {
		const history = largeHistory();
		const sent = answeringProvider();
		const room = finalizationRoom();

		const result = await run(finalizationInput(history));

		expect(result).toMatchObject({ type: "response", content: ANSWER });
		expect(store.refusals).toEqual([]);
		expect(store.attempts).toHaveLength(1);
		const [attempt] = store.attempts;
		expect(attempt).toMatchObject({
			kind: "FINALIZATION",
			status: "SETTLED",
		});
		// The request as sent: estimated input plus output cap within the room.
		expect(sent).toHaveLength(1);
		const request = sent[0] as SentRequest;
		expect(attempt?.inputEstimate).toBe(
			estimateLanguageRequestInputTokens({ prompt: request.prompt }),
		);
		expect(
			(attempt?.inputEstimate ?? 0) + (request.maxOutputTokens ?? 0),
		).toBeLessThanOrEqual(room);
		expect(request.maxOutputTokens).toBe(FINALIZATION_FIT.outputTokens);
		// The cap the ledger granted is the one asked for, not lowered.
		expect(attempt?.outputCap).toBe(request.maxOutputTokens);
		// Bounded: no tools; the system prompt and one user message that
		// keeps the request and the newest finding.
		expect(request.tools ?? []).toEqual([]);
		expect(request.prompt.map((m) => m.role)).toEqual(["system", "user"]);
		expect(userText(request)).toContain(QUESTION);
		expect(userText(request)).toContain("src/service-11.ts");
		expect(userText(request)).toMatch(/item\(s\) were left out to fit/);
	});

	it("below the smallest bounded request, reserves and sends nothing and refuses as FINALIZATION", async () => {
		const sent = answeringProvider();
		ledgerWithFinalizationRoom(1_500);

		const error = await run(finalizationInput(largeHistory())).catch(
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(ApplicationFailure);
		const failure = error as ApplicationFailure;
		expect(failure.type).toBe(TURN_BUDGET_EXHAUSTED);
		expect(failure.nonRetryable).toBe(true);
		expect(failure.details?.[0]).toMatchObject({
			kind: "FINALIZATION",
			room: 1_500,
			snapshot: { allowance: 100_000, measured: 98_500 },
		});
		expect(store.attempts).toEqual([]);
		expect(store.refusals).toEqual([]);
		expect(sent).toEqual([]);
	});

	it("sends the full synthesis unchanged when it fits the room", async () => {
		const history = largeHistory(3, 2_000);
		const sent = answeringProvider();
		ledgerWithFinalizationRoom(60_000);

		const result = await run(finalizationInput(history));

		expect(result).toMatchObject({ type: "response", content: ANSWER });
		const request = sent[0] as SentRequest;
		// System prompt plus the whole conversation, with its tool calls.
		expect(request.prompt).toHaveLength(1 + history.length);
		expect(request.prompt.some((m) => m.role === "tool")).toBe(true);
		expect(store.attempts[0]).toMatchObject({
			kind: "FINALIZATION",
			requestedOutputTokens: 16_384,
			outputCap: 16_384,
			status: "SETTLED",
		});
	});

	it("sizes a second synthesis call to the room left after the first settled", async () => {
		const history = largeHistory();
		const sent = answeringProvider({ answer: "Task completed." });
		ledgerWithFinalizationRoom(12_000);

		await run(finalizationInput(history));
		const roomForSecond = finalizationRoom();
		await run(
			finalizationInput(history, {
				iteration: 8,
				systemPrompt: `${SYSTEM_PROMPT}\n\nRETRY NOTE: answer in full.`,
			}),
		);

		expect(store.refusals).toEqual([]);
		expect(store.attempts.map((a) => a.status)).toEqual([
			"SETTLED",
			"SETTLED",
		]);
		const second = store.attempts[1] as Attempt;
		expect(second.kind).toBe("FINALIZATION");
		expect(second.reservedTokens).toBeLessThanOrEqual(roomForSecond);
		expect(
			second.inputEstimate +
				((sent[1] as SentRequest).maxOutputTokens ?? 0),
		).toBeLessThanOrEqual(roomForSecond);
	});

	it("does not send a second synthesis call when the room left is below the smallest request", async () => {
		const history = largeHistory();
		const sent = answeringProvider({ answer: "Task completed." });
		// The first call fits; what it uses leaves too little for another.
		ledgerWithFinalizationRoom(4_500);

		await run(finalizationInput(history));
		const error = await run(
			finalizationInput(history, { iteration: 8 }),
		).catch((caught: unknown) => caught);

		expect((error as ApplicationFailure).type).toBe(TURN_BUDGET_EXHAUSTED);
		expect(store.attempts).toHaveLength(1);
		expect(store.refusals).toEqual([]);
		expect(sent).toHaveLength(1);
	});

	it("sizes the in-activity retry after a failed send to the room that failed send left", async () => {
		const history = largeHistory();
		const sent = answeringProvider({ failFirst: true });
		ledgerWithFinalizationRoom(30_000);

		const result = await run(finalizationInput(history));

		expect(result).toMatchObject({ type: "response", content: ANSWER });
		expect(store.refusals).toEqual([]);
		// One send per attempt: an error after the stream started is not one
		// the SDK retries; the activity's own retry sent the second.
		expect(sent).toHaveLength(2);
		expect(store.attempts.map((a) => a.status)).toEqual([
			"UNKNOWN",
			"SETTLED",
		]);
		const [first, second] = store.attempts as [Attempt, Attempt];
		// The failed send stays charged at its reservation, and the retry fit
		// what was left.
		expect(second.reservedTokens).toBeLessThanOrEqual(
			30_000 - first.reservedTokens,
		);
	});

	it("is admitted by the middleware's reservation at the boundary: a room of exactly the planned request", async () => {
		const history = largeHistory();
		// The plan for a 9,000-token room, as the activity would build it.
		const fullMessagesPlan = await planFinalizationRequest({
			room: 9_000,
			instructions: SYSTEM_PROMPT,
			fullMessages: [{ role: "user", content: "x".repeat(200_000) }],
			fullMaxOutputTokens: 16_384,
			history,
			question: QUESTION,
		});
		expect(fullMessagesPlan.kind).toBe("bounded");
		if (fullMessagesPlan.kind !== "bounded") {
			return;
		}
		const need =
			fullMessagesPlan.inputEstimate + fullMessagesPlan.maxOutputTokens;
		expect(need).toBeLessThanOrEqual(9_000);

		for (const room of [need, need - 1]) {
			store.attempts = [];
			store.refusals = [];
			ledgerWithFinalizationRoom(room);
			const sent = answeringProvider();

			await run(finalizationInput(history));

			expect(store.refusals).toEqual([]);
			const attempt = store.attempts[0] as Attempt;
			const request = sent[0] as SentRequest;
			expect(
				attempt.inputEstimate + (attempt.outputCap ?? Number.NaN),
			).toBeLessThanOrEqual(room);
			expect(attempt.outputCap).toBe(request.maxOutputTokens);
			if (room === need) {
				// The same request the plan declared fitting, admitted whole.
				expect(attempt.inputEstimate).toBe(
					fullMessagesPlan.inputEstimate,
				);
				expect(attempt.outputCap).toBe(
					fullMessagesPlan.maxOutputTokens,
				);
				expect(userText(request)).toBe(
					(fullMessagesPlan.messages[0] as { content: string })
						.content,
				);
			}
		}
	});

	it("leaves an EXPLORATION round, and a scope without the contract, as built", async () => {
		const history = largeHistory(3, 2_000);
		const sent = answeringProvider();
		ledgerWithFinalizationRoom(60_000);

		await run(
			finalizationInput(history, { budgetAttemptKind: "EXPLORATION" }),
		);
		const {
			budgetContractVersion: _contract,
			generation: _generation,
			...legacyScope
		} = SCOPE;
		await run(finalizationInput(history, { turnScope: legacyScope }));

		for (const request of sent) {
			expect(request.prompt).toHaveLength(1 + history.length);
			expect(request.maxOutputTokens).toBe(16_384);
		}
		// The EXPLORATION round was reserved as before (no finalization room
		// read before it); the legacy scope reserves nothing.
		expect(store.attempts).toHaveLength(1);
		expect(store.attempts[0]?.kind).toBe("EXPLORATION");
	});
	it("reserves no more than the room for a model that cannot be capped, when the full synthesis fits", async () => {
		const history = largeHistory(3, 2_000);
		const sent = answeringProvider({ enforcesOutputCap: false });
		ledgerWithFinalizationRoom(8_000);

		const result = await run(finalizationInput(history));

		expect(result).toMatchObject({ type: "response", content: ANSWER });
		expect(store.refusals).toEqual([]);
		const attempt = store.attempts[0] as Attempt;
		// Sent as built (the whole conversation), with the output allowance
		// the plan validated, which is also what is reserved.
		expect((sent[0] as SentRequest).prompt).toHaveLength(
			1 + history.length,
		);
		expect(attempt.outputCap).toBeNull();
		expect(attempt.requestedOutputTokens).toBe(
			8_000 - attempt.inputEstimate,
		);
		expect(attempt.reservedTokens).toBeLessThanOrEqual(8_000);
	});

	it("reserves no more than the room for a model that cannot be capped, when the synthesis is bounded", async () => {
		answeringProvider({ enforcesOutputCap: false });
		ledgerWithFinalizationRoom(8_500);

		await run(finalizationInput(largeHistory()));

		const attempt = store.attempts[0] as Attempt;
		expect(attempt.requestedOutputTokens).toBe(
			FINALIZATION_FIT.outputTokens,
		);
		expect(attempt.reservedTokens).toBeLessThanOrEqual(8_500);
	});

	it("sizes a provider's resend through another physical model to the room the refused send left", async () => {
		// The full synthesis fits at first; the primary model refuses it
		// after it was sent (charged, UNKNOWN), and the provider resends the
		// request through its fallback model.
		const history = largeHistory(6, 6_000);
		const sent = answeringProvider({
			enforcesOutputCap: false,
			fallback: true,
		});
		// The full request (~15,000 input + 16,384 output) fits and leaves
		// about 8,000 for the resend.
		ledgerWithFinalizationRoom(40_000);

		const result = await run(finalizationInput(history));

		expect(result).toMatchObject({ type: "response", content: ANSWER });
		expect(store.refusals).toEqual([]);
		expect(sent).toHaveLength(2);
		expect(store.attempts.map((a) => a.status)).toEqual([
			"UNKNOWN",
			"SETTLED",
		]);
		for (const attempt of store.attempts) {
			expect(attempt.reservedTokens).toBeLessThanOrEqual(
				attempt.roomAtReserve,
			);
		}
		// The first send was the whole conversation; the resend is the
		// bounded request that fits what the first left.
		expect((sent[0] as SentRequest).prompt).toHaveLength(
			1 + history.length,
		);
		expect((sent[1] as SentRequest).prompt.map((m) => m.role)).toEqual([
			"system",
			"user",
		]);
	});

	it("keeps the user's whole request, with its last constraint, when the room allows", async () => {
		const constraint =
			"Only report database services; exclude web services.";
		const question = `${"Background on how our services read flags. ".repeat(120)}${constraint}`;
		expect(question.length).toBeGreaterThan(5_000);
		const sent = answeringProvider();
		ledgerWithFinalizationRoom(8_000);

		await run(
			finalizationInput(largeHistory(), {
				finalizationQuestion: question,
			}),
		);

		expect(store.refusals).toEqual([]);
		const text = userText(sent[0] as SentRequest);
		expect(text).toContain(question);
		const attempt = store.attempts[0] as Attempt;
		expect(attempt.reservedTokens).toBeLessThanOrEqual(8_000);
	});

	it("keeps the head and tail of a request too long for the room, and refuses only below the shortest", async () => {
		const constraint =
			"Only report database services; exclude web services.";
		const question = `Which services read the launch flag? ${"Pasted background. ".repeat(1_600)}${constraint}`;
		const sent = answeringProvider();
		ledgerWithFinalizationRoom(8_000);

		await run(
			finalizationInput(largeHistory(), {
				finalizationQuestion: question,
			}),
		);

		const text = userText(sent[0] as SentRequest);
		expect(text).toContain("Which services read the launch flag?");
		expect(text).toContain(constraint);
		expect(text).toMatch(/characters of the request left out here/);
		expect(store.attempts[0]?.reservedTokens).toBeLessThanOrEqual(8_000);

		// A room that cannot hold even the shortest head and tail.
		store.attempts = [];
		ledgerWithFinalizationRoom(1_400);
		const error = await run(
			finalizationInput(largeHistory(), {
				finalizationQuestion: question,
			}),
		).catch((caught: unknown) => caught);
		expect((error as ApplicationFailure).type).toBe(TURN_BUDGET_EXHAUSTED);
		expect(store.attempts).toEqual([]);
	});
});
