/**
 * Trigger Step
 * Entry point for workflow execution
 */

import type { NodeExecutionResult, StepParams } from "../../types";

export async function executeTriggerStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	return {
		success: true,
		output: { triggered: true, data: params.inputs },
	};
}
