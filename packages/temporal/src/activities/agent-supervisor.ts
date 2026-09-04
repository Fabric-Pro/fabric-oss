/**
 * Agent Supervisor Activities
 *
 * Activities for managing agent deployments, executions, and health monitoring.
 * These activities are called by the agent supervisor workflow.
 */

import {
	type AgentDeploymentHealthStatus,
	type AgentDeploymentStatus,
	cancelExecution,
	createAgentDeploymentExecution,
	startExecution as dbStartExecution,
	updateDeploymentHealth as dbUpdateDeploymentHealth,
	updateDeploymentStatus as dbUpdateDeploymentStatus,
	getAgentDeploymentById,
	incrementExecutionCounts,
	incrementExecutionQuota,
	type Prisma,
	updateCurrentExecutions,
	updateExecutionStatus,
} from "@repo/database";
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

	try {
		// Create execution record in database
		await createAgentDeploymentExecution({
			deploymentId,
			executionId,
			userId,
			organizationId,
			triggerType,
			triggerId,
			input: executionInput as Prisma.InputJsonValue,
			priority: 5, // Default priority
		});

		// Mark execution as started
		await dbStartExecution(executionId, workflowId, `run-${Date.now()}`);

		// Increment counters
		await updateCurrentExecutions(deploymentId, 1);
		await incrementExecutionCounts(deploymentId);
		await incrementExecutionQuota(userId, organizationId);

		// Start child workflow for actual agent execution
		const childWorkflowId = `deployment-exec-${executionId}`;

		// Shared client: carries the TLS / API-key / fail-closed connection
		// policy and the configured namespace (a bare `new Client()` would
		// silently target "default").
		const client = await getTemporalClient();

		// Get the deployment's task queue and instance config for workflow routing
		const deployment = await getAgentDeploymentById(deploymentId, {
			userId,
			organizationId,
		});

		// Use the "agents" task queue which the worker actually polls
		// The deployment.taskQueue was using sharded queues (agents-org-shared-shard-X)
		// that no worker was polling, causing workflows to hang indefinitely
		const taskQueue = "agents";

		// Supervisor workflow ID follows pattern: agent-supervisor-{deploymentId}
		const supervisorWorkflowId = `agent-supervisor-${deploymentId}`;

		// Determine workflow type based on instance execution mode
		const instance = deployment?.instance;
		const executionMode =
			(instance as { executionMode?: string } | null)?.executionMode ||
			"single_turn";
		const isGoalOriented = executionMode === "goal_oriented";

		if (isGoalOriented) {
			// Use goal-oriented workflow for iterative goal achievement
			const goal =
				(instance as { goal?: string } | null)?.goal ||
				"Complete the requested task";
			const successCriteria = (
				instance as { successCriteria?: unknown } | null
			)?.successCriteria;
			const maxIterations =
				(instance as { maxIterations?: number } | null)
					?.maxIterations || 10;

			await client.workflow.start("goalOrientedAgentWorkflow", {
				taskQueue,
				workflowId: childWorkflowId,
				args: [
					{
						executionId,
						deploymentId,
						instanceId,
						userId,
						organizationId,
						input: executionInput,
						goal,
						successCriteria,
						maxIterations,
						triggerType,
						triggerId,
						timeoutMs: timeoutMs || 30 * 60 * 1000,
						supervisorWorkflowId,
					},
				],
			});

			console.log("[AgentSupervisor] Started goal-oriented workflow:", {
				childWorkflowId,
				taskQueue,
				executionId,
				goalLength: goal.length,
				maxIterations,
			});
		} else {
			// Use standard single-turn workflow for simple Q&A
			await client.workflow.start("deploymentExecutionWorkflow", {
				taskQueue,
				workflowId: childWorkflowId,
				args: [
					{
						executionId,
						deploymentId,
						instanceId,
						userId,
						organizationId,
						input: executionInput,
						triggerType,
						triggerId,
						timeoutMs: timeoutMs || 30 * 60 * 1000,
						supervisorWorkflowId,
					},
				],
			});

			console.log("[AgentSupervisor] Started single-turn workflow:", {
				childWorkflowId,
				taskQueue,
				executionId,
			});
		}

		return { success: true, childWorkflowId };
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		console.error("[AgentSupervisor] Failed to start execution:", error);

		// Update execution as failed
		await updateExecutionStatus(executionId, "FAILED", {
			error: errorMessage,
			completedAt: new Date(),
		});

		// Decrement current executions since we failed to start
		await updateCurrentExecutions(deploymentId, -1);

		return { success: false, error: errorMessage };
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
