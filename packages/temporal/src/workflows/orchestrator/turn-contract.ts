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

/** Mirrors `TURN_NOT_DISPATCHABLE` in activities/orchestrator/turn-dispatch.ts. */
export const TURN_NOT_DISPATCHABLE_TYPE = "TurnNotDispatchable";

export type TurnStopReason = "cancelled" | "scope_mismatch" | "terminal";

/** What the iterative phase needs to honour the turn contract. */
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

/** `turnScope` spread for an activity input; empty for a run with no turn. */
export function turnScopeField(
	turn: IterativeTurnOptions | undefined,
): { turnScope: OrchestratorTurnScope } | Record<string, never> {
	return turn?.turnScope ? { turnScope: turn.turnScope } : {};
}
