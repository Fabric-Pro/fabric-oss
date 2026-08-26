import { ORPCError } from "@orpc/server";
import {
	createTemplateInstanceExecution,
	getTemplateInstance,
	updateTemplateInstanceExecution,
} from "@repo/database";
import type { Prisma } from "@repo/database/prisma/generated/client";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const executeInstanceInputSchema = z.object({
	instanceId: z.string(),
	organizationId: z.string().nullable().optional(),
	// Optional parameters to override instance defaults
	parameters: z.record(z.string(), z.unknown()).optional(),
});

export const executeInstanceProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_EXECUTE))
	.input(executeInstanceInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

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

		if (!instance.isActive) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Cannot execute inactive template instance",
			});
		}

		// Create execution record
		const execution = await createTemplateInstanceExecution({
			instanceId: input.instanceId,
			userId: context.user.id,
			organizationId,
			parameters: input.parameters as Prisma.InputJsonValue | undefined,
		});

		// Trigger Temporal workflow
		try {
			const client = await getTemporalClient();
			const workflowId = `template-instance-${execution.id}-${Date.now()}`;

			const handle = await client.workflow.start(
				"templateInstanceExecutionWorkflow",
				withCorrelationMemo({
					taskQueue: "fabric-worker",
					workflowId,
					args: [
						{
							executionId: execution.id,
							instanceId: input.instanceId,
							userId: context.user.id,
							organizationId,
							parameters: input.parameters,
						},
					],
				}),
			);

			// Update execution with workflow ID and run ID
			await updateTemplateInstanceExecution({
				id: execution.id,
				workflowId,
				runId: handle.firstExecutionRunId,
			});

			return {
				executionId: execution.id,
				workflowId,
				status: "PENDING",
				message: "Template instance execution started",
			};
		} catch (error) {
			console.error(
				"Failed to start template instance execution:",
				error,
			);

			// Update execution status to failed
			await updateTemplateInstanceExecution({
				id: execution.id,
				status: "FAILED",
				error:
					error instanceof Error
						? error.message
						: "Failed to start workflow",
			});

			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to start template execution",
			});
		}
	});
