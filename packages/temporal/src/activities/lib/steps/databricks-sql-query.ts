import type { NodeExecutionResult, StepParams } from "../../types";
import { executeDatabricksStatementStep } from "../databricks-sql-step";
export async function executeDatabricksSqlStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	return executeDatabricksStatementStep(params, false);
}
