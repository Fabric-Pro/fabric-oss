/**
 * The turn token ledger as the dispatch guard carries it
 * (`runWithTurnDispatch` → `guard.budget`), with real factory middleware and
 * a mocked ledger store.
 *
 * Pins:
 *  - the guard carries a ledger only for a scope with the budget contract;
 *  - each physical request reserves with the activity's attempt kind
 *    (EXPLORATION / FINALIZATION from the workflow-set input, AUXILIARY
 *    otherwise, always AUXILIARY for an embedding) and settles its usage;
 *  - a request that does not fit fails with a NON-RETRYABLE
 *    `TurnBudgetExhausted` (not `TurnNotDispatchable`), carrying the ledger
 *    reading, sends nothing, aborts the guard's other requests, and every
 *    later catch's `rethrowIfTurnStopped` rethrows it unwrapped;
 *  - a turn row with no ledger answers "unledgered" and the request goes
 *    out unreserved;
 *  - the interceptor reconstructs the generation, the contract and the
 *    attempt kind from the activity's first argument.
 */

import { wrapModelWithDispatchGuard } from "@repo/ai/lib/dispatch-guard-middleware";
import { wrapModelWithTurnBudget } from "@repo/ai/lib/turn-budget-middleware";
import { getDispatchGuard } from "@repo/utils/dispatch-guard";
import { ApplicationFailure } from "@temporalio/common";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	checkDispatchable: vi.fn(),
	reserve: vi.fn(),
	settle: vi.fn(),
	snapshot: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: db.checkDispatchable,
	reserveConversationTurnAttempt: db.reserve,
	settleConversationTurnAttempt: db.settle,
	getConversationTurnLedgerSnapshot: db.snapshot,
}));

import {
	extractBudgetAttemptKind,
	extractTurnScope,
} from "../../../lib/turn-dispatch-interceptor";
import {
	isTurnBudgetExhausted,
	isTurnNotDispatchable,
	readTurnLedgerSnapshot,
	rethrowIfTurnStopped,
	runWithTurnDispatch,
	TURN_BUDGET_EXHAUSTED,
} from "../turn-dispatch";

const SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
	generation: 2,
	budgetContractVersion: 1,
};

const LEGACY_SCOPE = {
	turnId: SCOPE.turnId,
	executionId: SCOPE.executionId,
	userId: SCOPE.userId,
	organizationId: SCOPE.organizationId,
};

const SNAPSHOT = {
	contractVersion: 1,
	allowance: 100_000,
	finalizationReserve: 8_000,
	measured: 90_000,
	outstanding: 1_500,
	enforcement: "ENFORCED" as const,
};

const USAGE = {
	inputTokens: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 10, text: 10, reasoning: 0 },
};

const GENERATE_RESULT = {
	content: [{ type: "text" as const, text: "ok" }],
	finishReason: { unified: "stop" as const, raw: undefined },
	usage: USAGE,
	warnings: [],
};

function factoryModel(provider: MockLanguageModelV4) {
	return wrapModelWithDispatchGuard(
		wrapModelWithTurnBudget(provider, { enforcesOutputCap: true }),
	);
}

let seq = 0;
beforeEach(() => {
	seq = 0;
	db.checkDispatchable.mockReset().mockResolvedValue({ ok: true });
	db.reserve.mockReset().mockImplementation(async () => {
		seq += 1;
		return {
			outcome: "reserved",
			attemptId: `attempt-${seq}`,
			reservedTokens: 3_000,
			outputCap: 2_000,
		};
	});
	db.settle.mockReset().mockResolvedValue({
		outcome: "settled",
		status: "SETTLED",
	});
	db.snapshot.mockReset().mockResolvedValue(SNAPSHOT);
});

describe("the guard's ledger", () => {
	it("is carried only for a scope with the budget contract", () => {
		expect(
			runWithTurnDispatch(SCOPE, () => getDispatchGuard()?.budget),
		).toBeDefined();
		expect(
			runWithTurnDispatch(LEGACY_SCOPE, () => getDispatchGuard()?.budget),
		).toBeUndefined();
	});

	it("tells the dispatch layer the activity's attempt kind, AUXILIARY when it names none", () => {
		expect(
			runWithTurnDispatch(
				SCOPE,
				() => getDispatchGuard()?.budget?.attemptKind,
				{
					attemptKind: "FINALIZATION",
				},
			),
		).toBe("FINALIZATION");
		expect(
			runWithTurnDispatch(
				SCOPE,
				() => getDispatchGuard()?.budget?.attemptKind,
			),
		).toBe("AUXILIARY");
	});

	it("reserves each request with the activity's attempt kind and the turn's scope, then settles its usage", async () => {
		const provider = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});
		await runWithTurnDispatch(
			SCOPE,
			() => generateText({ model: factoryModel(provider), prompt: "Hi" }),
			{ attemptKind: "FINALIZATION" },
		);

		expect(db.reserve).toHaveBeenCalledTimes(1);
		expect(db.reserve.mock.calls[0]?.[0]).toMatchObject({
			scope: SCOPE,
			kind: "FINALIZATION",
			enforced: true,
			requestedOutputTokens: 16_384,
			minOutputTokens: 1_024,
		});
		expect(provider.doGenerateCalls[0]?.maxOutputTokens).toBe(2_000);
		expect(db.settle).toHaveBeenCalledWith({
			scope: SCOPE,
			attemptId: "attempt-1",
			settlement: {
				status: "SETTLED",
				inputTokens: 40,
				outputTokens: 10,
			},
		});
	});

	it("reserves as AUXILIARY when the activity names no kind", async () => {
		const provider = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});
		await runWithTurnDispatch(SCOPE, () =>
			generateText({ model: factoryModel(provider), prompt: "Hi" }),
		);
		expect(db.reserve.mock.calls[0]?.[0]).toMatchObject({
			kind: "AUXILIARY",
		});
	});

	it("reserves an embedding or a typed decision as AUXILIARY whatever the activity's kind", async () => {
		await runWithTurnDispatch(
			SCOPE,
			async () => {
				const budget = getDispatchGuard()?.budget;
				for (const modality of ["embedding", "decision"] as const) {
					await budget?.reserve({
						modality,
						inputEstimate: 100,
						requestedOutputTokens:
							modality === "decision" ? 1_024 : 0,
						minOutputTokens: modality === "decision" ? 1_024 : 0,
						enforcesOutputCap: modality === "embedding",
					});
				}
			},
			{ attemptKind: "EXPLORATION" },
		);
		expect(db.reserve.mock.calls.map((call) => call[0].kind)).toEqual([
			"AUXILIARY",
			"AUXILIARY",
		]);
	});

	it("sends the request unreserved when the turn row has no ledger", async () => {
		db.reserve.mockResolvedValue({ outcome: "unledgered" });
		const provider = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});
		const result = await runWithTurnDispatch(SCOPE, () =>
			generateText({
				model: factoryModel(provider),
				prompt: "Hi",
				maxOutputTokens: 900,
			}),
		);
		expect(result.text).toBe("ok");
		expect(provider.doGenerateCalls[0]?.maxOutputTokens).toBe(900);
		expect(db.settle).not.toHaveBeenCalled();
	});

	it("refuses a request that does not fit with a non-retryable TurnBudgetExhausted carrying the ledger reading, and sends nothing", async () => {
		db.reserve.mockResolvedValue({
			outcome: "exhausted",
			snapshot: SNAPSHOT,
			room: 500,
			needed: 9_000,
		});
		const provider = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});
		const error = await runWithTurnDispatch(SCOPE, () =>
			generateText({
				model: factoryModel(provider),
				prompt: "Hi",
				maxRetries: 2,
			}),
		).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ApplicationFailure);
		const failure = error as ApplicationFailure;
		expect(failure.type).toBe(TURN_BUDGET_EXHAUSTED);
		expect(failure.nonRetryable).toBe(true);
		expect(isTurnBudgetExhausted(failure)).toBe(true);
		expect(isTurnNotDispatchable(failure)).toBe(false);
		expect(failure.details?.[0]).toMatchObject({
			kind: "AUXILIARY",
			room: 500,
			needed: 9_000,
			snapshot: {
				allowance: 100_000,
				finalizationReserve: 8_000,
				measured: 90_000,
				outstanding: 1_500,
				enforcement: "ENFORCED",
			},
		});
		expect(provider.doGenerateCalls).toHaveLength(0);
		// Not retried by the SDK: one reservation attempt.
		expect(db.reserve).toHaveBeenCalledTimes(1);
	});

	it("maps a ledger denial for a stopped turn to TurnNotDispatchable", async () => {
		db.reserve.mockResolvedValue({
			outcome: "denied",
			reason: "cancelled",
		});
		const provider = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});
		const error = await runWithTurnDispatch(SCOPE, () =>
			generateText({ model: factoryModel(provider), prompt: "Hi" }),
		).catch((caught: unknown) => caught);
		expect(isTurnNotDispatchable(error)).toBe(true);
		expect(isTurnBudgetExhausted(error)).toBe(false);
	});

	it("aborts the guard's other requests once one is refused, and every catch then rethrows the refusal", async () => {
		let firstReserve = true;
		db.reserve.mockImplementation(async () => {
			if (firstReserve) {
				firstReserve = false;
				return {
					outcome: "reserved",
					attemptId: "attempt-in-flight",
					reservedTokens: 3_000,
					outputCap: 2_000,
				};
			}
			return {
				outcome: "exhausted",
				snapshot: SNAPSHOT,
				room: 0,
				needed: 4_000,
			};
		});
		let inFlightSignal: AbortSignal | undefined;
		const hanging = new MockLanguageModelV4({
			doStream: async (options) => {
				inFlightSignal = options.abortSignal;
				return {
					// Open until the request's abort signal fires.
					stream: new ReadableStream<never>({
						start(controller) {
							controller.enqueue({
								type: "stream-start",
								warnings: [],
							} as never);
							options.abortSignal?.addEventListener("abort", () =>
								controller.error(options.abortSignal?.reason),
							);
						},
					}),
				};
			},
		});
		const refused = new MockLanguageModelV4({
			doGenerate: async () => GENERATE_RESULT,
		});

		// The body returns normally; the guard's backstop fails it with the
		// latched refusal.
		const outcome = await runWithTurnDispatch(SCOPE, async () => {
			const inFlight = streamText({
				model: factoryModel(hanging),
				prompt: "Hi",
				onError: () => undefined,
			});
			const reading = inFlight.consumeStream({
				onError: () => undefined,
			});
			await vi.waitFor(() => expect(inFlightSignal).toBeDefined());

			const error = await generateText({
				model: factoryModel(refused),
				prompt: "Hi",
			}).catch((caught: unknown) => caught);
			expect(isTurnBudgetExhausted(error)).toBe(true);
			// The sibling request in flight is aborted by the refusal.
			expect(inFlightSignal?.aborted).toBe(true);
			// A catch that would fall back rethrows the refusal, even for an
			// unrelated error, unwrapped.
			expect(() => rethrowIfTurnStopped(new Error("unrelated"))).toThrow(
				expect.objectContaining({ type: TURN_BUDGET_EXHAUSTED }),
			);
			await reading;
		}).catch((caught: unknown) => caught);
		expect(isTurnBudgetExhausted(outcome)).toBe(true);
		// The aborted sibling's usage is unknown: it stays charged.
		expect(db.settle).toHaveBeenCalledWith({
			scope: SCOPE,
			attemptId: "attempt-in-flight",
			settlement: { status: "UNKNOWN" },
		});
	});

	it("rethrowIfTurnStopped unwraps a budget refusal from the SDK's retry error", () => {
		const refusal = ApplicationFailure.create({
			type: TURN_BUDGET_EXHAUSTED,
			message: "used",
			nonRetryable: true,
		});
		const retryError = Object.assign(new Error("retry"), {
			lastError: refusal,
			errors: [new Error("overloaded"), refusal],
		});
		expect(() => rethrowIfTurnStopped(retryError)).toThrow(refusal);
	});
});

describe("readTurnLedgerSnapshot", () => {
	it("reads the ledger for a scope with the contract, as plain numbers", async () => {
		expect(await readTurnLedgerSnapshot(SCOPE)).toEqual({
			allowance: 100_000,
			finalizationReserve: 8_000,
			measured: 90_000,
			outstanding: 1_500,
			enforcement: "ENFORCED",
		});
	});

	it("reads nothing for a scope without the contract, or when the read fails", async () => {
		expect(await readTurnLedgerSnapshot(LEGACY_SCOPE)).toBeUndefined();
		expect(await readTurnLedgerSnapshot(undefined)).toBeUndefined();
		db.snapshot.mockRejectedValue(new Error("db down"));
		expect(await readTurnLedgerSnapshot(SCOPE)).toBeUndefined();
	});
});

describe("the interceptor's reconstruction", () => {
	it("keeps the generation (a number or null) and the contract from the workflow's scope", () => {
		expect(extractTurnScope({ args: [{ turnScope: SCOPE }] })).toEqual(
			SCOPE,
		);
		expect(
			extractTurnScope({
				args: [{ turnScope: { ...SCOPE, generation: null } }],
			}),
		).toEqual({ ...SCOPE, generation: null });
	});

	it("drops a malformed generation or contract, leaving the turn unledgered", () => {
		expect(
			extractTurnScope({
				args: [
					{
						turnScope: {
							...SCOPE,
							generation: "2",
							budgetContractVersion: "1",
						},
					},
				],
			}),
		).toEqual(LEGACY_SCOPE);
	});

	it("reads only the attempt kinds the workflow sets", () => {
		expect(
			extractBudgetAttemptKind({
				args: [{ budgetAttemptKind: "FINALIZATION" }],
			}),
		).toBe("FINALIZATION");
		expect(
			extractBudgetAttemptKind({
				args: [{ budgetAttemptKind: "EXPLORATION" }],
			}),
		).toBe("EXPLORATION");
		expect(
			extractBudgetAttemptKind({
				args: [{ budgetAttemptKind: "AUXILIARY" }],
			}),
		).toBeUndefined();
		expect(
			extractBudgetAttemptKind({ args: ["positional"] }),
		).toBeUndefined();
	});
});
