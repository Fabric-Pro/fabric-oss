/**
 * Temporal handle resolution for Weave executions.
 *
 * `WeaveExecution.runId` is a required column, so a row is created with a
 * placeholder before Temporal has assigned a run id. The placeholder is
 * never a valid run id: passing it to `getHandle` targets an execution
 * that does not exist, and every signal, query, or cancel against it
 * fails. Readers must go through `resolveWeaveHandle`, which addresses the
 * workflow id alone whenever the run id is unknown.
 */

import type { getTemporalClient } from "@repo/temporal";

type TemporalClient = Awaited<ReturnType<typeof getTemporalClient>>;
type WorkflowHandle = ReturnType<TemporalClient["workflow"]["getHandle"]>;

/** Placeholder written at row creation, before a run id is known. */
export const PENDING_RUN_ID = "pending";

/** True only for a run id Temporal actually assigned. */
export function isKnownRunId(
	runId: string | null | undefined,
): runId is string {
	return (
		typeof runId === "string" &&
		runId.length > 0 &&
		runId !== PENDING_RUN_ID
	);
}

/**
 * Returns a handle for the execution's workflow: pinned to the stored run
 * id when one is known, otherwise addressed by workflow id only so Temporal
 * resolves the current run itself.
 */
export function resolveWeaveHandle(
	client: TemporalClient,
	execution: { workflowId: string; runId: string | null | undefined },
): WorkflowHandle {
	if (isKnownRunId(execution.runId)) {
		return client.workflow.getHandle(execution.workflowId, execution.runId);
	}
	return client.workflow.getHandle(execution.workflowId);
}
