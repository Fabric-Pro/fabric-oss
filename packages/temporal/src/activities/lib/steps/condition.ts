/**
 * Condition Step
 * Evaluates a boolean expression to control workflow branching
 */

import type { NodeExecutionResult, StepParams } from "../../types";

export async function executeConditionStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { expression } = params.nodeConfig as { expression?: string };

	if (!expression) {
		return { success: false, error: "Expression is required" };
	}

	try {
		// Use safe expression evaluation instead of dangerous eval()
		const { safeEvaluateExpression } = await import(
			"../safe-expression-evaluator"
		);
		const result = safeEvaluateExpression(expression, params.inputs);
		return { success: true, output: { result } };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Condition evaluation failed",
		};
	}
}
