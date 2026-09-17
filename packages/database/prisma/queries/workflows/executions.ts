/**
 * Database queries for WorkflowExecution and WorkflowExecutionLog models
 */

import {
	db,
	type Prisma,
	type WorkflowExecution,
	type WorkflowExecutionStatus,
	type WorkflowNodeStatus,
	type WorkflowTriggerType,
} from "../../client";
import { advisoryObjectKey } from "../lib/refresh-lock-key";

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

/** Statuses that mean "occupying a worker slot right now". */
const WORKFLOW_EXECUTION_IN_FLIGHT_STATUSES = [
	"PENDING",
	"RUNNING",
] as const satisfies readonly WorkflowExecutionStatus[];

/**
 * Advisory-lock class for per-tenant execution reservations. Distinct from
 * `REFRESH_ADVISORY_CLASS` so a workflow start never queues behind an OAuth
 * refresh (or vice versa) that happens to hash to the same object key.
 */
const WORKFLOW_EXECUTION_CAP_ADVISORY_CLASS = 0x57664361; // "WfCa"

/** The advisory-lock object key for one tenant's reservations. */
function workflowExecutionCapLockKey(tenant: {
	userId: string;
	organizationId?: string | null;
}): string {
	return tenant.organizationId
		? `wfcap:org:${tenant.organizationId}`
		: `wfcap:user:${tenant.userId}`;
}

export type ReserveWorkflowExecutionResult =
	| {
			reserved: true;
			execution: WorkflowExecution;
			/** In-flight count INCLUDING the row just reserved. */
			inFlight: number;
			limit: number;
	  }
	| { reserved: false; inFlight: number; limit: number };

/**
 * Create a PENDING execution row only if the tenant is below `limit`
 * in-flight executions — the count and the insert happen atomically.
 *
 * Every starter used to count and then insert in two statements, so N
 * concurrent requests at `limit - 1` all saw one free slot and all inserted:
 * the advertised per-tenant ceiling held only when nobody raced for it, and
 * the surfaces most able to race (webhooks, retry storms) were exactly the
 * ones it exists for.
 *
 * WHY A LOCK AND NOT A CONDITIONAL WRITE (the repo's default is optimistic
 * CAS — `updateMany` with a guard — and a lock needs justifying, as ADR-020
 * did for discovery question posting): the invariant here is over a COUNT of
 * rows, not the version of one row, and no single conditional write can say
 * "insert unless N rows already match". The two lock-free shapes both fail:
 *
 *   - insert, then count, then delete on overflow: under READ COMMITTED each
 *     transaction cannot see the other's uncommitted insert, so two racers
 *     both count `limit` and both stay — the original bug with extra steps;
 *   - insert and commit, then count, then delete on overflow: now both see
 *     `limit + 1` and both withdraw, so the last free slot admits nobody.
 *
 * A transaction-scoped advisory lock keyed on the tenant serializes only
 * reservations for that tenant. It locks no table row, so it blocks none of
 * the writes the run itself makes (status updates, logs) and nothing another
 * tenant does. Same primitive as `withRefreshLock`, same `$executeRaw`
 * requirement: `pg_advisory_xact_lock()` returns `void`, which `$queryRaw`
 * cannot deserialize.
 *
 * Organization-scoped when there is an organization, otherwise scoped to the
 * user with `organizationId: null` — the XOR tenancy the rest of the module
 * uses, so a personal workflow cannot consume an organization's headroom or
 * vice versa.
 */
export async function reserveWorkflowExecution(args: {
	userId: string;
	organizationId?: string | null;
	limit: number;
	data: {
		workflowId: string;
		version: number;
		triggerType: WorkflowTriggerType;
		triggerInput?: Prisma.InputJsonValue;
	};
}): Promise<ReserveWorkflowExecutionResult> {
	return db.$transaction(
		(tx) => reserveWorkflowExecutionWithin(tx, args),
		// Count + insert is milliseconds; the budget is for waiting on a
		// tenant's other reservations, never for the run itself.
		{ maxWait: 5_000, timeout: 10_000 },
	);
}

/**
 * The reservation itself, for a caller that already holds a transaction —
 * for instance one that has just looked a client idempotency key up under
 * its own lock and found nothing, and must reserve capacity for the new row
 * before that lock is released. Lock ORDER matters for such a caller: any
 * key-scoped lock is taken first and the tenant lock here second, on every
 * path, so two reservations can never wait on each other.
 */
export async function reserveWorkflowExecutionWithin(
	tx: Prisma.TransactionClient,
	args: {
		userId: string;
		organizationId?: string | null;
		limit: number;
		data: {
			workflowId: string;
			version: number;
			triggerType: WorkflowTriggerType;
			triggerInput?: Prisma.InputJsonValue;
		};
	},
): Promise<ReserveWorkflowExecutionResult> {
	const tenantFilter = args.organizationId
		? { organizationId: args.organizationId }
		: { userId: args.userId, organizationId: null };
	const lockKey = advisoryObjectKey(workflowExecutionCapLockKey(args));

	await tx.$executeRaw`SELECT pg_advisory_xact_lock(${WORKFLOW_EXECUTION_CAP_ADVISORY_CLASS}::int, ${lockKey}::int)`;

	const inFlight = await tx.workflowExecution.count({
		where: {
			...tenantFilter,
			status: { in: [...WORKFLOW_EXECUTION_IN_FLIGHT_STATUSES] },
		},
	});
	if (inFlight >= args.limit) {
		return { reserved: false, inFlight, limit: args.limit };
	}

	const execution = await tx.workflowExecution.create({
		data: {
			workflowId: args.data.workflowId,
			version: args.data.version,
			triggerType: args.data.triggerType,
			triggerInput: args.data.triggerInput,
			userId: args.userId,
			organizationId: args.organizationId ?? undefined,
			status: "PENDING",
		},
	});
	return {
		reserved: true,
		execution,
		inFlight: inFlight + 1,
		limit: args.limit,
	};
}

/**
 * Record that the engine accepted the run behind an execution row: store the
 * Temporal workflow id and move the row PENDING → RUNNING — and ONLY from
 * PENDING.
 *
 * The starter writes this after `client.workflow.start` returns, but the
 * workflow writes its own status as it progresses and a short run can reach
 * COMPLETED, FAILED or CANCELLED before the starter's write lands. An
 * unconditional update would move such a row back to RUNNING, where nothing
 * ever moves it forward again. The conditional write leaves a row that has
 * already moved on alone; its run id is recorded separately so a finished row
 * still names the run it came from.
 *
 * Returns whether the row was moved to RUNNING.
 */
export async function markExecutionRunningIfPending(args: {
	executionId: string;
	temporalRunId: string;
	startedAt?: Date;
}): Promise<boolean> {
	const moved = await db.workflowExecution.updateMany({
		where: { id: args.executionId, status: "PENDING" },
		data: {
			temporalRunId: args.temporalRunId,
			status: "RUNNING",
			startedAt: args.startedAt ?? new Date(),
		},
	});
	if (moved.count > 0) {
		return true;
	}
	// Already past PENDING (the run finished first, or another writer got
	// there): keep its status, but record the run id if none is stored yet.
	await db.workflowExecution.updateMany({
		where: { id: args.executionId, temporalRunId: null },
		data: { temporalRunId: args.temporalRunId },
	});
	return false;
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
		/** The Temporal workflow id once the run has been handed to the engine. */
		temporalRunId?: string;
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
	/** Defaults to PENDING. Set for a node written once in its final state (e.g. SKIPPED). */
	status?: WorkflowNodeStatus;
	output?: Prisma.InputJsonValue;
	error?: string;
	completedAt?: Date;
	duration?: number;
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
			status: data.status ?? "PENDING",
			output: data.output,
			error: data.error,
			completedAt: data.completedAt,
			duration: data.duration,
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
