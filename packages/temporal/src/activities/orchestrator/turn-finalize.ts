/**
 * Writes an Advisor chat turn's terminal state from the workflow that ran it.
 *
 * The workflow calls this as its last step, inside
 * `CancellationScope.nonCancellable`, so it runs on every exit path —
 * cancelled ones included. The write is a conditional transition
 * (`finalizeConversationTurn`): a cancel recorded before it ends the turn
 * CANCELLED, keeping the partial text; otherwise the first terminal write
 * wins. That makes the activity idempotent under retries.
 */

import {
	type ConversationTurnTerminalStatus,
	finalizeConversationTurn,
} from "@repo/database";
import { logger } from "@repo/logs";
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
}

export interface FinalizeConversationTurnActivityResult {
	/** The turn's status after this write (or the one it already had). */
	status: string | null;
	wrote: boolean;
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
	};
}
