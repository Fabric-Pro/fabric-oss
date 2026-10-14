/**
 * The token allowance a chat turn is admitted with (pure; exported as
 * `@repo/temporal/turn-budget-policy` for the chat starters).
 *
 * The allowance is the execution mode's `maxTotalTokens` and the
 * finalization reserve is `BUDGET.synthesisReserveTokens`, read the same way
 * the workflow reads its own limits (an unknown mode runs `balanced`; a mode
 * with no `maxTotalTokens` runs `BUDGET.defaultMaxTotalTokens`), so the
 * ledger and the workflow agree on the numbers. Nothing here changes them.
 */

import { BUDGET } from "./orchestrator-config";
import {
	EXECUTION_MODE_CONFIGS,
	type ExecutionMode,
} from "./types/execution-mode.types";
import { ORCHESTRATOR_TURN_BUDGET_CONTRACT_VERSION } from "./types/workflow-io.types";

export interface TurnBudgetAdmission {
	contractVersion: number;
	tokenAllowance: number;
	finalizationReserveTokens: number;
}

/**
 * The budget a new turn in `executionMode` is admitted with. `executionMode`
 * must be the server-validated mode the run will be started with.
 */
export function turnBudgetForExecutionMode(
	executionMode: ExecutionMode,
): TurnBudgetAdmission {
	const modeConfig =
		EXECUTION_MODE_CONFIGS[executionMode] ||
		EXECUTION_MODE_CONFIGS.balanced;
	return {
		contractVersion: ORCHESTRATOR_TURN_BUDGET_CONTRACT_VERSION,
		tokenAllowance:
			modeConfig.maxTotalTokens || BUDGET.defaultMaxTotalTokens,
		finalizationReserveTokens: BUDGET.synthesisReserveTokens,
	};
}
