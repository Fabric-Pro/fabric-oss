/**
 * The workflow side of the turn token ledger (pure; safe in the workflow
 * sandbox): recording a token-allowance stop on the run's state, from the
 * ledger reading the activities returned or the one the refusal carried.
 *
 * What is recorded is user-visible through the `internal_budget` limit
 * signal and the `budgetStop` payload, so it reports MEASURED usage as used:
 * `outstanding` (unsettled reservations and attempts whose usage is unknown,
 * a conservative charge) is carried separately and never added to it. A
 * reading may be conservatively high while a request's settlement is still
 * in flight: that request counts at its reservation, in `outstanding`, until
 * the settlement lands (turn-budget-middleware.ts). The payload the turn
 * finally stores and shows is not built here but by the terminal write,
 * from the ledger under the turn row's lock (`finalizeConversationTurn`).
 */

import type { LimitSignal } from "@repo/ai/limits";
import { ActivityFailure, ApplicationFailure } from "@temporalio/common";
import { TURN_BUDGET_EXHAUSTED_TYPE } from "./turn-contract";
import type {
	OrchestratorBudgetAttemptKind,
	TurnLedgerSnapshot,
	WorkflowState,
} from "./types";

/** Capture which recorded costs the authoritative reading already includes. */
export function recordTurnLedgerReading(
	state: WorkflowState,
	snapshot: TurnLedgerSnapshot,
): void {
	state.turnLedger = snapshot;
	state.turnLedgerCostIndex = state.iterationCosts.length;
}

/**
 * The weighted reading plus costs recorded after it. Those later costs use
 * raw tokens conservatively; a new reading advances the index to avoid
 * counting usage again once the ledger includes it. Older state without a
 * captured index keeps its reading unchanged.
 */
export function advisorChargedUsage(state: WorkflowState): number | undefined {
	if (!state.advisorWeightedAllowanceEnabled || !state.turnLedger) {
		return undefined;
	}
	return (
		state.turnLedger.measured +
		state.turnLedger.outstanding +
		state.iterationCosts
			.slice(state.turnLedgerCostIndex ?? state.iterationCosts.length)
			.reduce(
				(sum, cost) => sum + cost.inputTokens + cost.outputTokens,
				0,
			)
	);
}

/** The message of the ledger's own `internal_budget` signal. */
export const LEDGER_SIGNAL_MESSAGE = "This turn used its token allowance";

function isSnapshot(value: unknown): value is TurnLedgerSnapshot {
	const candidate = value as Partial<TurnLedgerSnapshot> | null;
	return (
		!!candidate &&
		typeof candidate.allowance === "number" &&
		typeof candidate.finalizationReserve === "number" &&
		typeof candidate.measured === "number" &&
		typeof candidate.outstanding === "number"
	);
}

/** The details of a `TurnBudgetExhausted` refusal, or undefined. */
function refusalDetail(
	error: unknown,
): { snapshot?: unknown; kind?: unknown } | undefined {
	const failure =
		error instanceof ActivityFailure ? error.cause : (error as unknown);
	if (
		!(failure instanceof ApplicationFailure) ||
		failure.type !== TURN_BUDGET_EXHAUSTED_TYPE
	) {
		return undefined;
	}
	return (failure.details?.[0] ?? {}) as {
		snapshot?: unknown;
		kind?: unknown;
	};
}

/**
 * The ledger reading a `TurnBudgetExhausted` refusal carries in its details
 * (activities/orchestrator/turn-dispatch.ts), or undefined.
 */
export function ledgerSnapshotFromRefusal(
	error: unknown,
): TurnLedgerSnapshot | undefined {
	const snapshot = refusalDetail(error)?.snapshot;
	return isSnapshot(snapshot) ? snapshot : undefined;
}

/**
 * True when the refused request was a FINALIZATION (the synthesis that writes
 * the answer after a stop): nothing more can be sent, so the budget exit goes
 * straight to the static summary instead of asking again.
 */
export function refusedFinalization(error: unknown): boolean {
	const kind = refusalDetail(error)?.kind as
		| OrchestratorBudgetAttemptKind
		| "AUXILIARY"
		| undefined;
	return kind === "FINALIZATION";
}

/**
 * Record (or refresh) the token-allowance stop on `state`: the structured
 * `budgetStop` and one `internal_budget` limit signal, both built from the
 * freshest ledger reading — `snapshot` when given (a refusal's), else the
 * last one an activity returned. Called again after the finalization, it
 * refreshes the totals and the enforcement, so what is persisted and shown
 * reflects the ledger after the answer was written. `stopReason` only ever
 * moves from `allowance_exhausted` to `finalization_unavailable`.
 */
export function recordTurnBudgetStop(
	state: WorkflowState,
	snapshot: TurnLedgerSnapshot | undefined,
	stopReason: "allowance_exhausted" | "finalization_unavailable",
): void {
	if (snapshot) {
		recordTurnLedgerReading(state, snapshot);
	}
	const reading = state.turnLedger;
	const allowance = reading?.allowance ?? 0;
	const measured = reading?.measured ?? 0;
	state.budgetStop = {
		kind: "token_allowance",
		...(state.advisorBudgetEnabled ? { version: 1 as const } : {}),
		allowance,
		measured,
		outstanding: reading?.outstanding ?? 0,
		enforcement: reading?.enforcement ?? null,
		stopReason:
			state.budgetStop?.kind === "token_allowance" &&
			state.budgetStop.stopReason === "finalization_unavailable"
				? "finalization_unavailable"
				: stopReason,
	};
	const budget = {
		used: measured,
		total: allowance,
		usagePercentage: allowance > 0 ? Math.min(measured / allowance, 1) : 1,
	};
	const existing = state.limitSignals.find(
		(signal) =>
			signal.kind === "internal_budget" &&
			signal.budgetLimit === "tokens" &&
			signal.message === LEDGER_SIGNAL_MESSAGE,
	);
	if (existing) {
		existing.budget = budget;
		return;
	}
	const signal: LimitSignal = {
		kind: "internal_budget",
		message: LEDGER_SIGNAL_MESSAGE,
		budget,
		budgetLimit: "tokens",
	};
	state.limitSignals.push(signal);
}

/**
 * Refresh an already recorded stop from `snapshot` (a later ledger reading),
 * keeping its stop reason. A no-op when the turn did not stop on its
 * allowance.
 */
export function refreshTurnBudgetStop(
	state: WorkflowState,
	snapshot?: TurnLedgerSnapshot,
): void {
	if (state.budgetStop?.kind === "token_allowance") {
		recordTurnBudgetStop(state, snapshot, state.budgetStop.stopReason);
	}
}
