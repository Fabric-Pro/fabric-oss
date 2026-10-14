/**
 * The token ledger's `TurnBudgetExhausted` refusal leaves every model-calling
 * activity of a turn as that non-retryable failure — never as the fallback
 * result its catch would otherwise produce.
 *
 * Each activity runs inside the turn's ambient guard (as the activity
 * interceptor installs it) with a factory-wrapped model (dispatch guard +
 * turn-budget middleware), and the ledger refuses the request. The catches
 * under test are the ones that turn other failures into an answer:
 *  - the round (runAgentIteration): an `error` stream part → `stream_error`;
 *  - the up-front clarity check: any failure → "proceed without
 *    clarification";
 *  - compaction: any failure → the workflow continues uncompacted;
 *  - the tool-result summarizer: a provider limit → wait and retry.
 */

import { wrapModelWithDispatchGuard } from "@repo/ai/lib/dispatch-guard-middleware";
import { wrapModelWithTurnBudget } from "@repo/ai/lib/turn-budget-middleware";
import { ApplicationFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	model: { current: undefined as unknown },
	reserve: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	checkConversationTurnDispatchable: vi.fn(async () => ({ ok: true })),
	reserveConversationTurnAttempt: hoisted.reserve,
	settleConversationTurnAttempt: vi.fn(async () => ({
		outcome: "settled",
		status: "UNKNOWN",
	})),
	getConversationTurnLedgerSnapshot: vi.fn(async () => null),
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
		canonicalName: "example-model",
	})),
}));

import { analyzeIntentClarityActivity } from "../clarification";
import { compactConversationHistoryActivity } from "../execution/compact-conversation";
import { runAgentIteration } from "../execution/run-agent-iteration";
import { summarizeLargeToolResult } from "../execution/summarize-tool-result";
import { runWithTurnDispatch, TURN_BUDGET_EXHAUSTED } from "../turn-dispatch";

const SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-00000000-0000-4000-8000-000000000001",
	userId: "user-example-1",
	organizationId: "org-example-1",
	generation: 1,
	budgetContractVersion: 1,
};

const SNAPSHOT = {
	contractVersion: 1,
	allowance: 100_000,
	finalizationReserve: 8_000,
	measured: 92_000,
	outstanding: 0,
	enforcement: "ENFORCED" as const,
};

let providerRequests = 0;

beforeEach(() => {
	providerRequests = 0;
	hoisted.reserve.mockReset().mockResolvedValue({
		outcome: "exhausted",
		snapshot: SNAPSHOT,
		room: 0,
		needed: 5_000,
	});
	hoisted.model.current = wrapModelWithDispatchGuard(
		wrapModelWithTurnBudget(
			new MockLanguageModelV4({
				doGenerate: async () => {
					providerRequests++;
					throw new Error("the provider must not be called");
				},
				doStream: async () => {
					providerRequests++;
					throw new Error("the provider must not be called");
				},
			}),
			{ enforcesOutputCap: true },
		),
	);
});

/** Runs `activity` as the interceptor would: inside the turn's guard. */
function runInTurn<I, O>(
	activity: (input: I) => Promise<O>,
	input: I,
	attemptKind?: "EXPLORATION" | "FINALIZATION",
): Promise<unknown> {
	return runWithTurnDispatch(
		SCOPE,
		() =>
			new MockActivityEnvironment().run(
				activity as (input: unknown) => Promise<O>,
				input,
			),
		{ attemptKind },
	).then(
		(value) => ({ resolvedWith: value }),
		(error: unknown) => error,
	);
}

function expectBudgetRefusal(outcome: unknown) {
	expect(outcome).toBeInstanceOf(ApplicationFailure);
	expect((outcome as ApplicationFailure).type).toBe(TURN_BUDGET_EXHAUSTED);
	expect((outcome as ApplicationFailure).nonRetryable).toBe(true);
	expect(providerRequests).toBe(0);
}

describe("a budget refusal is never converted into a fallback result", () => {
	it("runAgentIteration (the round and the synthesis)", async () => {
		const outcome = await runInTurn(
			runAgentIteration,
			{
				conversationHistory: [
					{
						role: "user" as const,
						content: "Summarize the launch plan.",
						timestamp: "2026-10-01T00:00:00.000Z",
					},
				],
				availableTools: {},
				systemPrompt: "You are a helpful agent.",
				userId: SCOPE.userId,
				organizationId: SCOPE.organizationId,
				executionId: SCOPE.executionId,
				iteration: 1,
				enableSkillTools: false,
				turnScope: SCOPE,
				budgetAttemptKind: "EXPLORATION" as const,
			},
			"EXPLORATION",
		);
		expectBudgetRefusal(outcome);
		expect(hoisted.reserve.mock.calls[0]?.[0]).toMatchObject({
			kind: "EXPLORATION",
		});
	});

	it("analyzeIntentClarityActivity: not 'proceed without clarification'", async () => {
		const outcome = await runInTurn(analyzeIntentClarityActivity, {
			message: "Plan the launch",
			userId: SCOPE.userId,
			organizationId: SCOPE.organizationId,
			turnScope: SCOPE,
		});
		expectBudgetRefusal(outcome);
		expect(hoisted.reserve.mock.calls[0]?.[0]).toMatchObject({
			kind: "AUXILIARY",
		});
	});

	it("compactConversationHistoryActivity: not 'continue uncompacted'", async () => {
		const outcome = await runInTurn(compactConversationHistoryActivity, {
			oldTurns: [
				{
					role: "user" as const,
					content: "earlier",
					timestamp: "2026-10-01T00:00:00.000Z",
				},
			],
			currentTask: "Plan the launch",
			userId: SCOPE.userId,
			organizationId: SCOPE.organizationId,
			maxSummaryTokens: 200,
			turnScope: SCOPE,
		});
		expectBudgetRefusal(outcome);
	});

	it("summarizeLargeToolResult: not waited out and retried", async () => {
		const outcome = await runInTurn(summarizeLargeToolResult, {
			toolName: "example_tool",
			toolResult: "y".repeat(250_000),
			userQuery: "launch",
			maxOutputLength: 4_000,
			userId: SCOPE.userId,
			organizationId: SCOPE.organizationId,
			turnScope: SCOPE,
		});
		expectBudgetRefusal(outcome);
		// The first chunk's refusal ends the summary: no further chunk asks.
		expect(hoisted.reserve).toHaveBeenCalledTimes(1);
	});
});
