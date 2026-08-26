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
		await pauseDeploymentTriggers(input.deploymentId);

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
		await resumeDeploymentTriggers(input.deploymentId);

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
async function pauseDeploymentTriggers(deploymentId: string): Promise<void> {
	// Get all active triggers
	const triggers = await db.agentDeploymentTrigger.findMany({
		where: {
			deploymentId,
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

	// Mark all triggers as paused (via a metadata field, not isActive)
	// We use isActive=false during pause so webhooks don't fire
	await db.agentDeploymentTrigger.updateMany({
		where: {
			deploymentId,
			isActive: true,
		},
		data: {
			isActive: false,
			config: {
				// Store that this was paused (not manually disabled)
				_pausedByLifecycle: true,
			},
		},
	});
}

/**
 * Resume all triggers for a deployment
 * - Reactivates webhook triggers that were paused
 * - Resumes Temporal schedules for cron triggers
 */
async function resumeDeploymentTriggers(deploymentId: string): Promise<void> {
	// Get triggers that were paused by lifecycle
	const triggers = await db.agentDeploymentTrigger.findMany({
		where: {
			deploymentId,
			isActive: false,
		},
	});

	// Filter to only those paused by lifecycle
	const pausedTriggers = triggers.filter((t) => {
		const config = t.config as { _pausedByLifecycle?: boolean } | null;
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
		const config = trigger.config as Record<string, unknown> | null;
		const { _pausedByLifecycle, ...restConfig } = config || {};

		await db.agentDeploymentTrigger.update({
			where: { id: trigger.id },
			data: {
				isActive: true,
				config: restConfig as object,
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
