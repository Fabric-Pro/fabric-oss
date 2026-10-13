/**
 * How a turn-scoped activity ends when more than one stop applies: the
 * precedence is cancellation > dispatch refusal > budget refusal, and it is
 * the same whether the guarded work returned normally or threw.
 *
 * The activity runs in a real activity context (`MockActivityEnvironment`),
 * so a delivered cancellation is the activity's own cancellation signal, as
 * on the worker; the turn guard is the one the activity interceptor
 * installs (`runWithTurnDispatch`), with a mocked ledger store.
 */

import { getDispatchGuard } from "@repo/utils/dispatch-guard";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	checkDispatchable: vi.fn(),
	reserve: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: h.checkDispatchable,
	reserveConversationTurnAttempt: h.reserve,
	settleConversationTurnAttempt: vi.fn(),
	getConversationTurnLedgerSnapshot: vi.fn(async () => null),
}));

import {
	runWithTurnDispatch,
	TURN_BUDGET_EXHAUSTED,
	TURN_NOT_DISPATCHABLE,
	throwIfTurnStopped,
} from "../turn-dispatch";

const SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-00000000-0000-4000-8000-000000000001",
	userId: "user-example-1",
	organizationId: "org-example-1",
	generation: 1,
	budgetContractVersion: 1,
};

beforeEach(() => {
	h.checkDispatchable.mockReset().mockResolvedValue({ ok: true });
	h.reserve.mockReset().mockResolvedValue({
		outcome: "exhausted",
		snapshot: {
			contractVersion: 1,
			allowance: 100_000,
			finalizationReserve: 8_000,
			measured: 92_000,
			outstanding: 0,
			enforcement: "ENFORCED",
		},
		room: 0,
		needed: 10,
	});
});

/** A request the ledger refuses for the allowance, caught by the work. */
async function swallowBudgetRefusal(): Promise<void> {
	await getDispatchGuard()
		?.budget?.reserve({
			modality: "language",
			inputEstimate: 10,
			requestedOutputTokens: 100,
			minOutputTokens: 10,
			enforcesOutputCap: true,
		})
		.catch(() => undefined);
}

/**
 * A request the turn record refuses (the turn was stopped), caught. The
 * ledger reports the stop when it is asked to reserve, which it is whatever
 * the guard has latched before.
 */
async function swallowDispatchRefusal(): Promise<void> {
	h.reserve.mockResolvedValueOnce({ outcome: "denied", reason: "cancelled" });
	await getDispatchGuard()
		?.budget?.reserve({
			modality: "language",
			inputEstimate: 10,
			requestedOutputTokens: 100,
			minOutputTokens: 10,
			enforcesOutputCap: true,
		})
		.catch(() => undefined);
}

/** Runs `body` as the interceptor would, inside an activity context. */
function runActivity(
	body: (env: MockActivityEnvironment) => Promise<unknown>,
): Promise<unknown> {
	const env = new MockActivityEnvironment();
	return env
		.run(() => runWithTurnDispatch(SCOPE, () => body(env)))
		.then(
			(value) => ({ resolvedWith: value }),
			(error: unknown) => error,
		);
}

function failureType(outcome: unknown): string | undefined {
	return outcome instanceof ApplicationFailure
		? (outcome.type ?? undefined)
		: undefined;
}

describe("stop precedence on both completion branches", () => {
	it("reports a delivered cancellation when the work caught a budget refusal and resolved normally", async () => {
		const outcome = await runActivity(async (env) => {
			await swallowBudgetRefusal();
			env.cancel();
			return { success: false, error: "the tool could not run" };
		});
		expect(outcome).toBeInstanceOf(CancelledFailure);
	});

	it("reports a delivered cancellation when the work caught a budget refusal and threw an ordinary error", async () => {
		const outcome = await runActivity(async (env) => {
			await swallowBudgetRefusal();
			env.cancel();
			throw new Error("tool failed");
		});
		expect(outcome).toBeInstanceOf(CancelledFailure);
	});

	it.each([
		["returned normally", "return"],
		["threw an ordinary error", "throw"],
	] as const)(
		"reports a dispatch refusal over a budget refusal when the work %s",
		async (_label, ending) => {
			for (const order of ["budget first", "refusal first"]) {
				const outcome = await runActivity(async () => {
					if (order === "budget first") {
						await swallowBudgetRefusal();
						await swallowDispatchRefusal();
					} else {
						await swallowDispatchRefusal();
						await swallowBudgetRefusal();
					}
					if (ending === "throw") {
						throw new Error("tool failed");
					}
					return { success: false };
				});
				expect(failureType(outcome)).toBe(TURN_NOT_DISPATCHABLE);
			}
		},
	);

	it.each([
		["returned normally", "return"],
		["threw an ordinary error", "throw"],
	] as const)(
		"reports a budget refusal when it is the only stop and the work %s",
		async (_label, ending) => {
			const outcome = await runActivity(async () => {
				await swallowBudgetRefusal();
				if (ending === "throw") {
					throw new Error("tool failed");
				}
				return { success: false };
			});
			expect(failureType(outcome)).toBe(TURN_BUDGET_EXHAUSTED);
		},
	);

	it("applies the same precedence to the in-body stop check", async () => {
		const outcome = await runActivity(async (env) => {
			await swallowBudgetRefusal();
			env.cancel();
			throwIfTurnStopped();
			return { unreachable: true };
		});
		expect(outcome).toBeInstanceOf(CancelledFailure);
	});
});
