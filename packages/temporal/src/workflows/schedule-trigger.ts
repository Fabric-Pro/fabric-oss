/**
 * Schedule Trigger Workflow
 *
 * Lightweight workflow that runs when a Temporal schedule fires.
 * It signals the supervisor workflow to queue a new execution.
 */

import {
	ApplicationFailure,
	log,
	patched,
	proxyActivities,
	workflowInfo,
} from "@temporalio/workflow";
import type * as scheduleTriggerActivities from "../activities/schedule-trigger";

// =============================================================================
// TYPES
// =============================================================================

export interface ScheduleTriggerInput {
	managedRunSchedule?: 1;
	userId?: string;
	organizationId?: string;
	supervisorWorkflowId: string;
	deploymentId: string;
	triggerId: string;
	triggerType: "SCHEDULE";
}

export interface ScheduleTriggerOutput {
	success: boolean;
	executionId?: string;
	error?: string;
}

// =============================================================================
// ACTIVITIES
// =============================================================================

const activities = proxyActivities<typeof scheduleTriggerActivities>({
	startToCloseTimeout: "30 seconds",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "10s",
		maximumAttempts: 3,
	},
});

export const MANAGED_AGENT_SCHEDULE_ACTIVITY_PATCH =
	"managed-agent-schedule-activity-v1";
const managedActivities = proxyActivities<typeof scheduleTriggerActivities>({
	startToCloseTimeout: "1 minute",
	heartbeatTimeout: "15 seconds",
	// Unknown handlers on older workers and transient storage outages retry until
	// a capable worker can reconcile this exact occurrence. Permanent fences
	// return false or throw a nonretryable admission refusal before any effect.
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
	},
});

// =============================================================================
// WORKFLOW IMPLEMENTATION
// =============================================================================

export async function scheduleTriggerWorkflow(
	input: ScheduleTriggerInput,
): Promise<ScheduleTriggerOutput> {
	const { supervisorWorkflowId, deploymentId, triggerId, triggerType } =
		input;

	log.info("Schedule trigger fired", {
		deploymentId,
		triggerId,
		supervisorWorkflowId,
	});

	try {
		// Create execution record and signal supervisor
		const activityInput = {
			supervisorWorkflowId,
			deploymentId,
			triggerId,
			triggerType,
			...(input.managedRunSchedule === 1
				? {
						managedRunSchedule: 1 as const,
						userId: input.userId,
						organizationId: input.organizationId,
						occurrenceWorkflowId: workflowInfo().workflowId,
						occurrenceFirstRunId:
							workflowInfo().firstExecutionRunId,
					}
				: {}),
		};
		const result =
			input.managedRunSchedule === 1 &&
			patched(MANAGED_AGENT_SCHEDULE_ACTIVITY_PATCH)
				? await managedActivities.dispatchManagedAgentScheduledExecution(
						activityInput,
					)
				: await activities.signalSupervisorForScheduledExecution(
						activityInput,
					);

		if (result.success) {
			log.info("Successfully queued scheduled execution", {
				executionId: result.executionId,
			});
			return {
				success: true,
				executionId: result.executionId,
			};
		}

		log.warn("Failed to queue scheduled execution", {
			error: result.error,
		});
		throw ApplicationFailure.nonRetryable(
			result.error || "Failed to queue scheduled execution",
			"SCHEDULE_TRIGGER_FAILED",
		);
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		log.error("Schedule trigger workflow failed", {
			error: errorMessage,
		});
		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"SCHEDULE_TRIGGER_FAILED",
		);
	}
}

/** Distinct type fences older workers from consuming the native managed protocol. */
export async function managedAgentRunScheduleWorkflow(
	input: ScheduleTriggerInput,
): Promise<ScheduleTriggerOutput> {
	if (input.managedRunSchedule !== 1) {
		throw ApplicationFailure.nonRetryable(
			"Managed agent schedule protocol is required",
			"INVALID_MANAGED_SCHEDULE",
		);
	}
	return scheduleTriggerWorkflow(input);
}
