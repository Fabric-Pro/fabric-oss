/**
 * Plan Management Activities
 *
 * Activities for managing workflow plans and their status.
 */

import { db, type Prisma } from "@repo/database";
import type {
	AddWorkflowLogInput,
	InitializeWorkflowPlanInput,
	UpdateWorkflowPlanInput,
} from "./types";

/**
 * Initialize a workflow plan record
 */
export async function initializeWorkflowPlan(
	input: InitializeWorkflowPlanInput,
): Promise<void> {
	const { planId, taskId, projectId, userId, organizationId, status } = input;

	await db.taskWorkflowPlan.create({
		data: {
			id: planId,
			taskId,
			projectId,
			userId,
			organizationId,
			status,
			steps: [],
		},
	});

	// Update the StoryTask with the plan reference
	await db.storyTask.update({
		where: { id: taskId },
		data: {
			agentTaskId: planId,
			agentStatus: "working",
			agentStartedAt: new Date(),
		},
	});
}

/**
 * Update a workflow plan
 */
export async function updateWorkflowPlan(
	input: UpdateWorkflowPlanInput,
): Promise<void> {
	const { planId, ...data } = input;

	const updateData: any = {};

	if (data.status !== undefined) {
		updateData.status = data.status;
	}
	if (data.steps !== undefined) {
		updateData.steps = data.steps;
	}
	if (data.currentStepIndex !== undefined) {
		updateData.currentStepIndex = data.currentStepIndex;
	}
	if (data.checkpointData !== undefined) {
		updateData.checkpointData = data.checkpointData;
	}
	if (data.result !== undefined) {
		updateData.result = data.result;
	}
	if (data.summary !== undefined) {
		updateData.summary = data.summary;
	}

	await db.taskWorkflowPlan.update({
		where: { id: planId },
		data: updateData,
	});

	// Also update StoryTask status if plan status changed
	if (data.status) {
		const plan = await db.taskWorkflowPlan.findUnique({
			where: { id: planId },
			select: { taskId: true },
		});

		if (plan) {
			let agentStatus: string;
			switch (data.status) {
				case "running":
				case "executing":
					agentStatus = "working";
					break;
				case "checkpoint":
					agentStatus = "awaiting_approval";
					break;
				case "completed":
					agentStatus = "completed";
					break;
				case "failed":
					agentStatus = "failed";
					break;
				case "cancelled":
					agentStatus = "cancelled";
					break;
				default:
					agentStatus = data.status;
			}

			await db.storyTask.update({
				where: { id: plan.taskId },
				data: {
					agentStatus,
					...(["completed", "failed", "cancelled"].includes(
						data.status,
					) && {
						agentCompletedAt: new Date(),
					}),
				},
			});
		}
	}
}

/**
 * Add a log entry to the workflow
 */
export async function addWorkflowLog(
	input: AddWorkflowLogInput,
): Promise<void> {
	const { planId, level, message, stepId, metadata } = input;

	await db.taskWorkflowLog.create({
		data: {
			planId,
			level,
			message,
			stepId,
			metadata: metadata as Prisma.InputJsonValue | undefined,
		},
	});
}
