/**
 * Database queries for WorkflowExecution and WorkflowExecutionLog models
 */

import {
	db,
	type Prisma,
	type WorkflowExecutionStatus,
	type WorkflowNodeStatus,
	type WorkflowTriggerType,
} from "../../client";

/**
 * Create a new workflow execution
 */
export async function createWorkflowExecution(data: {
	workflowId: string;
	version: number;
	triggerType: WorkflowTriggerType;
	triggerInput?: Prisma.InputJsonValue;
	userId: string;
	organizationId?: string;
	temporalRunId?: string;
}) {
	return await db.workflowExecution.create({
		data: {
			workflowId: data.workflowId,
			version: data.version,
			triggerType: data.triggerType,
			triggerInput: data.triggerInput,
			userId: data.userId,
			organizationId: data.organizationId,
			temporalRunId: data.temporalRunId,
			status: "PENDING",
		},
	});
}

/**
 * Get workflow execution by ID
 * Enforces strict isolation between personal and organizational executions
 */
export async function getWorkflowExecutionById(
	executionId: string,
	userId: string,
	organizationId?: string,
) {
	// Strict isolation: if no organizationId, only allow fetching personal executions
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.workflowExecution.findFirst({
		where: {
			id: executionId,
			userId,
			...orgFilter,
		},
		include: {
			workflow: {
				select: {
					id: true,
					name: true,
				},
			},
			logs: {
				orderBy: { startedAt: "asc" },
			},
		},
	});
}

/**
 * List workflow executions with pagination
 * Enforces strict isolation between personal and organizational executions
 */
export async function listWorkflowExecutions(options: {
	workflowId?: string;
	userId: string;
	organizationId?: string;
	status?: WorkflowExecutionStatus;
	limit?: number;
	offset?: number;
}) {
	const {
		workflowId,
		userId,
		organizationId,
		status,
		limit = 20,
		offset = 0,
	} = options;

	// Strict isolation: if no organizationId, only show personal executions
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const where: Prisma.WorkflowExecutionWhereInput = {
		userId,
		...orgFilter,
		...(workflowId ? { workflowId } : {}),
		...(status ? { status } : {}),
	};

	const [executions, total] = await Promise.all([
		db.workflowExecution.findMany({
			where,
			include: {
				workflow: {
					select: {
						id: true,
						name: true,
					},
				},
				_count: {
					select: {
						logs: true,
					},
				},
			},
			orderBy: { startedAt: "desc" },
			take: limit,
			skip: offset,
		}),
		db.workflowExecution.count({ where }),
	]);

	return {
		executions,
		total,
		hasMore: offset + limit < total,
		nextOffset: offset + limit < total ? offset + limit : undefined,
	};
}

/**
 * Update workflow execution status
 */
export async function updateWorkflowExecution(
	executionId: string,
	data: {
		status?: WorkflowExecutionStatus;
		output?: Prisma.InputJsonValue;
		error?: string;
		startedAt?: Date;
		completedAt?: Date;
		duration?: number;
	},
) {
	return await db.workflowExecution.update({
		where: { id: executionId },
		data,
	});
}

/**
 * Create execution log entry
 *
 * TENANT ISOLATION: userId and organizationId are required for proper tenant filtering.
 */
export async function createExecutionLog(data: {
	executionId: string;
	nodeId: string;
	nodeName?: string;
	nodeType: string;
	input?: Prisma.InputJsonValue;
	// Tenant isolation fields
	userId: string;
	organizationId?: string;
}) {
	return await db.workflowExecutionLog.create({
		data: {
			executionId: data.executionId,
			nodeId: data.nodeId,
			nodeName: data.nodeName,
			nodeType: data.nodeType,
			input: data.input,
			status: "PENDING",
			userId: data.userId,
			organizationId: data.organizationId,
		},
	});
}

/**
 * Update execution log entry
 */
export async function updateExecutionLog(
	logId: string,
	data: {
		status?: WorkflowNodeStatus;
		output?: Prisma.InputJsonValue;
		error?: string;
		completedAt?: Date;
		duration?: number;
	},
) {
	return await db.workflowExecutionLog.update({
		where: { id: logId },
		data,
	});
}

/**
 * Get execution logs for an execution
 */
export async function getExecutionLogs(executionId: string) {
	return await db.workflowExecutionLog.findMany({
		where: { executionId },
		orderBy: { startedAt: "asc" },
	});
}

/**
 * Get recent executions for a workflow
 * Enforces strict isolation between personal and organizational executions
 */
export async function getRecentExecutions(
	workflowId: string,
	userId: string,
	organizationId?: string,
	limit = 10,
) {
	// Strict isolation: if no organizationId, only show personal executions
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	return await db.workflowExecution.findMany({
		where: {
			workflowId,
			userId,
			...orgFilter,
		},
		include: {
			_count: {
				select: {
					logs: true,
				},
			},
		},
		orderBy: { startedAt: "desc" },
		take: limit,
	});
}

/**
 * Get execution statistics for a workflow
 * Enforces strict isolation between personal and organizational executions
 */
export async function getExecutionStats(
	workflowId: string,
	userId: string,
	organizationId?: string,
) {
	// Strict isolation: if no organizationId, only count personal executions
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const where: Prisma.WorkflowExecutionWhereInput = {
		workflowId,
		userId,
		...orgFilter,
	};

	const [total, completed, failed, running] = await Promise.all([
		db.workflowExecution.count({ where }),
		db.workflowExecution.count({
			where: { ...where, status: "COMPLETED" },
		}),
		db.workflowExecution.count({ where: { ...where, status: "FAILED" } }),
		db.workflowExecution.count({ where: { ...where, status: "RUNNING" } }),
	]);

	// Calculate average duration of completed executions
	const avgDuration = await db.workflowExecution.aggregate({
		where: { ...where, status: "COMPLETED", duration: { not: null } },
		_avg: { duration: true },
	});

	return {
		total,
		completed,
		failed,
		running,
		successRate: total > 0 ? (completed / total) * 100 : 0,
		avgDuration: avgDuration._avg.duration || 0,
	};
}
