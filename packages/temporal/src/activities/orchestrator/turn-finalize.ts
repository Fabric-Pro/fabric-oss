/**
 * Writes an Advisor chat turn's terminal state from the workflow that ran it.
 *
 * The workflow calls this as its last step, inside
 * `CancellationScope.nonCancellable`, so it runs on every exit path —
 * cancelled ones included. The write is a conditional transition
 * (`finalizeConversationTurn`): a cancel recorded before it ends the turn
 * CANCELLED, keeping the partial text; otherwise the first terminal write
 * wins. That makes the activity idempotent under retries.
 *
 * A token-allowance stop is persisted with the ledger's totals read under
 * the turn row's lock inside that same write, and the activity returns the
 * stop exactly as the row stores it — for the first write and for a retry
 * whose first attempt committed but whose response was lost. Nothing built
 * here from a separate ledger read reaches the workflow's output.
 */

// Round and local token stops carry the counters used by their workflow guard.

import {
	type ConversationTurnTerminalStatus,
	finalizeConversationTurn,
} from "@repo/database";
import { logger } from "@repo/logs";
import type { TurnBudgetStop } from "../../workflows/orchestrator/types";
import type { TurnScope } from "./turn-dispatch";

export interface FinalizeConversationTurnActivityInput {
	turnScope: TurnScope;
	/** How the run ended. A cancel recorded first overrides it. */
	outcome: ConversationTurnTerminalStatus;
	terminalReason?: string;
	/** The answer, or the partial text a cancelled run produced. */
	responseText?: string;
	/** kind/provider/message of each limit signal the run ended with. */
	limitSignalSummary?: Array<{
		kind: string;
		provider?: string;
		message: string;
	}>;
	/**
	 * The structured token-allowance stop, when the run stopped on its
	 * allowance. Its stop reason is persisted as is; its totals are replaced
	 * by the ledger's at the moment of the write (see the header).
	 */
	budgetStop?: TurnBudgetStop;
}

export interface FinalizeConversationTurnActivityResult {
	/** The turn's status after this write (or the one it already had). */
	status: string | null;
	wrote: boolean;
	/**
	 * The token-allowance stop exactly as the turn row stores it, absent when
	 * the row stores none. The workflow returns this one, so the live
	 * stream, the turn row and a reconnect carry the same payload.
	 */
	budgetStop?: TurnBudgetStop;
}

/** Longest response kept on the turn row; the conversation holds the rest. */
const MAX_TURN_RESPONSE_CHARS = 200_000;

export async function finalizeConversationTurnActivity(
	input: FinalizeConversationTurnActivityInput,
): Promise<FinalizeConversationTurnActivityResult> {
	const { turnScope } = input;
	const result = await finalizeConversationTurn({
		turnId: turnScope.turnId,
		executionId: turnScope.executionId,
		userId: turnScope.userId,
		organizationId: turnScope.organizationId,
		outcome: input.outcome,
		terminalReason: input.terminalReason?.slice(0, 2_000),
		responseText: input.responseText?.slice(0, MAX_TURN_RESPONSE_CHARS),
		...(input.limitSignalSummary && input.limitSignalSummary.length > 0
			? { limitSignalSummary: input.limitSignalSummary }
			: {}),
		...(input.budgetStop
			? {
					budgetStop:
						input.budgetStop.kind === "token_allowance" &&
						input.budgetStop.version === undefined
							? {
									stopReason: input.budgetStop.stopReason,
									allowance: input.budgetStop.allowance,
									measured: input.budgetStop.measured,
									outstanding: input.budgetStop.outstanding,
									enforcement: input.budgetStop.enforcement,
								}
							: input.budgetStop,
				}
			: {}),
	});
	if (result.outcome === "not_found") {
		// The scope the workflow carries matches no turn: never a normal
		// end, and nothing to write.
		logger.error("[TurnFinalize] No turn matches the workflow's scope", {
			turnId: turnScope.turnId,
			executionId: turnScope.executionId,
			organizationId: turnScope.organizationId,
		});
		return { status: null, wrote: false };
	}
	return {
		status: result.status,
		wrote: result.outcome === "finalized",
		// The row's own value (a JSON column the terminal write fills only
		// with a `TurnBudgetStop`), for both a fresh write and a retry.
		...(result.budgetStop
			? { budgetStop: result.budgetStop as unknown as TurnBudgetStop }
			: {}),
	};
}
