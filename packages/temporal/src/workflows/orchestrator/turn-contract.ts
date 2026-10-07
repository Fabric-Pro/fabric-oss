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
 * Only the type of `ActivityFailure`/`CancelledFailure` is inspected here, so
 * this module never schedules anything and changes no command on replay.
 */

import {
	ActivityFailure,
	ApplicationFailure,
	CancelledFailure,
	ChildWorkflowFailure,
} from "@temporalio/common";
import type { OrchestratorTurnScope } from "./types";

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

/** Mirrors `TURN_NOT_DISPATCHABLE` in activities/orchestrator/turn-dispatch.ts. */
export const TURN_NOT_DISPATCHABLE_TYPE = "TurnNotDispatchable";

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
 * True when `error` means the turn must stop: a cancellation, or any
 * dispatch refusal. Catches that would otherwise fall back rethrow these.
 */
export function isTurnStop(error: unknown): boolean {
	return (
		isCancellationFailure(error) ||
		turnNotDispatchableReason(error) !== null
	);
}

/** Rethrow `error` when it is a turn stop and the run honours the contract. */
export function rethrowTurnStop(
	error: unknown,
	turn: IterativeTurnOptions | undefined,
): void {
	if (turn?.cancellationAware && isTurnStop(error)) {
		throw error;
	}
}

/**
 * After a fan-out settled: when the run honours the contract and any branch
 * failed with a turn stop, throw that stop, so the fan-out's own failure
 * handling (a fallback, a recovery loop) never sees it. A no-op otherwise.
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
