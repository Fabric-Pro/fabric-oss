import {
	claimAndAdvanceScheduledInstance,
	computeNextRunAt,
	createTemplateInstanceExecution,
	findExecutionByWorkflowId,
	getInstanceScheduleMode,
	updateTemplateInstanceExecution,
} from "@repo/database";
import { heartbeat } from "@temporalio/activity";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { getTemporalClient } from "../../client";
import type { DueReportInstance } from "./find-due-report-instances";

/**
 * Start a report-generation run for one due instance, idempotently:
 *
 *  1. Deterministic workflowId keyed on instanceId + the observed dueAt — stable across
 *     retries and poll ticks.
 *  2. create-or-get the execution row by that workflowId (durable occurrence record FIRST).
 *  3. Start templateInstanceExecutionWorkflow with the SAME args the manual Generate button
 *     uses, with REJECT_DUPLICATE + FAIL so a closed or running prior run is a no-op
 *     (WorkflowExecutionAlreadyStartedError → success).
 *  4. Advance nextRunAt LAST via compare-and-swap, so a crash before this point simply
 *     re-runs the same occurrence next tick (no lost occurrence, no double-run).
 *
 * A non-AlreadyStarted start error is rethrown (transient) so Temporal retries — the
 * occurrence is NOT marked terminally failed and nextRunAt is NOT advanced.
 *
 * Tenant fidelity (D11): the swept row's OWN userId/organizationId are used verbatim
 * (organizationId null → undefined), never a fallback tenant.
 */
export async function dispatchScheduledReportActivity(
	row: DueReportInstance,
): Promise<void> {
	heartbeat(`dispatchScheduledReport: ${row.id}`);

	// In-flight Off guard: an instance switched OFF after find-due selected it must not
	// still fire. Cheap PK read, placed BEFORE the execution row is created so OFF is a true
	// no-op (no orphan execution, no workflow.start). nextRunAt was already nulled by the Off
	// update, so the trailing CAS would no-op regardless.
	if ((await getInstanceScheduleMode(row.id)) === "OFF") {
		return;
	}

	const now = new Date();
	const dueAt = new Date(row.nextRunAt);
	const organizationId = row.organizationId ?? undefined;
	const workflowId = `scheduled-report-${row.id}-${dueAt.getTime()}`;

	const existing = await findExecutionByWorkflowId(workflowId);
	const execution =
		existing ??
		(await createTemplateInstanceExecution({
			instanceId: row.id,
			userId: row.userId,
			organizationId,
			workflowId,
		}));

	const client = await getTemporalClient();
	try {
		const handle = await client.workflow.start(
			"templateInstanceExecutionWorkflow",
			{
				taskQueue: "fabric-worker",
				workflowId,
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				workflowIdConflictPolicy: "FAIL",
				args: [
					{
						executionId: execution.id,
						instanceId: row.id,
						userId: row.userId,
						organizationId,
						jobType: "scheduled-report",
						parameters: undefined,
					},
				],
			},
		);
		await updateTemplateInstanceExecution({
			id: execution.id,
			workflowId,
			runId: handle.firstExecutionRunId,
		});
	} catch (err) {
		// A closed/running prior run with the same id → idempotent success.
		// Any other error is transient: rethrow so Temporal retries (do NOT advance).
		if (!(err instanceof WorkflowExecutionAlreadyStartedError)) {
			throw err;
		}
	}

	// Advance LAST: compare-and-swap so a concurrent schedule edit isn't clobbered.
	await claimAndAdvanceScheduledInstance(
		row.id,
		dueAt,
		computeNextRunAt(row.schedule, now),
	);
}
