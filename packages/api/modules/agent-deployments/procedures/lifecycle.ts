/**
 * Deployment Lifecycle Procedures
 *
 * Handles pause, resume, and terminate operations by signaling
 * the supervisor workflow.
 */

import {
	db,
	decrementDeploymentQuota,
	getAgentDeploymentById,
	Prisma,
} from "@repo/database";
import { getScheduleClient, getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import { assertPersistedSlackTriggerBinding } from "../lib/sync-triggers";

// =============================================================================
// PAUSE
// =============================================================================

const pauseInputSchema = z.object({
	deploymentId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const pauseDeploymentProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.input(pauseInputSchema)
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
					"You don't have permission to pause this deployment",
				);
			}
		}

		const deployment = await getAgentDeploymentById(input.deploymentId, {
			userId,
			organizationId,
		});

		if (!deployment) {
			throw new Error("Deployment not found");
		}

		if (deployment.status !== "ACTIVE") {
			throw new Error(
				`Cannot pause deployment with status: ${deployment.status}`,
			);
		}

		if (!deployment.supervisorWorkflowId) {
			throw new Error("Deployment has no active supervisor workflow");
		}

		// Signal the supervisor to pause
		const temporalClient = await getTemporalClient();
		const handle = temporalClient.workflow.getHandle(
			deployment.supervisorWorkflowId,
		);

		await handle.signal("pause");

		// Pause all triggers for this deployment
		await pauseDeploymentTriggers({
			deploymentId: input.deploymentId,
			userId,
			organizationId: deployment.organizationId,
		});

		return { success: true, message: "Deployment pause signal sent" };
	});

// =============================================================================
// RESUME
// =============================================================================

const resumeInputSchema = z.object({
	deploymentId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const resumeDeploymentProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.input(resumeInputSchema)
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
					"You don't have permission to resume this deployment",
				);
			}
		}

		const deployment = await getAgentDeploymentById(input.deploymentId, {
			userId,
			organizationId,
		});

		if (!deployment) {
			throw new Error("Deployment not found");
		}

		if (deployment.status !== "PAUSED") {
			throw new Error(
				`Cannot resume deployment with status: ${deployment.status}`,
			);
		}

		if (!deployment.supervisorWorkflowId) {
			throw new Error("Deployment has no active supervisor workflow");
		}

		// Signal the supervisor to resume
		const temporalClient = await getTemporalClient();
		const handle = temporalClient.workflow.getHandle(
			deployment.supervisorWorkflowId,
		);

		await handle.signal("resume");

		// Resume all triggers for this deployment
		await resumeDeploymentTriggers({
			deploymentId: input.deploymentId,
			userId,
			organizationId: deployment.organizationId,
		});

		return { success: true, message: "Deployment resume signal sent" };
	});

// =============================================================================
// TERMINATE
// =============================================================================

const terminateInputSchema = z.object({
	deploymentId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const terminateDeploymentProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_UPDATE))
	.input(terminateInputSchema)
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
					"You don't have permission to terminate this deployment",
				);
			}
		}

		const deployment = await getAgentDeploymentById(input.deploymentId, {
			userId,
			organizationId,
		});

		if (!deployment) {
			throw new Error("Deployment not found");
		}

		if (deployment.status === "TERMINATED") {
			throw new Error("Deployment is already terminated");
		}

		if (deployment.supervisorWorkflowId) {
			// Signal the supervisor to terminate
			const temporalClient = await getTemporalClient();
			const handle = temporalClient.workflow.getHandle(
				deployment.supervisorWorkflowId,
			);

			try {
				await handle.signal("terminate");
			} catch {
				// Workflow might already be completed/failed
				console.warn(
					`Could not signal supervisor ${deployment.supervisorWorkflowId}`,
				);
			}
		}

		// Deactivate and delete all triggers for this deployment
		await terminateDeploymentTriggers(input.deploymentId);

		// Decrement quota
		await decrementDeploymentQuota(userId, organizationId);

		return { success: true, message: "Deployment termination initiated" };
	});

// =============================================================================
// TRIGGER LIFECYCLE HELPERS
// =============================================================================

/**
 * Pause all triggers for a deployment
 * - Marks webhook triggers as inactive
 * - Pauses Temporal schedules for cron triggers
 */
interface TriggerLifecycleOwner {
	deploymentId: string;
	userId: string;
	organizationId: string | null;
}
function objectTriggerConfig(config: unknown): Record<string, unknown> {
	if (config === null) {
		return {};
	}
	if (typeof config !== "object" || Array.isArray(config)) {
		throw new Error(
			"Trigger configuration must be an object before changing its lifecycle state",
		);
	}
	return config as Record<string, unknown>;
}
export async function pauseDeploymentTriggers(
	ownerOrDeploymentId: TriggerLifecycleOwner | string,
): Promise<void> {
	const owner =
		typeof ownerOrDeploymentId === "string"
			? { deploymentId: ownerOrDeploymentId }
			: ownerOrDeploymentId;
	// Get all active triggers
	const triggers = await db.agentDeploymentTrigger.findMany({
		where: {
			...owner,
			isActive: true,
		},
	});

	if (triggers.length === 0) {
		return;
	}

	// Pause Temporal schedules for cron triggers
	const scheduleTriggers = triggers.filter((t) => t.type === "SCHEDULE");
	if (scheduleTriggers.length > 0) {
		try {
			const scheduleClient = await getScheduleClient();
			for (const trigger of scheduleTriggers) {
				const scheduleId = `trigger-schedule-${trigger.id}`;
				try {
					const handle = scheduleClient.getHandle(scheduleId);
					await handle.pause();
				} catch {
					// Schedule might not exist yet
					console.warn(`Could not pause schedule ${scheduleId}`);
				}
			}
		} catch (error) {
			console.error("Failed to pause schedules:", error);
		}
	}

	// Preserve each definition and add only the internal pause marker. The prior
	// configuration and active state fence concurrent edits instead of overwriting them.
	for (const trigger of triggers) {
		const config = objectTriggerConfig(trigger.config);
		await db.agentDeploymentTrigger.updateMany({
			where: {
				id: trigger.id,
				...owner,
				isActive: true,
				config: { equals: trigger.config ?? Prisma.JsonNull },
			},
			data: {
				isActive: false,
				config: {
					...config,
					_pausedByLifecycle: true,
				} as Prisma.InputJsonObject,
			},
		});
	}
}

/**
 * Resume all triggers for a deployment
 * - Reactivates webhook triggers that were paused
 * - Resumes Temporal schedules for cron triggers
 */
export async function resumeDeploymentTriggers(
	ownerOrDeploymentId: TriggerLifecycleOwner | string,
): Promise<void> {
	const owner =
		typeof ownerOrDeploymentId === "string"
			? { deploymentId: ownerOrDeploymentId }
			: ownerOrDeploymentId;
	const deploymentId = owner.deploymentId;
	// Get triggers that were paused by lifecycle
	const triggers = await db.agentDeploymentTrigger.findMany({
		where: {
			...owner,
			isActive: false,
		},
	});

	// Filter to only those paused by lifecycle
	const pausedTriggers = triggers.filter((t) => {
		const config = objectTriggerConfig(t.config);
		return config?._pausedByLifecycle === true;
	});

	if (pausedTriggers.length === 0) {
		return;
	}

	// Resume Temporal schedules for cron triggers
	const scheduleTriggers = pausedTriggers.filter(
		(t) => t.type === "SCHEDULE",
	);
	if (scheduleTriggers.length > 0) {
		try {
			const scheduleClient = await getScheduleClient();
			for (const trigger of scheduleTriggers) {
				const scheduleId = `trigger-schedule-${trigger.id}`;
				try {
					const handle = scheduleClient.getHandle(scheduleId);
					await handle.unpause();
				} catch {
					// Schedule might not exist - try to create it
					console.warn(
						`Could not unpause schedule ${scheduleId}, will recreate`,
					);
				}
			}
		} catch (error) {
			console.error("Failed to resume schedules:", error);
		}
	}

	// Reactivate triggers and clear the lifecycle pause flag
	for (const trigger of pausedTriggers) {
		const config = objectTriggerConfig(trigger.config);
		const { _pausedByLifecycle, ...restConfig } = config || {};
		if (Boolean(trigger.slackTeamId) || restConfig.channel === "slack") {
			try {
				await assertPersistedSlackTriggerBinding({
					...trigger,
					config: restConfig,
				});
			} catch {
				console.warn(
					"[AgentDeployments] Slack trigger binding failed during resume",
					{
						triggerId: trigger.id,
						deploymentId,
					},
				);
				continue;
			}
		}

		await db.agentDeploymentTrigger.updateMany({
			where: {
				id: trigger.id,
				...owner,
				isActive: false,
				config: { equals: trigger.config ?? Prisma.JsonNull },
			},
			data: {
				isActive: true,
				config: restConfig as Prisma.InputJsonObject,
			},
		});
	}
}

/**
 * Terminate all triggers for a deployment
 * - Deletes Temporal schedules for cron triggers
 * - Deletes all trigger records
 */
async function terminateDeploymentTriggers(
	deploymentId: string,
): Promise<void> {
	// Get all triggers
	const triggers = await db.agentDeploymentTrigger.findMany({
		where: { deploymentId },
	});

	if (triggers.length === 0) {
		return;
	}

	// Delete Temporal schedules for cron triggers
	const scheduleTriggers = triggers.filter((t) => t.type === "SCHEDULE");
	if (scheduleTriggers.length > 0) {
		try {
			const scheduleClient = await getScheduleClient();
			for (const trigger of scheduleTriggers) {
				const scheduleId = `trigger-schedule-${trigger.id}`;
				try {
					const handle = scheduleClient.getHandle(scheduleId);
					await handle.delete();
				} catch {
					// Schedule might not exist
					console.warn(`Could not delete schedule ${scheduleId}`);
				}
			}
		} catch (error) {
			console.error("Failed to delete schedules:", error);
		}
	}

	// Delete all trigger records
	await db.agentDeploymentTrigger.deleteMany({
		where: { deploymentId },
	});
}
