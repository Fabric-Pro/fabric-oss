/**
 * runAgentIteration's token accounting for a ledgered turn.
 *
 * Before the ledger, an attempt whose usage the SDK could not report
 * (`stream.usage` rejected) added 0 to the round's usage, and a round that
 * threw after an earlier attempt reported a flat `{ 0, 0 }`, so the
 * workflow's budget never saw those tokens. Pins:
 *  - a round with an unreadable attempt says so (`usageUnknown`) instead of
 *    passing the gap off as zero, and reports what the other attempts did
 *    report;
 *  - a round that throws after an earlier attempt keeps that attempt's
 *    usage;
 *  - a ledgered round returns the ledger reading taken after its requests
 *    settled (the conservative charge sits in `outstanding`, never in
 *    `usage`);
 *  - the ledger's `TurnBudgetExhausted` refusal arriving as a stream error
 *    part leaves the activity as that non-retryable failure, never as a
 *    `stream_error` result.
 */

import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const aiStubs = vi.hoisted(() => ({
	streamTextMock: vi.fn(),
	toolMock: vi.fn((definition: { description?: string }) => ({
		description: definition?.description,
	})),
	jsonSchemaMock: vi.fn((schema: unknown) => ({ schema })),
	isStepCountMock: vi.fn((n: number) => ({ n })),
}));

const db = vi.hoisted(() => ({
	snapshot: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	streamText: aiStubs.streamTextMock,
	tool: aiStubs.toolMock,
	jsonSchema: aiStubs.jsonSchemaMock,
	isStepCount: aiStubs.isStepCountMock,
}));
vi.mock("@repo/ai/limits", () => ({
	classifyLimitError: vi.fn(() => null),
}));
vi.mock("@repo/ai/skills", () => ({
	listAvailableSkills: vi.fn(async () => []),
	createSkillTools: vi.fn(() => ({})),
	buildSkillsSystemBlock: vi.fn(() => ""),
}));
vi.mock("@temporalio/activity", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	heartbeat: vi.fn(),
}));
vi.mock("../../../../lib/redis-publisher", () => ({
	publishExecutionEvent: vi.fn(),
}));
vi.mock("../../utils", () => ({
	getAiModelWithSelection: vi.fn(async () => ({
		model: { __mockModel: true },
		canonicalName: "example-model",
		planSpentApiBilling: () => undefined,
	})),
}));
vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: vi.fn(async () => ({ ok: true })),
	getConversationTurnLedgerSnapshot: db.snapshot,
	reserveConversationTurnAttempt: vi.fn(),
	settleConversationTurnAttempt: vi.fn(),
}));

import {
	type RunAgentIterationInput,
	runAgentIteration,
} from "../run-agent-iteration";

const LEDGERED_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
	generation: 1,
	budgetContractVersion: 1,
};

function stream(opts: {
	parts?: Array<Record<string, unknown>>;
	usage?: { inputTokens?: number; outputTokens?: number };
	usageError?: unknown;
	finishReason?: string;
}) {
	return {
		stream: (async function* () {
			for (const part of opts.parts ?? []) {
				yield part;
			}
		})(),
		usage:
			opts.usageError !== undefined
				? Promise.reject(opts.usageError)
				: Promise.resolve(
						opts.usage ?? { inputTokens: 10, outputTokens: 5 },
					),
		finishReason: Promise.resolve(opts.finishReason ?? "stop"),
	};
}

function input(overrides: Partial<RunAgentIterationInput> = {}) {
	return {
		conversationHistory: [
			{ role: "user" as const, content: "Hi", timestamp: "2026-01-01" },
		],
		availableTools: {},
		systemPrompt: "You are helpful.",
		userId: "user-example-1",
		organizationId: "org-example-1",
		executionId: "orch-example-1",
		iteration: 1,
		...overrides,
	} satisfies RunAgentIterationInput;
}

beforeEach(() => {
	aiStubs.streamTextMock.mockReset();
	db.snapshot.mockReset().mockResolvedValue({
		contractVersion: 1,
		allowance: 500_000,
		finalizationReserve: 8_000,
		measured: 12_000,
		outstanding: 20_000,
		enforcement: "ENFORCED",
	});
});

describe("runAgentIteration — token accounting", () => {
	it("says the usage is unknown when an attempt's usage cannot be read, instead of counting it as zero", async () => {
		aiStubs.streamTextMock
			// A transient error part: retried, but its usage is reported.
			.mockImplementationOnce(() =>
				stream({
					parts: [{ type: "error", error: new Error("gateway 502") }],
					usage: { inputTokens: 900, outputTokens: 0 },
				}),
			)
			// The retry answers, but its usage never arrives.
			.mockImplementationOnce(() =>
				stream({
					parts: [{ type: "text-delta", text: "The 12th." }],
					usageError: new Error("stream terminated unexpectedly"),
				}),
			);

		const result = await runAgentIteration(input());

		expect(result).toMatchObject({
			usage: { inputTokens: 900, outputTokens: 0 },
			usageUnknown: true,
		});
	});

	it("keeps an earlier attempt's usage when the round then throws", async () => {
		aiStubs.streamTextMock
			.mockImplementationOnce(() =>
				stream({
					parts: [{ type: "error", error: new Error("gateway 502") }],
					usage: { inputTokens: 700, outputTokens: 40 },
				}),
			)
			.mockImplementationOnce(() => {
				throw new Error("socket hang up");
			});

		const result = await runAgentIteration(input());

		expect(result.type).toBe("stream_error");
		expect(result.usage).toEqual({ inputTokens: 700, outputTokens: 40 });
		expect(result.usageUnknown).toBe(true);
	});

	it("returns the ledger reading after a ledgered round, keeping the conservative charge out of usage", async () => {
		aiStubs.streamTextMock.mockImplementationOnce(() =>
			stream({
				parts: [{ type: "text-delta", text: "Done." }],
				usageError: new Error("no usage"),
			}),
		);

		const result = await runAgentIteration(
			input({
				turnScope: LEDGERED_SCOPE,
				budgetAttemptKind: "EXPLORATION",
			}),
		);

		expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
		expect(result.usageUnknown).toBe(true);
		expect(result.ledger).toEqual({
			allowance: 500_000,
			finalizationReserve: 8_000,
			measured: 12_000,
			outstanding: 20_000,
			enforcement: "ENFORCED",
		});
		expect(db.snapshot).toHaveBeenCalledWith(LEDGERED_SCOPE);
	});

	it("reads no ledger for a round without the budget contract", async () => {
		aiStubs.streamTextMock.mockImplementationOnce(() =>
			stream({ parts: [{ type: "text-delta", text: "Done." }] }),
		);
		const {
			budgetContractVersion: _contract,
			generation: _generation,
			...legacy
		} = LEDGERED_SCOPE;

		const result = await runAgentIteration(input({ turnScope: legacy }));

		expect(result).not.toHaveProperty("ledger");
		expect(result).not.toHaveProperty("usageUnknown");
		expect(db.snapshot).not.toHaveBeenCalled();
	});

	it("leaves as the non-retryable TurnBudgetExhausted when the ledger refuses a request mid-stream", async () => {
		const refusal = ApplicationFailure.create({
			type: "TurnBudgetExhausted",
			message: "used",
			nonRetryable: true,
		});
		aiStubs.streamTextMock.mockImplementationOnce(() =>
			stream({
				parts: [
					{ type: "text-delta", text: "Partial" },
					// The SDK wraps a refusal on its own retry in a RetryError.
					{
						type: "error",
						error: Object.assign(new Error("retry"), {
							lastError: refusal,
						}),
					},
				],
			}),
		);

		await expect(
			runAgentIteration(input({ turnScope: LEDGERED_SCOPE })),
		).rejects.toBe(refusal);
		// No in-activity retry of a refusal.
		expect(aiStubs.streamTextMock).toHaveBeenCalledTimes(1);
	});
});
