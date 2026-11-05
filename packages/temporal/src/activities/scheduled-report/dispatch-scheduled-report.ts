import {
	admitTemplateInstanceExecution,
	assertProjectReportSourcesReady,
	buildReportExecutionSnapshot,
	canExecuteReportInstance,
	claimAndAdvanceScheduledInstance,
	computeNextRunAt,
	getProjectReportSetupReason,
	getTemplateInstance,
	REPORT_EXECUTION_SNAPSHOT_KEY,
	reportExecutionAdmissionId,
	updateTemplateInstanceExecution,
} from "@repo/database";
import type { Prisma } from "@repo/database/prisma/generated/client";
import { heartbeat } from "@temporalio/activity";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { getTemporalClient } from "../../client";
import type { DueReportInstance } from "./find-due-report-instances";

/** Durable admission first; the immutable occurrence ID never contains configuration hashes.
 * On an uncertain start/receipt, retry the SAME occurrence. Advance its due time last.
 */
export async function dispatchScheduledReportActivity(
	row: DueReportInstance,
): Promise<void> {
	heartbeat(`dispatchScheduledReport: ${row.id}`);
	if (!row.organizationId) {
		return;
	}
	const instance = await getTemplateInstance({
		id: row.id,
		userId: row.userId,
		organizationId: row.organizationId,
	});
	if (
		!instance ||
		!instance.isActive ||
		instance.status !== "ACTIVE" ||
		instance.scheduleMode === "OFF"
	) {
		return;
	}
	// Do not dispatch a stale sweep row after a schedule edit.
	if (instance.nextRunAt?.getTime() !== new Date(row.nextRunAt).getTime()) {
		return;
	}
	if (
		getProjectReportSetupReason(
			instance.fabricConfig,
			instance.template.definition,
			instance.connections,
		)
	) {
		return;
	}
	const caller = { userId: row.userId, organizationId: row.organizationId };
	if (!(await canExecuteReportInstance(instance, caller))) {
		return;
	}
	const dueAt = new Date(row.nextRunAt);
	const workflowId = `scheduled-report-${row.id}-${dueAt.getTime()}`;
	const snapshot = await buildReportExecutionSnapshot({
		instance,
		organizationId: row.organizationId,
		userId: row.userId,
		occurrenceAt: dueAt,
		origin: "scheduled",
	});
	const execution = await admitTemplateInstanceExecution({
		id: reportExecutionAdmissionId(workflowId),
		instanceId: row.id,
		userId: row.userId,
		organizationId: row.organizationId,
		workflowId,
		parameters: JSON.parse(
			JSON.stringify({ [REPORT_EXECUTION_SNAPSHOT_KEY]: snapshot }),
		) as Prisma.InputJsonValue,
	});
	// An edit cannot broaden the original occurrence's audience or revive revoked access.
	if (
		!(await canExecuteReportInstance(
			instance,
			caller,
			execution.parameters,
		))
	) {
		return;
	}
	assertProjectReportSourcesReady(
		instance.fabricConfig,
		execution.parameters,
		instance.template.definition,
		instance.connections,
	);
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
						organizationId: row.organizationId,
						jobType: "scheduled-report",
						...((
							execution.parameters as Record<
								string,
								unknown
							> | null
						)?.[REPORT_EXECUTION_SNAPSHOT_KEY]
							? { reportingProtocol: 1 }
							: {}),
					},
				],
			},
		);
		await updateTemplateInstanceExecution({
			id: execution.id,
			workflowId,
			runId: handle.firstExecutionRunId,
		});
	} catch (error) {
		if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
			throw error;
		}
		// Repair a receipt lost after a successful start, including a closed execution.
		const description = await client.workflow
			.getHandle(workflowId)
			.describe();
		await updateTemplateInstanceExecution({
			id: execution.id,
			workflowId,
			runId: description.runId,
		});
	}
	await claimAndAdvanceScheduledInstance(
		row.id,
		dueAt,
		computeNextRunAt(row.schedule, new Date()),
	);
}
