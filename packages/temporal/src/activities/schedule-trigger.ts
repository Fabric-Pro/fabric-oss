/**
 * Schedule Trigger Activities
 *
 * Activities for handling scheduled trigger executions.
 */

import { randomUUID } from "node:crypto";
import { checkExecutionQuota, db, type Prisma } from "@repo/database";
import { getTemporalClient } from "../client";
import type { ExecutionRequest } from "../workflows/agent-supervisor";

// =============================================================================
// TYPES
// =============================================================================

interface SignalSupervisorInput {
	supervisorWorkflowId: string;
	deploymentId: string;
	triggerId: string;
	triggerType: "SCHEDULE";
}

interface SignalSupervisorOutput {
	success: boolean;
	executionId?: string;
	error?: string;
}

// =============================================================================
// ACTIVITIES
// =============================================================================

/**
 * Signal the supervisor workflow to queue a scheduled execution
 */
export async function signalSupervisorForScheduledExecution(
	input: SignalSupervisorInput,
): Promise<SignalSupervisorOutput> {
	const { supervisorWorkflowId, deploymentId, triggerId, triggerType } =
		input;

	try {
		// Trigger is scoped to deploymentId — without this, a
		// `(deploymentId, triggerId)` pair from unrelated rows could
		// cross-wire a trigger from deployment A onto deployment B.
		const [deployment, trigger] = await Promise.all([
			db.agentDeployment.findUnique({ where: { id: deploymentId } }),
			db.agentDeploymentTrigger.findFirst({
				where: { id: triggerId, deploymentId },
			}),
		]);

		if (!deployment) {
			return { success: false, error: "Deployment not found" };
		}
		if (deployment.status !== "ACTIVE") {
			return {
				success: false,
				error: `Deployment is not active: ${deployment.status}`,
			};
		}
		if (!trigger) {
			return {
				success: false,
				error: "Trigger not found for this deployment",
			};
		}
		if (!trigger.isActive) {
			return { success: false, error: "Trigger is not active" };
		}

		// Check execution quota
		const quotaCheck = await checkExecutionQuota(
			deploymentId,
			deployment.userId,
			deployment.organizationId ?? undefined,
		);

		if (!quotaCheck.allowed) {
			return {
				success: false,
				error: quotaCheck.reason || "Execution quota exceeded",
			};
		}

		// Create execution record
		const executionId = randomUUID();
		const triggerConfig = trigger.config as { name?: string } | null;

		const executionInput = {
			_scheduled: {
				triggerId: trigger.id,
				triggerName: triggerConfig?.name || "scheduled",
				scheduledAt: new Date().toISOString(),
				cronExpression: trigger.cronExpression,
				timezone: trigger.timezone,
			},
		};

		const execution = await db.agentDeploymentExecution.create({
			data: {
				deploymentId,
				executionId,
				userId: deployment.userId,
				organizationId: deployment.organizationId,
				triggerType: "SCHEDULE",
				triggerId: trigger.id,
				input: executionInput as Prisma.InputJsonValue,
				priority: 5, // Default priority for scheduled executions
				status: "PENDING",
				queuedAt: new Date(),
			},
		});

		// Update trigger stats
		await db.agentDeploymentTrigger.update({
			where: { id: trigger.id },
			data: {
				lastRunAt: new Date(),
				totalExecutions: { increment: 1 },
				lastExecutionId: execution.id,
			},
		});

		// Signal the supervisor to execute
		const temporalClient = await getTemporalClient();
		const handle = temporalClient.workflow.getHandle(supervisorWorkflowId);

		const executionRequest: ExecutionRequest = {
			executionId: execution.id,
			input: executionInput,
			triggerType,
			triggerId: trigger.id,
			priority: 5,
			queuedAt: new Date().toISOString(),
		};

		await handle.signal("execute", executionRequest);

		return { success: true, executionId: execution.id };
	} catch (error) {
		console.error("[ScheduleTrigger] Failed to signal supervisor:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
