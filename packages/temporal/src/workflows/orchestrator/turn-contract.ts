/**
 * Advisor turn contract, workflow side (pure; safe in the workflow sandbox).
 *
 * A run whose input carries a `turnId` serves a durable `ConversationTurn`.
 * Under the `orch-turn-cancellation-v1` marker such a run:
 *   - passes its turn scope to every model-calling activity, which checks the
 *     turn record before each provider request
 *     (activities/orchestrator/turn-dispatch.ts);
 *   - treats a Temporal cancel and a `TurnNotDispatchable` refusal as a stop
 *     that no intermediate catch may convert into a fallback answer;
 *   - ends COMPLETED in Temporal with a domain result of status "cancelled"
 *     when stopped (see orchestratorExecutionWorkflow), after writing the
 *     turn's terminal state from a non-cancellable scope.
 *
 * Under the later `orch-turn-budget-v1` marker such a run also carries its
 * token ledger contract (see TURN_BUDGET_PATCH): every model request
 * reserves against the turn's durable allowance, and a request that does not
 * fit fails with a non-retryable `TurnBudgetExhausted`, which every
 * intermediate catch rethrows like a stop until it reaches the run's one
 * budget exit. It is not a cancellation: the exit still makes the reserved
 * finalization request.
 *
 * Only the type of `ActivityFailure`/`CancelledFailure` is inspected here, so
 * this module never schedules anything and changes no command on replay.
 */

import {
	ActivityFailure,
	ApplicationFailure,
	CancelledFailure,
	ChildWorkflowFailure,
} from "@temporalio/common";
import type {
	OrchestratorBudgetAttemptKind,
	OrchestratorTurnScope,
} from "./types";

/**
 * Gates every behaviour above. Called once at the start of the workflow, so a
 * history recorded before it (no marker) replays the legacy behaviour, and a
 * run started on the new code records it first, whatever path it takes.
 * Never reuse or rename.
 */
export const TURN_CANCELLATION_PATCH = "orch-turn-cancellation-v1";

/**
 * Gates the turn contract for the Planner (`save_reuse`). Called once, right
 * after `TURN_CANCELLATION_PATCH`. Needed because the web app and the worker
 * deploy separately: while the web app already starts Planner chats as turns
 * (with a turnId), a worker still on the code before this change runs them
 * as legacy runs while recording `TURN_CANCELLATION_PATCH`. A history it
 * recorded has that marker and a turnId but not this one, so the new code
 * replays it as the legacy run it was. Iterative turns do not consult it.
 * Never reuse or rename.
 */
export const PLANNER_TURN_PATCH = "orch-planner-turn-v1";

/**
 * Gates the turn token ledger. Called once, right after
 * `PLANNER_TURN_PATCH`. Under it a run with a turn scope adds to that scope
 * the turn's `generation` (from the starter's `turnGeneration`) and
 * `budgetContractVersion: 1`, tells its activities which requests are its
 * main rounds (EXPLORATION) and its finalization (FINALIZATION), and routes
 * a `TurnBudgetExhausted` refusal to the budget exit (an `internal_budget`
 * signal, the finalization synthesis, else the static summary of the work
 * done; the turn ends LIMITED with a structured `budgetStop`).
 *
 * Rollout. A request reserves only when BOTH the turn row's
 * `budgetContractVersion` (written by the web app at admission) and the
 * activity's scope say 1:
 *   - a history recorded before this marker (an in-flight or legacy turn)
 *     replays without it, carries no contract in its scope, and its turn
 *     stays unledgered whatever its row says; nothing ever upgrades it;
 *   - a new web app with a worker that predates this marker: the row says 1,
 *     the scope says nothing, so the turn runs unledgered (as today), never
 *     half-enforced;
 *   - an old web app with a new worker: the scope says 1, the row has no
 *     contract, so the ledger answers "unledgered" and nothing is reserved.
 * Residual window: an activity task scheduled by a workflow under this
 * marker but picked up by a worker still on the code before it ignores the
 * scope's contract and sends its requests unreserved. Those requests are
 * neither reserved nor settled, so the ledger under-counts the turn by their
 * usage (it never over-counts because of them). The window closes when every
 * worker on the queue runs this code.
 * Never reuse or rename.
 */
export const TURN_BUDGET_PATCH = "orch-turn-budget-v1";

/** Mirrors `TURN_NOT_DISPATCHABLE` in activities/orchestrator/turn-dispatch.ts. */
export const TURN_NOT_DISPATCHABLE_TYPE = "TurnNotDispatchable";

/** Mirrors `TURN_BUDGET_EXHAUSTED` in activities/orchestrator/turn-dispatch.ts. */
export const TURN_BUDGET_EXHAUSTED_TYPE = "TurnBudgetExhausted";

export type TurnStopReason = "cancelled" | "scope_mismatch" | "terminal";

/**
 * What a phase needs to honour the turn contract: the iterative phase, and
 * the planner (`save_reuse`) path's planning, execution, per-step
 * clarification and trajectory replay. A Weave run never has one.
 */
export interface IterativeTurnOptions {
	/**
	 * True when the run recorded the marker: a stop is rethrown by every
	 * intermediate catch instead of becoming a fallback.
	 */
	cancellationAware: boolean;
	/** Passed to model-calling activities; absent for a run with no turn. */
	turnScope?: OrchestratorTurnScope;
}

/** True when `error` is (or wraps) a Temporal cancellation. */
export function isCancellationFailure(error: unknown): boolean {
	if (error instanceof CancelledFailure) {
		return true;
	}
	if (
		error instanceof ActivityFailure ||
		error instanceof ChildWorkflowFailure
	) {
		return error.cause instanceof CancelledFailure;
	}
	return false;
}

/**
 * The reason of a `TurnNotDispatchable` refusal, unwrapped from the
 * `ActivityFailure` the workflow sees, or null when `error` is something else.
 */
export function turnNotDispatchableReason(
	error: unknown,
): TurnStopReason | null {
	const failure =
		error instanceof ActivityFailure ? error.cause : (error as unknown);
	if (
		!(failure instanceof ApplicationFailure) ||
		failure.type !== TURN_NOT_DISPATCHABLE_TYPE
	) {
		return null;
	}
	const detail = failure.details?.[0] as { reason?: unknown } | undefined;
	const reason = detail?.reason;
	return reason === "scope_mismatch" || reason === "terminal"
		? reason
		: "cancelled";
}

/**
 * True when `error` is (or wraps, as the `ActivityFailure` the workflow
 * sees) the ledger's refusal of a request that did not fit the turn's token
 * allowance.
 */
export function isTurnBudgetExhausted(error: unknown): boolean {
	const failure =
		error instanceof ActivityFailure ? error.cause : (error as unknown);
	return (
		failure instanceof ApplicationFailure &&
		failure.type === TURN_BUDGET_EXHAUSTED_TYPE
	);
}

/**
 * True when `error` means the turn must stop: a cancellation, or any
 * dispatch refusal. Catches that would otherwise fall back rethrow these.
 */
export function isTurnStop(error: unknown): boolean {
	return (
		isCancellationFailure(error) ||
		turnNotDispatchableReason(error) !== null
	);
}

/**
 * What every intermediate catch must rethrow instead of falling back: a
 * turn stop, or a budget refusal (which travels the same way to the budget
 * exit, but is not a stop: the exit still writes an answer).
 */
function mustPropagate(error: unknown): boolean {
	return isTurnStop(error) || isTurnBudgetExhausted(error);
}

/** Rethrow `error` when it is a turn stop and the run honours the contract. */
export function rethrowTurnStop(
	error: unknown,
	turn: IterativeTurnOptions | undefined,
): void {
	if (turn?.cancellationAware && mustPropagate(error)) {
		throw error;
	}
}

/**
 * After a fan-out settled: when the run honours the contract and any branch
 * failed with a turn stop, throw that stop, so the fan-out's own failure
 * handling (a fallback, a recovery loop) never sees it. A stop wins over a
 * budget refusal (cancellation precedes LIMITED); a budget refusal is thrown
 * when no branch stopped. A no-op otherwise.
 */
export function rethrowFirstTurnStop(
	results: readonly PromiseSettledResult<unknown>[],
	turn: IterativeTurnOptions | undefined,
): void {
	if (!turn?.cancellationAware) {
		return;
	}
	for (const result of results) {
		if (result.status === "rejected" && isTurnStop(result.reason)) {
			throw result.reason;
		}
	}
	for (const result of results) {
		if (
			result.status === "rejected" &&
			isTurnBudgetExhausted(result.reason)
		) {
			throw result.reason;
		}
	}
}

/**
 * `Promise.all` for a workflow fan-out. For a run that honours the contract
 * it waits for every branch to settle (so no branch's activity is still
 * scheduled when the stop leaves the fan-out), then rejects with the first
 * turn stop, else the first failure in input order. Without a turn it IS
 * `Promise.all`, so a run with no turn keeps its exact behaviour.
 */
export async function settleAllForTurn<T>(
	promises: readonly Promise<T>[],
	turn: IterativeTurnOptions | undefined,
): Promise<T[]> {
	if (!turn?.cancellationAware) {
		return Promise.all(promises);
	}
	const results = await Promise.allSettled(promises);
	rethrowFirstTurnStop(results, turn);
	const failure = results.find(
		(result): result is PromiseRejectedResult =>
			result.status === "rejected",
	);
	if (failure) {
		throw failure.reason;
	}
	return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

/** `turnScope` spread for an activity input; empty for a run with no turn. */
export function turnScopeField(
	turn: IterativeTurnOptions | undefined,
): { turnScope: OrchestratorTurnScope } | Record<string, never> {
	return turn?.turnScope ? { turnScope: turn.turnScope } : {};
}

/**
 * `budgetAttemptKind` spread for a model-calling activity input: present only
 * for a run whose scope carries the budget contract, so a run without it
 * schedules the activity with exactly the input it always had.
 */
export function budgetAttemptKindField(
	turn: IterativeTurnOptions | undefined,
	kind: OrchestratorBudgetAttemptKind,
):
	| { budgetAttemptKind: OrchestratorBudgetAttemptKind }
	| Record<string, never> {
	return turn?.turnScope?.budgetContractVersion !== undefined
		? { budgetAttemptKind: kind }
		: {};
}

/**
 * `finalizationQuestion` spread for the finalization synthesis's activity
 * input: the user's request, which the activity keeps in the request it
 * shrinks to fit the turn's remaining allowance. Present only beside
 * `budgetAttemptKind` (a run whose scope carries the budget contract, under
 * `orch-turn-budget-v1`), so a run without it schedules the activity with
 * exactly the input it always had.
 */
export function finalizationQuestionField(
	turn: IterativeTurnOptions | undefined,
	question: string | undefined,
): { finalizationQuestion: string } | Record<string, never> {
	return turn?.turnScope?.budgetContractVersion !== undefined && question
		? { finalizationQuestion: question }
		: {};
}

/** True when the run's scope carries the budget contract. */
export function speaksBudgetContract(
	turn: IterativeTurnOptions | undefined,
): boolean {
	return turn?.turnScope?.budgetContractVersion !== undefined;
}

/**
 * The trailing options argument for a positional activity that takes its
 * turn scope there (`retrieveWorkspaceDocumentsActivity`,
 * `retrieveProjectContextsActivity`): spread after the last positional
 * argument. Empty for a run with no turn, so such a run schedules the
 * activity with exactly the arguments it always had.
 */
export function turnScopeOptionArgs(
	turn: IterativeTurnOptions | undefined,
): [] | [{ turnScope: OrchestratorTurnScope }] {
	return turn?.turnScope ? [{ turnScope: turn.turnScope }] : [];
}
