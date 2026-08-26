/**
 * Weave Database Activities
 *
 * Activities for database operations in weave workflows.
 * These must be activities because database calls are non-deterministic.
 */

import { db, type Prisma } from "@repo/database";

export interface CreateWeavePlanInput {
	name: string;
	description: string;
	status: string;
	checkboxes: unknown[];
	projectId: string;
	userId: string;
	organizationId: string | null;
	userStoryId?: string;
	storyTaskId?: string;
}

export async function createWeavePlanActivity(
	input: CreateWeavePlanInput,
): Promise<{ planId: string }> {
	const plan = await db.weavePlan.create({
		data: {
			name: input.name,
			description: input.description,
			status: input.status as any,
			checkboxes: input.checkboxes as Prisma.InputJsonValue,
			projectId: input.projectId,
			userId: input.userId,
			organizationId: input.organizationId,
			userStoryId: input.userStoryId,
			storyTaskId: input.storyTaskId,
		},
	});

	return { planId: plan.id };
}

export interface GetWeavePlanInput {
	planId: string;
	userId: string;
	organizationId?: string | null;
}

export async function getWeavePlanActivity(input: GetWeavePlanInput): Promise<{
	id: string;
	name: string;
	description: string | null;
	status: string;
	checkboxes: unknown[];
	projectId: string;
	userId: string;
	organizationId: string | null;
} | null> {
	// XOR tenant isolation
	const plan = await db.weavePlan.findFirst({
		where: {
			id: input.planId,
			userId: input.userId,
			...(input.organizationId
				? { organizationId: input.organizationId }
				: { organizationId: null }),
		},
	});

	if (!plan) {
		return null;
	}

	return {
		id: plan.id,
		name: plan.name,
		description: plan.description,
		status: plan.status,
		checkboxes: plan.checkboxes as unknown[],
		projectId: plan.projectId,
		userId: plan.userId,
		organizationId: plan.organizationId,
	};
}

export interface UpdateWeavePlanStatusInput {
	planId: string;
	status: string;
	userId: string;
	organizationId?: string | null;
}

export async function updateWeavePlanStatusActivity(
	input: UpdateWeavePlanStatusInput,
): Promise<void> {
	// Validate ownership before update (XOR tenant isolation)
	const plan = await db.weavePlan.findFirst({
		where: {
			id: input.planId,
			userId: input.userId,
			...(input.organizationId
				? { organizationId: input.organizationId }
				: { organizationId: null }),
		},
		select: { id: true },
	});

	if (!plan) {
		throw new Error(`Plan ${input.planId} not found or access denied`);
	}

	await db.weavePlan.update({
		where: { id: input.planId },
		data: { status: input.status as any },
	});
}

export interface CreateWeaveExecutionInput {
	planId: string;
	projectId: string;
	workflowId: string;
	runId: string;
	userId: string;
	organizationId: string | null;
}

export async function createWeaveExecutionActivity(
	input: CreateWeaveExecutionInput,
): Promise<{ executionId: string }> {
	const execution = await db.weaveExecution.create({
		data: {
			planId: input.planId,
			projectId: input.projectId,
			workflowId: input.workflowId,
			runId: input.runId,
			status: "PENDING",
			currentStep: 0,
			userId: input.userId,
			organizationId: input.organizationId,
		},
	});

	return { executionId: execution.id };
}

export interface UpdateWeaveExecutionInput {
	executionId: string;
	userId: string;
	organizationId?: string | null;
	status?: string;
	currentStep?: number;
	sandboxSessionId?: string;
	checkboxes?: unknown[];
	artifacts?: unknown;
	error?: string;
	startedAt?: Date;
	completedAt?: Date;
}

export async function updateWeaveExecutionActivity(
	input: UpdateWeaveExecutionInput,
): Promise<void> {
	// Validate ownership before update (XOR tenant isolation)
	const execution = await db.weaveExecution.findFirst({
		where: {
			id: input.executionId,
			userId: input.userId,
			...(input.organizationId
				? { organizationId: input.organizationId }
				: { organizationId: null }),
		},
		select: { id: true, status: true },
	});

	if (!execution) {
		throw new Error(
			`Execution ${input.executionId} not found or access denied`,
		);
	}

	const data: Prisma.WeaveExecutionUpdateInput = {};

	if (input.status !== undefined) {
		// Never let the completion phase mark a run COMPLETED once it has
		// already reached a non-success terminal state (CANCELLED by the
		// cancel procedure, FAILED, or TERMINATED_STALE). Otherwise a
		// cancelled run that the execution phase reported as success gets
		// overwritten to COMPLETED, hiding the cancellation. Other field
		// updates still apply. (FAILED -> RUNNING via retry-from-step and
		// every non-terminal transition are unaffected.)
		const isCompletedOverwriteOfTerminal =
			input.status === "COMPLETED" &&
			(execution.status === "CANCELLED" ||
				execution.status === "FAILED" ||
				execution.status === "TERMINATED_STALE");
		if (!isCompletedOverwriteOfTerminal) {
			data.status = input.status as any;
		}
	}
	if (input.currentStep !== undefined) {
		data.currentStep = input.currentStep;
	}
	if (input.sandboxSessionId !== undefined) {
		data.sandboxSessionId = input.sandboxSessionId;
	}
	if (input.checkboxes !== undefined) {
		data.checkboxes = input.checkboxes as Prisma.InputJsonValue;
	}
	if (input.artifacts !== undefined) {
		data.artifacts = input.artifacts as Prisma.InputJsonValue;
	}
	if (input.error !== undefined) {
		data.error = input.error;
	}
	if (input.startedAt !== undefined) {
		data.startedAt = input.startedAt;
	}
	if (input.completedAt !== undefined) {
		data.completedAt = input.completedAt;
	}

	await db.weaveExecution.update({
		where: { id: input.executionId },
		data,
	});
}

export interface GetWeaveExecutionInput {
	executionId: string;
	userId: string;
	organizationId?: string | null;
}

export async function getWeaveExecutionActivity(
	input: GetWeaveExecutionInput,
): Promise<{
	id: string;
	planId: string;
	projectId: string;
	workflowId: string;
	runId: string;
	status: string;
	currentStep: number;
	checkboxes: unknown[] | null;
	sandboxSessionId: string | null;
} | null> {
	// XOR tenant isolation
	const execution = await db.weaveExecution.findFirst({
		where: {
			id: input.executionId,
			userId: input.userId,
			...(input.organizationId
				? { organizationId: input.organizationId }
				: { organizationId: null }),
		},
	});

	if (!execution) {
		return null;
	}

	return {
		id: execution.id,
		planId: execution.planId,
		projectId: execution.projectId,
		workflowId: execution.workflowId,
		runId: execution.runId,
		status: execution.status,
		currentStep: execution.currentStep,
		checkboxes: execution.checkboxes as unknown[] | null,
		sandboxSessionId: execution.sandboxSessionId,
	};
}
