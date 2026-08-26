/**
 * Database queries for AgentDeploymentExecution model
 */

import { type DeploymentExecutionStatus, db, type Prisma } from "../../client";

// =============================================================================
// CREATE
// =============================================================================

export interface CreateExecutionInput {
	deploymentId: string;
	executionId: string;
	userId: string;
	organizationId?: string;
	triggerType: string;
	triggerId?: string;
	triggerData?: Prisma.InputJsonValue;
	input?: Prisma.InputJsonValue;
	priority?: number;
	metadata?: Prisma.InputJsonValue;
}

export async function createAgentDeploymentExecution(
	input: CreateExecutionInput,
) {
	return await db.agentDeploymentExecution.create({
		data: {
			deploymentId: input.deploymentId,
			executionId: input.executionId,
			userId: input.userId,
			organizationId: input.organizationId,
			triggerType: input.triggerType,
			triggerId: input.triggerId,
			triggerData: input.triggerData,
			input: input.input,
			priority: input.priority ?? 5,
			metadata: input.metadata,
			status: "PENDING",
			queuedAt: new Date(),
		},
	});
}

// =============================================================================
// READ
// =============================================================================

/**
 * Get execution by ID with tenant isolation
 */
export async function getAgentDeploymentExecutionById(
	id: string,
	userId: string,
	organizationId?: string,
) {
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.agentDeploymentExecution.findFirst({
		where: {
			id,
			userId,
			...orgFilter,
		},
		include: {
			deployment: {
				include: {
					instance: {
						include: {
							template: true,
						},
					},
				},
			},
			steps: {
				orderBy: { stepNumber: "asc" },
			},
		},
	});
}

/**
 * Get execution by execution ID (Temporal workflow ID)
 */
export async function getExecutionByExecutionId(executionId: string) {
	return await db.agentDeploymentExecution.findUnique({
		where: { executionId },
		include: {
			deployment: true,
			steps: {
				orderBy: { stepNumber: "asc" },
			},
		},
	});
}

export interface ListExecutionsOptions {
	deploymentId?: string;
	userId: string;
	organizationId?: string;
	status?: DeploymentExecutionStatus | DeploymentExecutionStatus[];
	triggerType?: string;
	limit?: number;
	offset?: number;
}

/**
 * List executions with filtering
 */
export async function listAgentDeploymentExecutions(
	options: ListExecutionsOptions,
) {
	const {
		deploymentId,
		userId,
		organizationId,
		status,
		triggerType,
		limit = 20,
		offset = 0,
	} = options;

	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const where: Prisma.AgentDeploymentExecutionWhereInput = {
		userId,
		...orgFilter,
		...(deploymentId ? { deploymentId } : {}),
		...(status
			? Array.isArray(status)
				? { status: { in: status } }
				: { status }
			: {}),
		...(triggerType ? { triggerType } : {}),
	};

	const [executions, total] = await Promise.all([
		db.agentDeploymentExecution.findMany({
			where,
			include: {
				deployment: {
					select: {
						id: true,
						name: true,
						slug: true,
					},
				},
				_count: {
					select: {
						steps: true,
					},
				},
			},
			orderBy: { queuedAt: "desc" },
			take: limit,
			skip: offset,
		}),
		db.agentDeploymentExecution.count({ where }),
	]);

	return { executions, total };
}

/**
 * Get pending executions for a deployment (for queue processing)
 */
export async function getPendingExecutions(deploymentId: string, limit = 10) {
	return await db.agentDeploymentExecution.findMany({
		where: {
			deploymentId,
			status: "PENDING",
		},
		orderBy: [
			{ priority: "asc" }, // Lower number = higher priority
			{ queuedAt: "asc" }, // FIFO within same priority
		],
		take: limit,
	});
}

/**
 * Get running executions count for a deployment
 */
export async function getRunningExecutionsCount(
	deploymentId: string,
): Promise<number> {
	return await db.agentDeploymentExecution.count({
		where: {
			deploymentId,
			status: "RUNNING",
		},
	});
}

// =============================================================================
// UPDATE
// =============================================================================

/**
 * Update execution status
 */
export async function updateExecutionStatus(
	executionId: string,
	status: DeploymentExecutionStatus,
	additionalData?: Partial<{
		startedAt: Date;
		completedAt: Date;
		duration: number;
		output: Prisma.InputJsonValue;
		error: string;
		workflowId: string;
		runId: string;
		inputTokens: number;
		outputTokens: number;
		totalCost: number;
	}>,
) {
	return await db.agentDeploymentExecution.update({
		where: { executionId },
		data: {
			status,
			...additionalData,
		},
	});
}

/**
 * Start execution (mark as running)
 */
export async function startExecution(
	executionId: string,
	workflowId: string,
	runId: string,
) {
	return await db.agentDeploymentExecution.update({
		where: { executionId },
		data: {
			status: "RUNNING",
			startedAt: new Date(),
			workflowId,
			runId,
		},
	});
}

/**
 * Complete execution successfully
 */
export async function completeExecution(
	executionId: string,
	output: Prisma.InputJsonValue,
	tokenUsage?: {
		inputTokens: number;
		outputTokens: number;
		totalCost?: number;
	},
) {
	const startedAt = await db.agentDeploymentExecution.findUnique({
		where: { executionId },
		select: { startedAt: true },
	});

	const completedAt = new Date();
	const duration = startedAt?.startedAt
		? completedAt.getTime() - startedAt.startedAt.getTime()
		: null;

	return await db.agentDeploymentExecution.update({
		where: { executionId },
		data: {
			status: "COMPLETED",
			completedAt,
			duration,
			output,
			...(tokenUsage
				? {
						inputTokens: tokenUsage.inputTokens,
						outputTokens: tokenUsage.outputTokens,
						totalCost: tokenUsage.totalCost,
					}
				: {}),
		},
	});
}

/**
 * Fail execution
 */
export async function failExecution(executionId: string, error: string) {
	const startedAt = await db.agentDeploymentExecution.findUnique({
		where: { executionId },
		select: { startedAt: true },
	});

	const completedAt = new Date();
	const duration = startedAt?.startedAt
		? completedAt.getTime() - startedAt.startedAt.getTime()
		: null;

	return await db.agentDeploymentExecution.update({
		where: { executionId },
		data: {
			status: "FAILED",
			completedAt,
			duration,
			error,
		},
	});
}

/**
 * Cancel execution
 */
export async function cancelExecution(executionId: string, reason?: string) {
	return await db.agentDeploymentExecution.update({
		where: { executionId },
		data: {
			status: "CANCELLED",
			completedAt: new Date(),
			error: reason || "Cancelled by user",
		},
	});
}

/**
 * Time out execution
 */
export async function timeoutExecution(executionId: string) {
	return await db.agentDeploymentExecution.update({
		where: { executionId },
		data: {
			status: "TIMED_OUT",
			completedAt: new Date(),
			error: "Execution timed out",
		},
	});
}

// =============================================================================
// EXECUTION STEPS
// =============================================================================

export interface CreateExecutionStepInput {
	executionId: string;
	stepNumber: number;
	stepType: string;
	name?: string;
	description?: string;
	input?: Prisma.InputJsonValue;
	// Tenant isolation fields
	userId: string;
	organizationId?: string;
}

/**
 * Create an execution step
 *
 * TENANT ISOLATION: userId and organizationId are required for proper tenant filtering.
 */
export async function createExecutionStep(input: CreateExecutionStepInput) {
	// Get the AgentDeploymentExecution id from executionId
	const execution = await db.agentDeploymentExecution.findUnique({
		where: { executionId: input.executionId },
		select: { id: true },
	});

	if (!execution) {
		throw new Error(`Execution not found: ${input.executionId}`);
	}

	return await db.agentExecutionStep.create({
		data: {
			executionId: execution.id,
			stepNumber: input.stepNumber,
			stepType: input.stepType,
			name: input.name,
			description: input.description,
			input: input.input,
			status: "pending",
			userId: input.userId,
			organizationId: input.organizationId,
		},
	});
}

export async function updateExecutionStep(
	stepId: string,
	data: {
		status?: string;
		startedAt?: Date;
		completedAt?: Date;
		duration?: number;
		output?: Prisma.InputJsonValue;
		error?: string;
	},
) {
	return await db.agentExecutionStep.update({
		where: { id: stepId },
		data,
	});
}

// =============================================================================
// METRICS & ANALYTICS
// =============================================================================

/**
 * Get execution statistics for a deployment
 */
export async function getDeploymentExecutionStats(
	deploymentId: string,
	startDate?: Date,
	endDate?: Date,
) {
	const where: Prisma.AgentDeploymentExecutionWhereInput = {
		deploymentId,
		...(startDate || endDate
			? {
					queuedAt: {
						...(startDate ? { gte: startDate } : {}),
						...(endDate ? { lte: endDate } : {}),
					},
				}
			: {}),
	};

	const [total, byStatus, avgDuration] = await Promise.all([
		db.agentDeploymentExecution.count({ where }),
		db.agentDeploymentExecution.groupBy({
			by: ["status"],
			where,
			_count: true,
		}),
		db.agentDeploymentExecution.aggregate({
			where: {
				...where,
				status: "COMPLETED",
				duration: { not: null },
			},
			_avg: { duration: true },
			_min: { duration: true },
			_max: { duration: true },
		}),
	]);

	return {
		total,
		byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
		avgDurationMs: avgDuration._avg.duration,
		minDurationMs: avgDuration._min.duration,
		maxDurationMs: avgDuration._max.duration,
	};
}
