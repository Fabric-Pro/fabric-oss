import {
	assertProjectReportSourcesReady,
	canExecuteReportInstance,
	getTemplateInstanceExecution,
	REPORT_EXECUTION_SNAPSHOT_KEY,
	reportExecutionSnapshotSchema,
} from "@repo/database";
/** Repeat current actor, audience and schedule checks at every output publication boundary. */
export async function loadReportPublication(input: {
	executionId: string;
	userId: string;
	organizationId?: string;
}) {
	if (!input.organizationId) {
		throw new Error("An organization is required for report artifacts");
	}
	const caller = {
		userId: input.userId,
		organizationId: input.organizationId,
	};
	const execution = await getTemplateInstanceExecution(
		input.executionId,
		caller,
	);
	if (
		!execution ||
		execution.userId !== input.userId ||
		execution.status === "CANCELLED" ||
		!execution.instance.isActive ||
		!(await canExecuteReportInstance(
			execution.instance,
			caller,
			execution.parameters,
		))
	) {
		throw new Error("Report artifact access was revoked");
	}
	assertProjectReportSourcesReady(
		execution.instance.fabricConfig,
		execution.parameters,
		execution.instance.template.definition,
		execution.instance.connections,
	);
	const admitted = (execution.parameters as Record<string, unknown> | null)?.[
		REPORT_EXECUTION_SNAPSHOT_KEY
	];
	if (
		admitted &&
		reportExecutionSnapshotSchema.parse(admitted).origin === "scheduled" &&
		(execution.instance.status !== "ACTIVE" ||
			execution.instance.scheduleMode === "OFF")
	) {
		throw new Error("Scheduled report was paused before publication");
	}
	const snapshot = admitted
		? reportExecutionSnapshotSchema.parse(admitted)
		: undefined;
	return { execution, snapshot, organizationId: input.organizationId };
}
