/**
 * Kickoff workflow for schedule-triggered workflow-builder runs.
 *
 * A Temporal Schedule starts this, not the executor itself, because the
 * executor needs a `WorkflowExecution` row id and a schedule's arguments are
 * fixed at creation. This creates the row for each fire and then runs the
 * graph as a child workflow, so the run shows up in history exactly like a
 * manual one.
 */

import { executeChild, proxyActivities } from "@temporalio/workflow";
import type * as kickoffActivities from "../activities/workflow-schedule-kickoff";
import type {
	WorkflowBuilderExecutionInput,
	WorkflowBuilderExecutionOutput,
} from "./workflow-builder-execution";

const { createScheduledExecution } = proxyActivities<typeof kickoffActivities>({
	startToCloseTimeout: "1 minute",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export interface ScheduledWorkflowKickoffInput {
	workflowId: string;
	userId: string;
	organizationId?: string;
	projectId?: string;
	triggerData?: Record<string, unknown>;
}

export interface ScheduledWorkflowKickoffOutput {
	started: boolean;
	executionId?: string;
	status?: string;
	reason?: string;
}

export async function scheduledWorkflowKickoff(
	input: ScheduledWorkflowKickoffInput,
): Promise<ScheduledWorkflowKickoffOutput> {
	const prepared = await createScheduledExecution({
		workflowId: input.workflowId,
		userId: input.userId,
		organizationId: input.organizationId,
	});

	if (!prepared.shouldRun) {
		// Deleted or unpublished since the schedule was created. Skipping is
		// correct: a tick that cannot run is not a failure, and failing here
		// would retry a run nobody wants.
		return { started: false, reason: prepared.reason };
	}

	const executionInput: WorkflowBuilderExecutionInput = {
		executionId: prepared.executionId,
		workflowId: input.workflowId,
		userId: input.userId,
		organizationId: input.organizationId,
		projectId: prepared.projectId ?? input.projectId,
		triggerData: input.triggerData ?? { source: "schedule" },
	};

	const result: WorkflowBuilderExecutionOutput = await executeChild(
		"workflowBuilderExecutionWorkflow",
		{
			args: [executionInput],
			// One child per execution row keeps ids unique across fires.
			workflowId: `workflow-execution-${prepared.executionId}`,
		},
	);

	return {
		started: true,
		executionId: prepared.executionId,
		status: result.status,
	};
}
