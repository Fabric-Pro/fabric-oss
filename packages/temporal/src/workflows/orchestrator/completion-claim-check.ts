/**
 * The workflow side of the unbacked-completion check: when a turn ends with a
 * reply but called no tool, ask whether the reply claims an action was done,
 * and if it does, hand back the instruction for one corrective round.
 *
 * A turn that called no tool did nothing and checked nothing, so a claim in
 * it is false; the corrective round runs with the same tools, so the
 * assistant can still do what was asked. The judging and both prompts live in
 * `checkCompletionClaimActivity`; this module decides when to ask and records
 * what the asking cost.
 */

import { log } from "@temporalio/workflow";
import type {
	CheckCompletionClaimInput,
	CheckCompletionClaimResult,
} from "../../activities/orchestrator/execution/check-completion-claim";
import { type IterativeTurnOptions, isTurnStop } from "./turn-contract";
import type { IterationCost } from "./types";

/**
 * Gates the check. It adds an activity to a turn whose reply came with no
 * tool call and, when that reply claims an action, one more agent round, so
 * an older history replays without either.
 */
export const COMPLETION_CLAIM_CHECK_PATCH = "orch-completion-claim-check-v1";

/**
 * Whether the reply ending this turn is checked: once per turn, only when the
 * turn called no tool at all and had tools it could have called. A turn with
 * no tools bound could not have acted, and its reply is not the guard's
 * concern.
 */
export function shouldCheckCompletionClaim(params: {
	enabled: boolean;
	alreadyChecked: boolean;
	toolRoundSeen: boolean;
	boundToolCount: number;
}): boolean {
	return (
		params.enabled &&
		!params.alreadyChecked &&
		!params.toolRoundSeen &&
		params.boundToolCount > 0
	);
}

/**
 * The correction for the turn's next round, or null when the reply stands.
 *
 * A check that fails leaves the reply as it is, and so does a token-allowance
 * refusal: the turn already has its answer, so sending the refusal on to the
 * budget exit would only spend a finalization request to replace it. A stop
 * still ends the turn.
 */
export async function correctionForUnbackedClaim(params: {
	check: (
		input: CheckCompletionClaimInput,
	) => Promise<CheckCompletionClaimResult>;
	input: CheckCompletionClaimInput;
	turn: IterativeTurnOptions | undefined;
	iterationCosts: IterationCost[];
	iteration: number;
}): Promise<string | null> {
	let result: CheckCompletionClaimResult;
	try {
		result = await params.check(params.input);
	} catch (error) {
		if (params.turn?.cancellationAware && isTurnStop(error)) {
			throw error;
		}
		log.warn("Completion claim check failed; the reply stands", {
			iteration: params.iteration,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}

	if (result.usage.inputTokens > 0 || result.usage.outputTokens > 0) {
		params.iterationCosts.push({
			iteration: params.iteration,
			inputTokens: result.usage.inputTokens,
			outputTokens: result.usage.outputTokens,
			timestamp: new Date().toISOString(),
		});
	}
	log.info("Completion claim checked", {
		iteration: params.iteration,
		unbackedClaim: result.unbackedClaim,
		judgedBy: result.judgedBy,
	});
	return result.unbackedClaim && result.correction ? result.correction : null;
}
