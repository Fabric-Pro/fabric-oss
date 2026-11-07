import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
	admitTemplateInstanceExecution,
	assertPublicReportParameters,
	buildReportExecutionSnapshot,
	getProjectReportSetupReason,
	getTemplateInstance,
	publicReportParametersSchema,
	REPORT_EXECUTION_SNAPSHOT_KEY,
	reportExecutionAdmissionId,
	updateTemplateInstanceExecution,
} from "@repo/database";
import type { Prisma } from "@repo/database/prisma/generated/client";
import { getTemporalClient } from "@repo/temporal";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import type { ReportCommandContext } from "../../lib/report-command-context";

export const executeInstanceInputSchema = z.object({
	instanceId: z.string(),
	organizationId: z.string().nullable().optional(),
	// Optional parameters to override instance defaults
	parameters: publicReportParametersSchema.optional(),
	idempotencyKey: z.string().uuid().optional(),
});

export const executeInstanceProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_EXECUTE, {
			requireOrganization: true,
		}),
	)
	.input(executeInstanceInputSchema)
	.handler(handleExecuteReportInstance);

export async function handleExecuteReportInstance({
	input,
	context,
}: {
	input: z.infer<typeof executeInstanceInputSchema>;
	context: ReportCommandContext;
}) {
	const organizationId = resolveOrganizationId(
		input.organizationId,
		context.session,
	);

	if (!organizationId) {
		throw new ORPCError("BAD_REQUEST", {
			message: "An organization is required",
		});
	}

	// Get the instance with template
	const instance = await getTemplateInstance({
		id: input.instanceId,
		userId: context.user.id,
		organizationId,
	});

	if (!instance) {
		throw new ORPCError("NOT_FOUND", {
			message: "Template instance not found or access denied",
		});
	}

	const setupReason = getProjectReportSetupReason(
		instance.fabricConfig,
		instance.template.definition,
		instance.connections,
	);
	if (setupReason) {
		throw new ORPCError("BAD_REQUEST", { message: setupReason });
	}

	if (!instance.isActive) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Cannot execute inactive template instance",
		});
	}

	assertPublicReportParameters(input.parameters);
	const requestId = input.idempotencyKey ?? randomUUID();
	const workflowId = `template-instance-${reportExecutionAdmissionId(JSON.stringify([organizationId, context.user.id, input.instanceId, requestId]))}`;
	const snapshot = await buildReportExecutionSnapshot({
		instance,
		organizationId,
		userId: context.user.id,
		occurrenceAt: new Date(),
		origin: "manual",
	});
	const execution = await admitTemplateInstanceExecution({
		id: reportExecutionAdmissionId(workflowId),
		instanceId: input.instanceId,
		userId: context.user.id,
		organizationId,
		workflowId,
		parameters: JSON.parse(
			JSON.stringify({
				...input.parameters,
				[REPORT_EXECUTION_SNAPSHOT_KEY]: snapshot,
			}),
		) as Prisma.InputJsonValue,
	});
	if (
		execution.runId ||
		["COMPLETED", "FAILED", "CANCELLED"].includes(execution.status)
	) {
		return {
			executionId: execution.id,
			workflowId,
			status: execution.status,
			startConfirmed: !!execution.runId,
			message: "Report execution already admitted",
		};
	}
	// The intent is durable BEFORE the remote start. An uncertain start or receipt
	// failure stays pending for the existing dispatcher to reconcile with this same ID.
	let startConfirmed = false;
	try {
		const client = await getTemporalClient();
		const handle = await client.workflow.start(
			"templateInstanceExecutionWorkflow",
			withCorrelationMemo({
				taskQueue: "fabric-worker",
				workflowId,
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				workflowIdConflictPolicy: "FAIL",
				args: [
					{
						executionId: execution.id,
						instanceId: input.instanceId,
						userId: context.user.id,
						organizationId,
						reportingProtocol: 1,
						planEligible: true,
					},
				],
			}),
		);
		startConfirmed = true;
		await updateTemplateInstanceExecution({
			id: execution.id,
			workflowId,
			runId: handle.firstExecutionRunId,
		});
	} catch (error) {
		if (error instanceof WorkflowExecutionAlreadyStartedError) {
			try {
				const client = await getTemporalClient();
				const description = await client.workflow
					.getHandle(workflowId)
					.describe();
				startConfirmed = true;
				await updateTemplateInstanceExecution({
					id: execution.id,
					runId: description.runId,
				});
			} catch {
				/* Keep durable intent for reconciliation. */
			}
		}
		// Never mark FAILED: the remote workflow may already be running. Reconciliation
		// uses the persisted occurrence and cannot start a second workflow after edits.
	}
	recordAuditFromRequest(
		{ headers: context.headers },
		{
			category: "org",
			action: "report.execution_started",
			organizationId,
			actor: { type: "user", userId: context.user.id },
			resource: { type: "report_execution", id: execution.id },
		},
	);
	return {
		executionId: execution.id,
		workflowId,
		status: execution.status,
		startConfirmed,
		message: startConfirmed
			? "Template instance execution started"
			: "Execution admitted; awaiting start confirmation",
	};
}
