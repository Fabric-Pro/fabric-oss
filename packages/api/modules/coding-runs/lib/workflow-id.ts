/**
 * Deterministic Temporal workflow id for a coding run.
 *
 * Derived from the row id so it is recoverable without the persisted
 * `workflowId` column: a start that fails post-start bookkeeping and a
 * cancel that finds the column empty both address the same execution.
 */
export function codingRunWorkflowId(codingRunId: string): string {
	return `coding-run-${codingRunId}`;
}
