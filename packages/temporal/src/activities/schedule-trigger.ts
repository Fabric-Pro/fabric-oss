/**
 * Schedule Trigger Activities
 *
 * Activities for handling scheduled trigger executions.
 */

import { randomUUID } from "node:crypto";
import {
	AgentExecutionAdmissionError,
	checkExecutionQuota,
	db,
	type Prisma,
} from "@repo/database";
import { isManagedAgentRunSchedule } from "@repo/database/prisma/queries/lib/managed-agent-run-schedule";
import { ApplicationFailure } from "@temporalio/common";
import { getTemporalClient } from "../client";
import type { ExecutionRequest } from "../workflows/agent-supervisor";
import { withHeartbeatTicker } from "./lib/activity-liveness";
import { dispatchManagedAgentSchedule } from "./lib/managed-agent-scheduled-dispatch";

// =============================================================================
// TYPES
// =============================================================================

interface SignalSupervisorInput {
	managedRunSchedule?: 1;
	userId?: string;
	organizationId?: string;
	occurrenceWorkflowId?: string;
	occurrenceFirstRunId?: string;
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

/** Distinct task type prevents older workers from executing the legacy signaling path. */
export async function dispatchManagedAgentScheduledExecution(
	input: SignalSupervisorInput,
): Promise<SignalSupervisorOutput> {
	if (input.managedRunSchedule !== 1 || input.triggerType !== "SCHEDULE") {
		throw ApplicationFailure.nonRetryable(
			"A managed schedule occurrence protocol is required",
			"INVALID_MANAGED_SCHEDULE_ACTIVITY",
		);
	}
	return withHeartbeatTicker(
		async () => {
			try {
				return await signalSupervisorForScheduledExecution(input);
			} catch (error) {
				if (error instanceof AgentExecutionAdmissionError) {
					return {
						success: false,
						error: "The managed schedule occurrence was refused by its admission policy.",
					};
				}
				// Native retries reconcile the same occurrence after transient storage or dispatch failures.
				throw error;
			}
		},
		{ intervalMs: 5_000, details: "managed-agent-scheduled-dispatch" },
	);
}

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
		if (
			input.managedRunSchedule === 1 ||
			isManagedAgentRunSchedule(trigger?.config)
		) {
			if (input.managedRunSchedule !== 1 || !trigger) {
				return {
					success: false,
					error: "Managed schedule occurrence identity is required.",
				};
			}
			return await dispatchManagedAgentSchedule(
				{ ...input, managedRunSchedule: 1 },
				deployment,
				trigger,
			);
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
			executionId: execution.executionId,
			input: executionInput,
			triggerType,
			triggerId: trigger.id,
			priority: 5,
			queuedAt: new Date().toISOString(),
		};

		await handle.signal("execute", executionRequest);

		return { success: true, executionId: execution.id };
	} catch (error) {
		// Reconcile the same deterministic occurrence on Activity retry. Legacy signaling remains unchanged.
		if (input.managedRunSchedule === 1) {
			throw error;
		}
		console.error("[ScheduleTrigger] Failed to signal supervisor:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
