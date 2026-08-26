/**
 * Database queries for AgentTask model
 * Handles agent execution tracking with multi-tenancy
 */

import { db } from "../client";

/**
 * Create a new agent task
 */
export async function createAgentTask(data: {
	agentId: string;
	userId: string;
	organizationId?: string;
	status: string;
	stage: string;
	input: Record<string, any>;
	framework: string;
}) {
	return await db.agentTask.create({
		data: {
			agentId: data.agentId,
			userId: data.userId,
			organizationId: data.organizationId,
			status: data.status,
			stage: data.stage,
			input: data.input,
			framework: data.framework,
		},
	});
}

/**
 * Get agent task by ID
 */
export async function getAgentTaskById(id: string) {
	return await db.agentTask.findUnique({
		where: { id },
		include: {
			user: {
				select: {
					id: true,
					name: true,
					email: true,
				},
			},
			organization: {
				select: {
					id: true,
					name: true,
				},
			},
			approvals: {
				orderBy: { createdAt: "desc" },
			},
			artifacts: {
				orderBy: { createdAt: "desc" },
			},
		},
	});
}

/**
 * List agent tasks for a user's personal account (not organization)
 * Enforces strict isolation - only returns tasks where organizationId is null
 */
export async function getAgentTasksByUserId({
	userId,
	limit,
	offset,
	status,
	agentId,
}: {
	userId: string;
	limit: number;
	offset: number;
	status?: string;
	agentId?: string;
}) {
	return await db.agentTask.findMany({
		where: {
			userId,
			organizationId: null, // Strict isolation: only personal tasks
			...(status && { status }),
			...(agentId && { agentId }),
		},
		orderBy: { createdAt: "desc" },
		take: limit,
		skip: offset,
	});
}

/**
 * List agent tasks for an organization
 */
export async function getAgentTasksByOrganizationId({
	organizationId,
	limit,
	offset,
	status,
	agentId,
}: {
	organizationId: string;
	limit: number;
	offset: number;
	status?: string;
	agentId?: string;
}) {
	return await db.agentTask.findMany({
		where: {
			organizationId,
			...(status && { status }),
			...(agentId && { agentId }),
		},
		orderBy: { createdAt: "desc" },
		take: limit,
		skip: offset,
		include: {
			user: {
				select: {
					id: true,
					name: true,
					email: true,
				},
			},
		},
	});
}

/**
 * Update agent task status
 */
export async function updateAgentTaskStatus({
	id,
	status,
	state,
	result,
	error,
	completedAt,
}: {
	id: string;
	status: string;
	state?: Record<string, any>;
	result?: Record<string, any>;
	error?: string;
	completedAt?: Date;
}) {
	return await db.agentTask.update({
		where: { id },
		data: {
			status,
			...(state && { state }),
			...(result && { result }),
			...(error !== undefined && { error }),
			...(completedAt && { completedAt }),
		},
	});
}

/**
 * Update agent task with workflow info
 */
export async function updateAgentTaskWorkflow({
	id,
	workflowId,
	runId,
}: {
	id: string;
	workflowId: string;
	runId: string;
}) {
	return await db.agentTask.update({
		where: { id },
		data: {
			workflowId,
			runId,
		},
	});
}

/**
 * Count agent tasks by status with tenant isolation
 *
 * TENANT ISOLATION (XOR Pattern):
 * - ORGANIZATION CONTEXT (organizationId provided): Only org tasks
 * - PERSONAL CONTEXT (userId only, no organizationId): Only personal tasks
 *
 * Note: userId is always required for proper isolation.
 */
export async function countAgentTasksByStatus({
	userId,
	organizationId,
}: {
	userId: string;
	organizationId?: string;
}) {
	// XOR pattern: strict isolation between personal and org contexts
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const tasks = await db.agentTask.groupBy({
		by: ["status"],
		where: {
			userId,
			...orgFilter,
		},
		_count: true,
	});

	return tasks.reduce(
		(acc, item) => {
			acc[item.status] = item._count;
			return acc;
		},
		{} as Record<string, number>,
	);
}

/**
 * Delete agent task
 */
export async function deleteAgentTask(id: string) {
	return await db.agentTask.delete({
		where: { id },
	});
}
