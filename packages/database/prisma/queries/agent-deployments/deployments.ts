/**
 * Database queries for AgentDeployment model
 * Supports both personal and organizational accounts with strict tenant isolation
 */

import {
	type AgentDeploymentHealthStatus,
	type AgentDeploymentStatus,
	db,
	type Prisma,
} from "../../client";

// =============================================================================
// CREATE
// =============================================================================

export interface CreateAgentDeploymentInput {
	instanceId: string;
	userId: string;
	organizationId?: string;
	name: string;
	slug: string;
	maxConcurrentExecutions?: number;
	rateLimitPerMinute?: number;
	rateLimitPerHour?: number;
	dailyExecutionLimit?: number;
	monthlyExecutionLimit?: number;
}

export async function createAgentDeployment(input: CreateAgentDeploymentInput) {
	const {
		instanceId,
		userId,
		organizationId,
		name,
		slug,
		maxConcurrentExecutions = 5,
		rateLimitPerMinute = 60,
		rateLimitPerHour = 500,
		dailyExecutionLimit,
		monthlyExecutionLimit,
	} = input;

	return await db.agentDeployment.create({
		data: {
			instanceId,
			userId,
			organizationId,
			name,
			slug,
			maxConcurrentExecutions,
			rateLimitPerMinute,
			rateLimitPerHour,
			dailyExecutionLimit,
			monthlyExecutionLimit,
			status: "PENDING",
			healthStatus: "UNKNOWN",
		},
		include: {
			instance: {
				include: {
					template: true,
				},
			},
		},
	});
}

// =============================================================================
// READ
// =============================================================================

export interface GetAgentDeploymentOptions {
	userId: string;
	organizationId?: string;
}

/**
 * Get deployment by ID with strict tenant isolation
 */
export async function getAgentDeploymentById(
	id: string,
	options: GetAgentDeploymentOptions,
) {
	const { userId, organizationId } = options;

	// Strict isolation: org context XOR personal
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.agentDeployment.findFirst({
		where: {
			id,
			userId,
			...orgFilter,
		},
		include: {
			instance: {
				include: {
					template: true,
					integrationConfigurations: {
						where: { isEnabled: true },
						select: {
							integrationId: true,
							integrationType: true,
							allowedResources: true,
						},
					},
					mcpServerConfigurations: {
						where: { isEnabled: true },
						select: {
							mcpConfigId: true,
						},
					},
				},
			},
			triggers: true,
			_count: {
				select: {
					executions: true,
				},
			},
		},
	});
}

/**
 * Get deployment by instance ID
 */
export async function getAgentDeploymentByInstanceId(
	instanceId: string,
	options: GetAgentDeploymentOptions,
) {
	const { userId, organizationId } = options;

	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.agentDeployment.findFirst({
		where: {
			instanceId,
			userId,
			...orgFilter,
		},
		include: {
			instance: {
				include: {
					template: true,
					integrationConfigurations: {
						where: { isEnabled: true },
						select: {
							integrationId: true,
							integrationType: true,
						},
					},
				},
			},
		},
	});
}

/**
 * Get deployment by slug (URL-friendly identifier)
 */
export async function getAgentDeploymentBySlug(
	slug: string,
	options: GetAgentDeploymentOptions,
) {
	const { userId, organizationId } = options;

	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.agentDeployment.findFirst({
		where: {
			slug,
			userId,
			...orgFilter,
		},
		include: {
			instance: {
				include: {
					template: true,
				},
			},
			triggers: true,
		},
	});
}

export interface ListAgentDeploymentsOptions {
	userId: string;
	organizationId?: string;
	status?: AgentDeploymentStatus | AgentDeploymentStatus[];
	healthStatus?: AgentDeploymentHealthStatus;
	limit?: number;
	offset?: number;
}

/**
 * List deployments with tenant isolation and filtering
 */
export async function listAgentDeployments(
	options: ListAgentDeploymentsOptions,
) {
	const {
		userId,
		organizationId,
		status,
		healthStatus,
		limit = 20,
		offset = 0,
	} = options;

	// Strict isolation
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const where: Prisma.AgentDeploymentWhereInput = {
		userId,
		...orgFilter,
		...(status
			? Array.isArray(status)
				? { status: { in: status } }
				: { status }
			: {}),
		...(healthStatus ? { healthStatus } : {}),
	};

	const [deployments, total] = await Promise.all([
		db.agentDeployment.findMany({
			where,
			include: {
				instance: {
					include: {
						template: {
							select: {
								id: true,
								name: true,
								displayName: true,
								category: true,
								heroEmojis: true,
							},
						},
					},
				},
				_count: {
					select: {
						executions: true,
						triggers: true,
					},
				},
			},
			orderBy: { updatedAt: "desc" },
			take: limit,
			skip: offset,
		}),
		db.agentDeployment.count({ where }),
	]);

	return { deployments, total };
}

/**
 * Get active deployments count for quota checking
 */
export async function getActiveDeploymentsCount(
	userId: string,
	organizationId?: string,
): Promise<number> {
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.agentDeployment.count({
		where: {
			userId,
			...orgFilter,
			status: {
				in: ["PENDING", "DEPLOYING", "ACTIVE", "PAUSED", "DEGRADED"],
			},
		},
	});
}

// =============================================================================
// UPDATE
// =============================================================================

export interface UpdateAgentDeploymentInput {
	id: string;
	userId: string;
	organizationId?: string;
	name?: string;
	status?: AgentDeploymentStatus;
	healthStatus?: AgentDeploymentHealthStatus;
	supervisorWorkflowId?: string;
	supervisorRunId?: string;
	taskQueue?: string;
	deployedAt?: Date;
	pausedAt?: Date;
	terminatedAt?: Date;
	lastActiveAt?: Date;
	lastHealthCheck?: Date;
	consecutiveFailures?: number;
	currentExecutions?: number;
	maxConcurrentExecutions?: number;
	rateLimitPerMinute?: number;
	rateLimitPerHour?: number;
	dailyExecutionCount?: number;
	monthlyExecutionCount?: number;
	quotaResetAt?: Date;
}

export async function updateAgentDeployment(input: UpdateAgentDeploymentInput) {
	const { id, userId, organizationId, ...data } = input;

	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.agentDeployment.update({
		where: {
			id,
			userId,
			...orgFilter,
		},
		data: {
			...data,
			version: { increment: 1 },
		},
		include: {
			instance: true,
		},
	});
}

/**
 * Update deployment status
 */
export async function updateDeploymentStatus(
	id: string,
	status: AgentDeploymentStatus,
	additionalData?: Partial<{
		deployedAt: Date;
		pausedAt: Date;
		terminatedAt: Date;
		lastActiveAt: Date;
	}>,
) {
	return await db.agentDeployment.update({
		where: { id },
		data: {
			status,
			...additionalData,
		},
	});
}

/**
 * Update deployment health
 */
export async function updateDeploymentHealth(
	id: string,
	healthStatus: AgentDeploymentHealthStatus,
	consecutiveFailures?: number,
) {
	return await db.agentDeployment.update({
		where: { id },
		data: {
			healthStatus,
			lastHealthCheck: new Date(),
			...(consecutiveFailures !== undefined
				? { consecutiveFailures }
				: {}),
		},
	});
}

/**
 * Increment/decrement current executions count
 */
export async function updateCurrentExecutions(id: string, increment: number) {
	return await db.agentDeployment.update({
		where: { id },
		data: {
			currentExecutions: { increment },
			lastActiveAt: new Date(),
		},
	});
}

/**
 * Increment daily/monthly execution counts
 */
export async function incrementExecutionCounts(id: string) {
	return await db.agentDeployment.update({
		where: { id },
		data: {
			dailyExecutionCount: { increment: 1 },
			monthlyExecutionCount: { increment: 1 },
		},
	});
}

/**
 * Reset daily execution count
 */
export async function resetDailyExecutionCount(id: string) {
	return await db.agentDeployment.update({
		where: { id },
		data: {
			dailyExecutionCount: 0,
			quotaResetAt: new Date(),
		},
	});
}

// =============================================================================
// DELETE
// =============================================================================

export async function deleteAgentDeployment(
	id: string,
	userId: string,
	organizationId?: string,
) {
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.agentDeployment.delete({
		where: {
			id,
			userId,
			...orgFilter,
		},
	});
}

// =============================================================================
// SUPERVISOR WORKFLOW MANAGEMENT
// =============================================================================

/**
 * Set supervisor workflow info after starting
 */
export async function setDeploymentSupervisor(
	id: string,
	supervisorWorkflowId: string,
	supervisorRunId: string,
	taskQueue: string,
) {
	return await db.agentDeployment.update({
		where: { id },
		data: {
			supervisorWorkflowId,
			supervisorRunId,
			taskQueue,
			status: "DEPLOYING",
		},
	});
}

/**
 * Get deployment by supervisor workflow ID (for Temporal activities)
 */
export async function getDeploymentBySupervisorWorkflowId(
	supervisorWorkflowId: string,
) {
	return await db.agentDeployment.findFirst({
		where: { supervisorWorkflowId },
		include: {
			instance: {
				include: {
					template: true,
				},
			},
		},
	});
}

// =============================================================================
// ACTIVE DEPLOYMENTS FOR SCHEDULING
// =============================================================================

/**
 * Get all active deployments with scheduled triggers
 */
export async function getDeploymentsWithScheduledTriggers() {
	return await db.agentDeployment.findMany({
		where: {
			status: "ACTIVE",
			triggers: {
				some: {
					type: "SCHEDULE",
					isActive: true,
				},
			},
		},
		include: {
			triggers: {
				where: {
					type: "SCHEDULE",
					isActive: true,
				},
			},
			instance: true,
		},
	});
}
