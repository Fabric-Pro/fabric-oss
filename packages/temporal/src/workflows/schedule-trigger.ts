/**
 * Schedule Trigger Workflow
 *
 * Lightweight workflow that runs when a Temporal schedule fires.
 * It signals the supervisor workflow to queue a new execution.
 */

import { ApplicationFailure, log, proxyActivities } from "@temporalio/workflow";
import type * as scheduleTriggerActivities from "../activities/schedule-trigger";

// =============================================================================
// TYPES
// =============================================================================

export interface ScheduleTriggerInput {
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
		const result = await activities.signalSupervisorForScheduledExecution({
			supervisorWorkflowId,
			deploymentId,
			triggerId,
			triggerType,
		});

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
