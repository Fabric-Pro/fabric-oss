import { workflowInfo } from "@temporalio/workflow";
import { BUDGET } from "./orchestrator-config";

/** Call only under MAIN_ROUND_BUDGET_PATCH; the start event is replay-safe. */
export function advisorDeadline() {
	const startedAt = workflowInfo().startTime.getTime();
	return {
		startedAt,
		stopAt: startedAt + BUDGET.maxIterativeExecutionSeconds * 1000,
	};
}
