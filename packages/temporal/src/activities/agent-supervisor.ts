/**
 * Agent Supervisor Activities
 *
 * Activities for managing agent deployments, executions, and health monitoring.
 * These activities are called by the agent supervisor workflow.
 */

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getAgentImplementationAvailability } from "@repo/agent-types/agent-implementation";
import {
	type AgentDeploymentHealthStatus,
	type AgentDeploymentStatus,
	cancelExecution,
	db,
	updateDeploymentHealth as dbUpdateDeploymentHealth,
	updateDeploymentStatus as dbUpdateDeploymentStatus,
	getAgentDeploymentById,
	getAgentTemplateInstanceForExecution,
	type Prisma,
} from "@repo/database";
import { getCorrelationIdFromContext } from "@repo/utils/correlation-id";
import { ApplicationFailure } from "@temporalio/common";
import { getTemporalClient } from "../client";

// =============================================================================
// DEPLOYMENT STATUS MANAGEMENT
// =============================================================================

export interface UpdateDeploymentStatusInput {
	deploymentId: string;
	status: AgentDeploymentStatus | string;
	deployedAt?: string;
	pausedAt?: string;
	terminatedAt?: string;
}

export async function updateDeploymentStatus(
	input: UpdateDeploymentStatusInput,
): Promise<void> {
	const { deploymentId, status, deployedAt, pausedAt, terminatedAt } = input;

	await dbUpdateDeploymentStatus(
		deploymentId,
		status as AgentDeploymentStatus,
		{
			...(deployedAt ? { deployedAt: new Date(deployedAt) } : {}),
			...(pausedAt ? { pausedAt: new Date(pausedAt) } : {}),
			...(terminatedAt ? { terminatedAt: new Date(terminatedAt) } : {}),
			lastActiveAt: new Date(),
		},
	);
}

// =============================================================================
// HEALTH MONITORING
// =============================================================================

export interface CheckDeploymentHealthInput {
	deploymentId: string;
}

export interface HealthCheckResult {
	status: "healthy" | "degraded" | "unhealthy";
	consecutiveFailures: number;
	details?: {
		lastExecutionTime?: string;
		pendingExecutions?: number;
		errorRate?: number;
	};
}

export async function checkDeploymentHealth(
	_input: CheckDeploymentHealthInput,
): Promise<HealthCheckResult> {
	// For now, just return healthy. In production, this would check:
	// - Recent execution success rate
	// - Response times
	// - Queue depth
	// - External service connectivity

	// This is a placeholder - actual health check logic would be more sophisticated
	return {
		status: "healthy",
		consecutiveFailures: 0,
		details: {},
	};
}

export interface UpdateDeploymentHealthInput {
	deploymentId: string;
	healthStatus: string;
	lastHealthCheck: string;
	consecutiveFailures?: number;
}

export async function updateDeploymentHealth(
	input: UpdateDeploymentHealthInput,
): Promise<void> {
	const { deploymentId, healthStatus, consecutiveFailures } = input;

	await dbUpdateDeploymentHealth(
		deploymentId,
		healthStatus as AgentDeploymentHealthStatus,
		consecutiveFailures,
	);
}

// =============================================================================
// EXECUTION MANAGEMENT
// =============================================================================

export interface StartAgentExecutionInput {
	workflowId: string;
	deploymentId: string;
	instanceId: string;
	executionId: string;
	userId: string;
	organizationId?: string;
	input: Record<string, unknown>;
	triggerType: string;
	triggerId?: string;
	timeoutMs: number;
}

class SupervisorStartRefusal extends Error {}
const jsonRecord = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
function orderedJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(orderedJson).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) =>
				left < right ? -1 : left > right ? 1 : 0,
			)
			.map(([key, item]) => `${JSON.stringify(key)}:${orderedJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export async function startAgentExecution(
	input: StartAgentExecutionInput,
): Promise<{ success: boolean; error?: string; childWorkflowId?: string }> {
	const {
		workflowId,
		deploymentId,
		instanceId,
		executionId,
		userId,
		organizationId,
		input: executionInput,
		triggerType,
		triggerId,
		timeoutMs,
	} = input;
	const childWorkflowId = `deployment-exec-${executionId}`;
	try {
		if (!organizationId || !userId || !executionId || !workflowId) {
			throw new SupervisorStartRefusal(
				"Execution requires a complete organization and actor identity.",
			);
		}
		const scope = { deploymentId, executionId, userId, organizationId };
		const read = () =>
			db.agentDeploymentExecution.findFirst({ where: scope });
		const matches = (row: Awaited<ReturnType<typeof read>>) =>
			!!row &&
			row.deploymentId === deploymentId &&
			row.executionId === executionId &&
			row.userId === userId &&
			row.organizationId === organizationId &&
			row.triggerType === triggerType &&
			(row.triggerId ?? null) === (triggerId ?? null) &&
			isDeepStrictEqual(row.input ?? {}, executionInput);
		let execution = await read();
		if (!matches(execution) || !execution) {
			throw new SupervisorStartRefusal(
				"Persisted execution identity, input or trigger does not match this request.",
			);
		}
		const deployment = await getAgentDeploymentById(deploymentId, {
			userId,
			organizationId,
		});
		if (
			!deployment ||
			deployment.id !== deploymentId ||
			deployment.instanceId !== instanceId ||
			deployment.userId !== userId ||
			deployment.organizationId !== organizationId
		) {
			throw new SupervisorStartRefusal(
				"Deployment does not match the persisted execution scope.",
			);
		}
		const scoped = await getAgentTemplateInstanceForExecution({
			instanceId,
			userId,
			organizationId,
		});
		if (
			!scoped ||
			scoped.instance.id !== instanceId ||
			scoped.instance.organizationId !== organizationId ||
			!getAgentImplementationAvailability(
				scoped.instance.customInstructions,
			).available
		) {
			throw new SupervisorStartRefusal(
				"The native agent instance is no longer available for this actor and project.",
			);
		}
		const instance = scoped.instance;
		const goalOriented = instance.executionMode === "goal_oriented";
		const workflowType = goalOriented
			? "goalOrientedAgentWorkflow"
			: "deploymentExecutionWorkflow";
		const args = {
			executionId,
			deploymentId,
			instanceId,
			userId,
			organizationId,
			input: executionInput,
			triggerType,
			...(triggerId ? { triggerId } : {}),
			timeoutMs: timeoutMs || 30 * 60 * 1000,
			supervisorWorkflowId: `agent-supervisor-${deploymentId}`,
			...(goalOriented
				? {
						goal: instance.goal || "Complete the requested task",
						successCriteria: instance.successCriteria,
						maxIterations: instance.maxIterations || 10,
					}
				: {}),
		};
		const dispatchHash = createHash("sha256")
			.update(
				orderedJson({
					workflowId,
					workflowType,
					args,
					projectId: scoped.projectId ?? null,
				}),
			)
			.digest("hex");
		const memo = {
			version: 1,
			executionRowId: execution.id,
			executionId,
			deploymentId,
			instanceId,
			userId,
			organizationId,
			workflowType,
			dispatchHash,
		};
		const dispatch = { ...memo, childWorkflowId };
		const validIntent = (row: typeof execution) =>
			!!row &&
			row.workflowId === childWorkflowId &&
			isDeepStrictEqual(
				jsonRecord(row.metadata).fabricSupervisorDispatch,
				dispatch,
			);
		let firstDispatch = false;
		if (
			!execution.workflowId &&
			!execution.runId &&
			execution.status === "PENDING"
		) {
			const claimed = await db.agentDeploymentExecution.updateMany({
				where: {
					id: execution.id,
					...scope,
					workflowId: null,
					runId: null,
					status: "PENDING",
				},
				data: {
					workflowId: childWorkflowId,
					metadata: {
						...jsonRecord(execution.metadata),
						fabricSupervisorDispatch: dispatch,
					} as Prisma.InputJsonValue,
				},
			});
			firstDispatch = claimed.count === 1;
			execution = await read();
		}
		if (!matches(execution) || !execution || !validIntent(execution)) {
			throw new SupervisorStartRefusal(
				"Execution is already bound to a different or unverified workflow intent.",
			);
		}
		if (
			execution.runId &&
			jsonRecord(execution.metadata).fabricSupervisorReceiptAccounted ===
				execution.runId
		) {
			return { success: true, childWorkflowId };
		}
		const client = await getTemporalClient();
		const verifiedDescription = async () => {
			const current = await read();
			const currentDeployment = await getAgentDeploymentById(
				deploymentId,
				{ userId, organizationId },
			);
			const currentScope = await getAgentTemplateInstanceForExecution({
				instanceId,
				userId,
				organizationId,
			});
			if (
				!matches(current) ||
				!current ||
				!validIntent(current) ||
				!currentDeployment ||
				currentDeployment.userId !== userId ||
				currentDeployment.organizationId !== organizationId ||
				currentDeployment.instanceId !== instanceId ||
				!currentScope ||
				currentScope.instance.id !== instanceId ||
				currentScope.instance.organizationId !== organizationId ||
				!getAgentImplementationAvailability(
					currentScope.instance.customInstructions,
				).available ||
				(currentScope.projectId ?? null) !== (scoped.projectId ?? null)
			) {
				throw new SupervisorStartRefusal(
					"Execution scope or project access changed before receipt reconciliation.",
				);
			}
			const description = await client.workflow
				.getHandle(childWorkflowId, execution?.runId ?? undefined)
				.describe();
			if (
				description.type !== workflowType ||
				!description.runId ||
				!isDeepStrictEqual(
					description.memo?.fabricSupervisorExecution,
					memo,
				) ||
				(execution?.runId && execution.runId !== description.runId)
			) {
				throw new SupervisorStartRefusal(
					"Existing workflow does not match this scoped execution intent.",
				);
			}
			return description.runId;
		};
		let runId: string;
		if (firstDispatch) {
			try {
				const correlationId = getCorrelationIdFromContext();
				const handle = await client.workflow.start(workflowType, {
					taskQueue: "agents",
					workflowId: childWorkflowId,
					workflowIdReusePolicy: "REJECT_DUPLICATE",
					workflowIdConflictPolicy: "FAIL",
					memo: {
						fabricSupervisorExecution: memo,
						...(correlationId ? { correlationId } : {}),
					},
					args: [args],
				});
				runId = handle.firstExecutionRunId;
				if (!runId) {
					throw new Error("Missing Temporal receipt");
				}
			} catch {
				// A lost start response cannot authorize another start. Reconcile only the
				// existing stable identity; later retries also describe rather than dispatch.
				runId = await verifiedDescription();
			}
		} else {
			runId = await verifiedDescription();
		}
		await db.$transaction(async (tx) => {
			for (let attempt = 0; attempt < 3; attempt++) {
				const current = await tx.agentDeploymentExecution.findFirst({
					where: scope,
				});
				if (
					!matches(current) ||
					!current ||
					!validIntent(current) ||
					(current.runId && current.runId !== runId)
				) {
					throw new SupervisorStartRefusal(
						"Execution receipt identity conflicts with the persisted request.",
					);
				}
				const metadata = jsonRecord(current.metadata);
				if (metadata.fabricSupervisorReceiptAccounted === runId) {
					return;
				}
				const pending = current.status === "PENDING";
				const attached = await tx.agentDeploymentExecution.updateMany({
					where: {
						id: current.id,
						...scope,
						workflowId: childWorkflowId,
						runId: current.runId,
						status: current.status,
						metadata: {
							equals: current.metadata as Prisma.InputJsonValue,
						},
					},
					data: {
						runId,
						metadata: {
							...metadata,
							fabricSupervisorReceiptAccounted: runId,
						} as Prisma.InputJsonValue,
						...(pending
							? { status: "RUNNING", startedAt: new Date() }
							: {}),
					},
				});
				if (attached.count !== 1) {
					continue;
				}
				const reserved =
					jsonRecord(metadata.fabricAdmission)
						.executionCountReserved === true;
				const stillRunning = [
					"PENDING",
					"RUNNING",
					"WAITING_INPUT",
				].includes(current.status);
				const counted = await tx.agentDeployment.updateMany({
					where: {
						id: deploymentId,
						instanceId,
						userId,
						organizationId,
					},
					data: {
						...(!reserved
							? {
									dailyExecutionCount: { increment: 1 },
									monthlyExecutionCount: { increment: 1 },
								}
							: {}),
						...(stillRunning
							? { currentExecutions: { increment: 1 } }
							: {}),
						lastActiveAt: new Date(),
					},
				});
				if (counted.count !== 1) {
					throw new SupervisorStartRefusal(
						"Deployment scope changed before receipt accounting.",
					);
				}
				if (!reserved) {
					const quota =
						await tx.organizationDeploymentQuota.updateMany({
							where: { organizationId },
							data: {
								dailyExecutionCount: { increment: 1 },
								monthlyExecutionCount: { increment: 1 },
							},
						});
					if (quota.count !== 1) {
						throw new Error(
							"Execution quota could not be accounted",
						);
					}
				}
				return;
			}
			throw new Error("Receipt changed concurrently");
		});
		return { success: true, childWorkflowId };
	} catch (error) {
		// A normal return would make the supervisor track a non-admitted run.
		// Retryable uncertainty re-enters receipt reconciliation, never dispatch.
		if (error instanceof SupervisorStartRefusal) {
			throw ApplicationFailure.nonRetryable(
				error.message,
				"SUPERVISOR_EXECUTION_REFUSED",
			);
		}
		throw ApplicationFailure.retryable(
			"Execution start could not be confirmed. Reconcile the existing execution before another attempt.",
			"SUPERVISOR_EXECUTION_UNRESOLVED",
		);
	}
}

export interface CancelPendingExecutionInput {
	executionId: string;
	reason: string;
}

export async function cancelPendingExecution(
	input: CancelPendingExecutionInput,
): Promise<void> {
	const { executionId, reason } = input;

	try {
		await cancelExecution(executionId, reason);
	} catch (error) {
		// Execution might not exist yet if it was never persisted
		console.warn(`Failed to cancel execution ${executionId}:`, error);
	}
}

// =============================================================================
// STATE MANAGEMENT
// =============================================================================

export interface SaveDeploymentStateInput {
	deploymentId: string;
	metrics: {
		totalExecutions: number;
		successfulExecutions: number;
		failedExecutions: number;
	};
	healthStatus: string;
}

export async function saveDeploymentState(
	input: SaveDeploymentStateInput,
): Promise<void> {
	// This would save state for recovery after continue-as-new
	// For now, we just update the deployment record
	const { deploymentId, healthStatus } = input;

	await dbUpdateDeploymentHealth(
		deploymentId,
		healthStatus as AgentDeploymentHealthStatus,
	);
}

// =============================================================================
// DEPLOYMENT CONFIGURATION
// =============================================================================

export interface GetDeploymentConfigInput {
	deploymentId: string;
	userId: string;
	organizationId?: string;
}

export interface DeploymentConfig {
	deploymentId: string;
	instanceId: string;
	maxConcurrentExecutions: number;
	rateLimitPerMinute: number;
	rateLimitPerHour: number;
	healthCheckIntervalMs: number;
	executionTimeoutMs: number;
	customInstructions?: Record<string, unknown>;
	integrationConfigurations?: Array<{
		integrationId: string;
		integrationType: string;
		allowedResources?: unknown;
	}>;
	toolConnections?: Record<string, unknown>;
}

export async function getDeploymentConfig(
	input: GetDeploymentConfigInput,
): Promise<DeploymentConfig | null> {
	const { deploymentId, userId, organizationId } = input;

	const deployment = await getAgentDeploymentById(deploymentId, {
		userId,
		organizationId,
	});

	if (!deployment) {
		return null;
	}

	return {
		deploymentId: deployment.id,
		instanceId: deployment.instanceId,
		maxConcurrentExecutions: deployment.maxConcurrentExecutions,
		rateLimitPerMinute: deployment.rateLimitPerMinute,
		rateLimitPerHour: deployment.rateLimitPerHour,
		healthCheckIntervalMs: 60000, // 1 minute
		executionTimeoutMs: 30 * 60 * 1000, // 30 minutes
		customInstructions: deployment.instance.customInstructions as
			| Record<string, unknown>
			| undefined,
		integrationConfigurations: (
			deployment.instance.integrationConfigurations || []
		).map(
			(ic: {
				integrationId: string;
				integrationType: string;
				allowedResources?: unknown;
			}) => ({
				integrationId: ic.integrationId,
				integrationType: ic.integrationType,
				allowedResources: ic.allowedResources ?? undefined,
			}),
		),
		toolConnections: deployment.instance.toolConnections as
			| Record<string, unknown>
			| undefined,
	};
}

// =============================================================================
// TASK QUEUE SELECTION
// =============================================================================

export interface SelectTaskQueueInput {
	userId: string;
	organizationId?: string;
	priority: number;
	estimatedDurationMs: number;
}

export interface TaskQueueResult {
	taskQueue: string;
	shardType:
		| "personal"
		| "organization-dedicated"
		| "organization-shared"
		| "priority";
}

const PERSONAL_SHARD_COUNT = 5;
const ORG_SHARED_SHARD_COUNT = 10;

export async function selectTaskQueue(
	input: SelectTaskQueueInput,
): Promise<TaskQueueResult> {
	const { userId, organizationId, priority, estimatedDurationMs } = input;

	// Priority override for critical tasks
	if (priority <= 2) {
		return {
			taskQueue: "agents-priority-critical",
			shardType: "priority",
		};
	}

	// Batch processing for low-priority, long-running tasks
	if (priority >= 8 && estimatedDurationMs > 300000) {
		return {
			taskQueue: "agents-batch",
			shardType: "priority",
		};
	}

	// Organization context
	if (organizationId) {
		// For now, use shared pool. In production, would check org volume
		// to determine if dedicated queues are needed.
		const shardNumber = hashCode(organizationId) % ORG_SHARED_SHARD_COUNT;
		return {
			taskQueue: `agents-org-shared-shard-${shardNumber}`,
			shardType: "organization-shared",
		};
	}

	// Personal accounts
	const shardNumber = hashCode(userId) % PERSONAL_SHARD_COUNT;
	return {
		taskQueue: `agents-personal-shard-${shardNumber}`,
		shardType: "personal",
	};
}

function hashCode(str: string): number {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = (hash << 5) - hash + char;
		hash = hash & hash; // Convert to 32-bit integer
	}
	return Math.abs(hash);
}
