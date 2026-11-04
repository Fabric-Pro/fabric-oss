/**
 * Execute Agent Procedure
 *
 * Triggers a manual execution of a deployed agent by sending a signal
 * to the supervisor workflow.
 */

import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { getAgentImplementationAvailability } from "@repo/agent-types/agent-implementation";
import {
	checkExecutionQuota,
	db,
	getAgentDeploymentById,
	getAgentTemplateInstanceForExecution,
	isDeploymentOwnerCurrentMember,
	type Prisma,
} from "@repo/database";
import type { ExecutionRequest } from "@repo/temporal";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

const executeInputSchema = z.object({
	deploymentId: z.string(),
	organizationId: z.string().nullable().optional(),
	input: z.record(z.string(), z.unknown()).optional(),
	priority: z.enum(["LOW", "NORMAL", "HIGH", "CRITICAL"]).default("NORMAL"),
	webhookUrl: z.string().url().optional(),
	idempotencyKey: z.string().optional(),
});

// Map string priority to numeric
const priorityMap: Record<string, number> = {
	LOW: 1,
	NORMAL: 5,
	HIGH: 8,
	CRITICAL: 10,
};

async function executionDeployment(
	deploymentId: string,
	userId: string,
	organizationId: string | null | undefined,
) {
	if (!organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "An organization is required to execute this deployment",
		});
	}
	const deployment = await getAgentDeploymentById(deploymentId, {
		userId,
		organizationId,
	});
	if (
		!deployment ||
		deployment.id !== deploymentId ||
		deployment.userId !== userId ||
		deployment.organizationId !== organizationId
	) {
		throw new ORPCError("NOT_FOUND", { message: "Deployment not found" });
	}
	const scoped = await getAgentTemplateInstanceForExecution({
		instanceId: deployment.instanceId,
		userId,
		organizationId,
	});
	if (
		!scoped ||
		scoped.instance.id !== deployment.instanceId ||
		scoped.instance.organizationId !== organizationId
	) {
		throw new ORPCError("NOT_FOUND", {
			message: "Agent instance not found or access denied",
		});
	}
	const availability = getAgentImplementationAvailability(
		scoped.instance.customInstructions,
	);
	if (!availability.available) {
		throw new ORPCError("BAD_REQUEST", { message: availability.reason });
	}
	return deployment;
}

export const executeDeploymentProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.AGENT_EXECUTE, {
			requireOrganization: true,
		}),
	)
	.input(executeInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify access
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				userId,
			);
			if (!membership) {
				throw new Error(
					"You don't have permission to execute this deployment",
				);
			}
		}

		const deployment = await executionDeployment(
			input.deploymentId,
			userId,
			organizationId,
		);

		if (deployment.status !== "ACTIVE") {
			throw new Error(
				`Cannot execute deployment with status: ${deployment.status}`,
			);
		}

		if (!deployment.supervisorWorkflowId) {
			throw new Error("Deployment has no active supervisor workflow");
		}

		// Check execution quota
		const quotaCheck = await checkExecutionQuota(
			deployment.id,
			userId,
			organizationId ?? undefined,
		);
		if (!quotaCheck.allowed) {
			throw new Error(quotaCheck.reason || "Execution quota exceeded");
		}

		if (!(await isDeploymentOwnerCurrentMember(deployment))) {
			throw new Error("Deployment not found");
		}

		// Create execution record
		const executionId = randomUUID();
		const execution = await db.agentDeploymentExecution.create({
			data: {
				deploymentId: deployment.id,
				executionId,
				userId,
				organizationId,
				triggerType: "MANUAL",
				input: (input.input || {}) as Prisma.InputJsonValue,
				priority: priorityMap[input.priority] ?? 5,
				status: "PENDING",
				queuedAt: new Date(),
			},
		});

		// Signal the supervisor to execute
		const temporalClient = await getTemporalClient();
		const handle = temporalClient.workflow.getHandle(
			deployment.supervisorWorkflowId,
		);

		const executionRequest: ExecutionRequest = {
			executionId: execution.executionId,
			input: input.input || {},
			triggerType: "MANUAL",
			priority: priorityMap[input.priority] ?? 5,
			queuedAt: new Date().toISOString(),
		};

		await handle.signal("execute", executionRequest);

		return {
			execution: {
				id: execution.id,
				deploymentId: deployment.id,
				status: execution.status,
				priority: input.priority,
				createdAt: execution.createdAt,
			},
			message: "Execution request queued",
		};
	});

// =============================================================================
// CANCEL EXECUTION
// =============================================================================

const cancelExecutionInputSchema = z.object({
	deploymentId: z.string(),
	executionId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const cancelExecutionProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.AGENT_EXECUTE, {
			requireOrganization: true,
		}),
	)
	.input(cancelExecutionInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify access
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				userId,
			);
			if (!membership) {
				throw new Error(
					"You don't have permission to cancel this execution",
				);
			}
		}

		const deployment = await executionDeployment(
			input.deploymentId,
			userId,
			organizationId,
		);

		if (!deployment.supervisorWorkflowId) {
			throw new Error("Deployment has no active supervisor workflow");
		}

		const execution = await db.agentDeploymentExecution.findFirst({
			where: {
				id: input.executionId,
				deploymentId: deployment.id,
				userId,
				organizationId: deployment.organizationId,
			},
			select: {
				id: true,
				executionId: true,
				deploymentId: true,
				userId: true,
				organizationId: true,
			},
		});
		if (
			!execution ||
			execution.deploymentId !== deployment.id ||
			execution.userId !== userId ||
			execution.organizationId !== deployment.organizationId
		) {
			throw new ORPCError("NOT_FOUND", {
				message: "Execution not found",
			});
		}

		// Signal the supervisor to cancel the execution
		const temporalClient = await getTemporalClient();
		const handle = temporalClient.workflow.getHandle(
			deployment.supervisorWorkflowId,
		);

		await handle.signal("cancelExecution", {
			executionId: execution.executionId,
		});

		return { success: true, message: "Execution cancellation requested" };
	});
