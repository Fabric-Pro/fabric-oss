import {
	assertProjectReportSourcesReady,
	canExecuteReportInstance,
	getTemplateInstance,
	listPendingReportExecutionStarts,
	REPORT_EXECUTION_SNAPSHOT_KEY,
	reportExecutionSnapshotSchema,
	updateTemplateInstanceExecution,
} from "@repo/database";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { getTemporalClient } from "../../client";

/** Bounded repair inside the existing cadence sweep. Never borrows manual personal-plan eligibility. */
export async function reconcileReportStarts(limit: number): Promise<void> {
	for (const execution of await listPendingReportExecutionStarts(limit)) {
		try {
			if (!execution.organizationId || !execution.workflowId) {
				continue;
			}
			const parameters = execution.parameters as Record<
				string,
				unknown
			> | null;
			const parsed = reportExecutionSnapshotSchema.safeParse(
				parameters?.[REPORT_EXECUTION_SNAPSHOT_KEY],
			);
			if (!parsed.success) {
				continue; // legacy starts have no pinned admission protocol
			}
			const snapshot = parsed.data;
			if (
				snapshot.organizationId !== execution.organizationId ||
				snapshot.userId !== execution.userId ||
				snapshot.instanceId !== execution.instanceId
			) {
				continue;
			}
			const caller = {
				userId: execution.userId,
				organizationId: execution.organizationId,
			};
			const instance = await getTemplateInstance({
				id: execution.instanceId,
				...caller,
			});
			if (
				!instance ||
				!instance.isActive ||
				(snapshot.origin === "scheduled" &&
					(instance.scheduleMode === "OFF" ||
						instance.status !== "ACTIVE")) ||
				!(await canExecuteReportInstance(
					instance,
					caller,
					execution.parameters,
				))
			) {
				continue;
			}
			assertProjectReportSourcesReady(
				instance.fabricConfig,
				execution.parameters,
				instance.template.definition,
				instance.connections,
			);
			const client = await getTemporalClient();
			let runId: string;
			try {
				const handle = await client.workflow.start(
					"templateInstanceExecutionWorkflow",
					{
						taskQueue: "fabric-worker",
						workflowId: execution.workflowId,
						workflowIdReusePolicy: "REJECT_DUPLICATE",
						workflowIdConflictPolicy: "FAIL",
						args: [
							{
								executionId: execution.id,
								instanceId: execution.instanceId,
								...caller,
								reportingProtocol: 1,
								...(snapshot.origin === "scheduled"
									? { jobType: "scheduled-report" }
									: {}),
								planEligible: false,
							},
						],
					},
				);
				runId = handle.firstExecutionRunId;
			} catch (error) {
				if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
					throw error;
				}
				runId = (
					await client.workflow
						.getHandle(execution.workflowId)
						.describe()
				).runId;
			}
			await updateTemplateInstanceExecution({ id: execution.id, runId });
		} catch {
			// A transient error leaves the same durable intent for the next sweep.
			// Never convert an ambiguous remote start into a terminal report failure.
		}
	}
}
