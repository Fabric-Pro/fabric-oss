/**
 * Agent Supervisor Workflow
 *
 * Long-running Temporal workflow that manages a single agent deployment.
 * Handles:
 * - Execution queue management with priority ordering
 * - Concurrency control (respects max concurrent executions)
 * - Health monitoring with heartbeats
 * - Lifecycle management (pause/resume/terminate)
 * - Rate limiting per deployment
 *
 * Uses continue-as-new to prevent workflow history explosion for long-running deployments.
 */

import {
	condition,
	continueAsNew,
	defineQuery,
	defineSignal,
	log,
	patched,
	proxyActivities,
	setHandler,
	workflowInfo,
} from "@temporalio/workflow";

import type * as supervisorActivities from "../activities/agent-supervisor";

// =============================================================================
// TYPES
// =============================================================================

export interface SupervisorWorkflowInput {
	deploymentId: string;
	instanceId: string;
	userId: string;
	organizationId?: string;
	config: DeploymentConfig;
}

export interface DeploymentConfig {
	maxConcurrentExecutions: number;
	rateLimitPerMinute: number;
	rateLimitPerHour: number;
	healthCheckIntervalMs: number;
	executionTimeoutMs: number;
}

export type SupervisorStatus = "active" | "paused" | "terminating";
export type HealthStatus = "healthy" | "degraded" | "unhealthy";

interface SupervisorState {
	deploymentId: string;
	status: SupervisorStatus;
	currentExecutions: Map<string, ExecutionInfo>;
	pendingExecutions: ExecutionRequest[];
	healthStatus: HealthStatus;
	lastHealthCheck: string;
	metrics: {
		totalExecutions: number;
		successfulExecutions: number;
		failedExecutions: number;
	};
	// Rate limiting tracking
	minuteExecutionCount: number;
	minuteWindowStart: number;
	hourExecutionCount: number;
	hourWindowStart: number;
	// Continue-as-new tracking
	executionsSinceReset: number;
	startTime: number;
}

export interface ExecutionRequest {
	executionId: string;
	input: Record<string, unknown>;
	triggerType: string;
	triggerId?: string;
	priority: number;
	queuedAt: string;
}

interface ExecutionInfo {
	executionId: string;
	workflowId: string;
	startedAt: string;
	status: "running" | "completing";
}

// =============================================================================
// SIGNALS
// =============================================================================

export const executeSignal = defineSignal<[ExecutionRequest]>("execute");
export const pauseSignal = defineSignal("pause");
export const resumeSignal = defineSignal("resume");
export const terminateSignal = defineSignal("terminate");
export const cancelExecutionSignal =
	defineSignal<[{ executionId: string }]>("cancelExecution");
export const executionCompletedSignal =
	defineSignal<[{ executionId: string; success: boolean }]>(
		"executionCompleted",
	);

// =============================================================================
// QUERIES
// =============================================================================

export const statusQuery = defineQuery<SupervisorStatus>("status");
export const healthQuery = defineQuery<HealthStatus>("health");
export const metricsQuery = defineQuery<SupervisorState["metrics"]>("metrics");
export const currentExecutionsQuery = defineQuery<number>("currentExecutions");
export const pendingExecutionsQuery = defineQuery<number>("pendingExecutions");
export const canAcceptExecutionQuery =
	defineQuery<boolean>("canAcceptExecution");

// =============================================================================
// ACTIVITIES
// =============================================================================

const activities = proxyActivities<typeof supervisorActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

const longRunningActivities = proxyActivities<typeof supervisorActivities>({
	startToCloseTimeout: "30 minutes",
	heartbeatTimeout: "30s",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "60s",
		maximumAttempts: 2,
	},
});

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_EXECUTIONS_BEFORE_CONTINUE_AS_NEW = 1000;
const MAX_DURATION_BEFORE_CONTINUE_AS_NEW_MS = 60 * 60 * 1000; // 1 hour
const POLL_INTERVAL_MS = 5000; // 5 seconds
const HEALTH_CHECK_INTERVAL_MS = 60000; // 1 minute

// =============================================================================
// WORKFLOW IMPLEMENTATION
// =============================================================================

export async function agentSupervisorWorkflow(
	input: SupervisorWorkflowInput,
): Promise<void> {
	const { deploymentId, config } = input;

	// Initialize state
	const state: SupervisorState = {
		deploymentId,
		status: "active",
		currentExecutions: new Map(),
		pendingExecutions: [],
		healthStatus: "healthy",
		lastHealthCheck: new Date().toISOString(),
		metrics: {
			totalExecutions: 0,
			successfulExecutions: 0,
			failedExecutions: 0,
		},
		minuteExecutionCount: 0,
		minuteWindowStart: Date.now(),
		hourExecutionCount: 0,
		hourWindowStart: Date.now(),
		executionsSinceReset: 0,
		startTime: Date.now(),
	};

	// ==========================================================================
	// Signal Handlers
	// ==========================================================================

	setHandler(executeSignal, (request) => {
		log.info("Received execution request", {
			executionId: request.executionId,
			priority: request.priority,
		});

		// Add to pending queue (sorted by priority, then by queue time)
		state.pendingExecutions.push(request);
		state.pendingExecutions.sort((a, b) => {
			if (a.priority !== b.priority) {
				return a.priority - b.priority; // Lower number = higher priority
			}
			return (
				new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime()
			);
		});
	});

	setHandler(pauseSignal, () => {
		log.info("Received pause signal");
		state.status = "paused";
	});

	setHandler(resumeSignal, () => {
		log.info("Received resume signal");
		state.status = "active";
	});

	setHandler(terminateSignal, () => {
		log.info("Received terminate signal");
		state.status = "terminating";
	});

	setHandler(cancelExecutionSignal, ({ executionId }) => {
		log.info("Received cancel execution signal", { executionId });
		// Remove from pending if present
		state.pendingExecutions = state.pendingExecutions.filter(
			(e) => e.executionId !== executionId,
		);
		// Mark running execution for cancellation
		const running = state.currentExecutions.get(executionId);
		if (running) {
			running.status = "completing";
		}
	});

	setHandler(executionCompletedSignal, ({ executionId, success }) => {
		log.info("Execution completed", { executionId, success });
		state.currentExecutions.delete(executionId);
		if (success) {
			state.metrics.successfulExecutions++;
		} else {
			state.metrics.failedExecutions++;
		}
	});

	// ==========================================================================
	// Query Handlers
	// ==========================================================================

	setHandler(statusQuery, () => state.status);
	setHandler(healthQuery, () => state.healthStatus);
	setHandler(metricsQuery, () => state.metrics);
	setHandler(currentExecutionsQuery, () => state.currentExecutions.size);
	setHandler(pendingExecutionsQuery, () => state.pendingExecutions.length);
	setHandler(canAcceptExecutionQuery, () => {
		// Check if we can accept more executions
		if (state.status !== "active") {
			return false;
		}
		if (state.currentExecutions.size >= config.maxConcurrentExecutions) {
			return false;
		}
		if (!checkRateLimit(state, config)) {
			return false;
		}
		return true;
	});

	// ==========================================================================
	// Main Loop
	// ==========================================================================

	log.info("Starting agent supervisor", { deploymentId });

	// Update deployment status to ACTIVE
	await activities.updateDeploymentStatus({
		deploymentId,
		status: "ACTIVE",
		deployedAt: new Date().toISOString(),
	});

	while (state.status !== "terminating") {
		// Check for continue-as-new condition
		if (shouldContinueAsNew(state)) {
			log.info("Continuing as new to prevent history growth", {
				executionsSinceReset: state.executionsSinceReset,
				runningExecutions: state.currentExecutions.size,
			});

			// Save state before continuing
			await activities.saveDeploymentState({
				deploymentId,
				metrics: state.metrics,
				healthStatus: state.healthStatus,
			});

			// Preserve pending executions through continue-as-new
			// Running executions will be tracked via their child workflows
			await continueAsNew<typeof agentSupervisorWorkflow>({
				...input,
				// Note: pending executions need to be re-queued after continue-as-new
				// The supervisor activities should handle this
			});
		}

		// Handle paused state
		if (state.status === "paused") {
			await activities.updateDeploymentStatus({
				deploymentId,
				status: "PAUSED",
				pausedAt: new Date().toISOString(),
			});

			// Wait for resume signal
			await condition(() => state.status !== "paused", "24h"); // Max 24h pause

			// Check status after waiting
			// Note: We need to cast to break TypeScript's incorrect type narrowing
			// because signal handlers can modify state.status while waiting
			const currentStatus = state.status as SupervisorStatus;
			if (currentStatus === "active") {
				await activities.updateDeploymentStatus({
					deploymentId,
					status: "ACTIVE",
				});
			}
			continue;
		}

		// Reset rate limit windows if needed
		resetRateLimitWindows(state);

		// Process pending executions (respecting concurrency and rate limits)
		while (
			state.pendingExecutions.length > 0 &&
			state.currentExecutions.size < config.maxConcurrentExecutions &&
			checkRateLimit(state, config)
		) {
			// biome-ignore lint/style/noNonNullAssertion: pendingExecutions.shift() is non-null since length > 0
			const request = state.pendingExecutions.shift()!;
			await startExecution(state, input, request, config);
		}

		// Health check (every HEALTH_CHECK_INTERVAL_MS)
		const timeSinceHealthCheck =
			Date.now() - new Date(state.lastHealthCheck).getTime();
		if (timeSinceHealthCheck > HEALTH_CHECK_INTERVAL_MS) {
			await performHealthCheck(state, deploymentId);
		}

		// Wait for signals or timeout (polling interval)
		await condition(
			() =>
				state.pendingExecutions.length > 0 || state.status !== "active",
			POLL_INTERVAL_MS,
		);

		state.executionsSinceReset++;
	}

	// ==========================================================================
	// Termination Cleanup
	// ==========================================================================

	log.info("Terminating supervisor", {
		deploymentId,
		pendingCount: state.pendingExecutions.length,
		runningCount: state.currentExecutions.size,
	});

	// Cancel all pending executions
	for (const pending of state.pendingExecutions) {
		await activities.cancelPendingExecution({
			executionId: pending.executionId,
			reason: "Deployment terminated",
		});
	}

	// Wait for running executions to complete (with timeout)
	const terminationTimeout = 60000; // 1 minute
	await condition(
		() => state.currentExecutions.size === 0,
		terminationTimeout,
	);

	// Force cancel any remaining executions
	if (state.currentExecutions.size > 0) {
		log.warn("Force cancelling remaining executions", {
			count: state.currentExecutions.size,
		});
		for (const [execId] of state.currentExecutions) {
			await activities.cancelPendingExecution({
				executionId: execId,
				reason: "Deployment terminated (timeout)",
			});
		}
	}

	// Update deployment status to TERMINATED
	await activities.updateDeploymentStatus({
		deploymentId,
		status: "TERMINATED",
		terminatedAt: new Date().toISOString(),
	});

	log.info("Supervisor terminated", { deploymentId });
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

async function startExecution(
	state: SupervisorState,
	input: SupervisorWorkflowInput,
	request: ExecutionRequest,
	config: DeploymentConfig,
): Promise<void> {
	const { deploymentId, instanceId, userId, organizationId } = input;

	log.info("Starting execution", {
		executionId: request.executionId,
		priority: request.priority,
	});

	try {
		// Start child workflow for execution
		const workflowId = `agent-exec-${request.executionId}`;

		await longRunningActivities.startAgentExecution({
			workflowId,
			deploymentId,
			instanceId,
			executionId: request.executionId,
			userId,
			organizationId,
			input: request.input,
			triggerType: request.triggerType,
			triggerId: request.triggerId,
			timeoutMs: config.executionTimeoutMs,
		});

		// Track in current executions
		state.currentExecutions.set(request.executionId, {
			executionId: request.executionId,
			workflowId,
			startedAt: new Date().toISOString(),
			status: "running",
		});

		state.metrics.totalExecutions++;

		// Update rate limit counters
		state.minuteExecutionCount++;
		state.hourExecutionCount++;
	} catch (error) {
		log.error("Failed to start execution", {
			executionId: request.executionId,
			error: error instanceof Error ? error.message : "Unknown",
		});
		state.metrics.failedExecutions++;
	}
}

async function performHealthCheck(
	state: SupervisorState,
	deploymentId: string,
): Promise<void> {
	try {
		const health = await activities.checkDeploymentHealth({ deploymentId });
		state.healthStatus = health.status as HealthStatus;
		state.lastHealthCheck = new Date().toISOString();

		// Update deployment health status in database
		await activities.updateDeploymentHealth({
			deploymentId,
			healthStatus: health.status,
			lastHealthCheck: state.lastHealthCheck,
			consecutiveFailures: health.consecutiveFailures,
		});
	} catch (error) {
		log.warn("Health check failed", {
			error: error instanceof Error ? error.message : "Unknown",
		});
		state.healthStatus = "degraded";
	}
}

function shouldContinueAsNew(state: SupervisorState): boolean {
	// Gated by patched() so in-flight executions started under the prior
	// `executionsSinceReset >= MAX_EXECUTIONS_BEFORE_CONTINUE_AS_NEW` threshold
	// replay deterministically. The 1-hour duration guard is a business
	// constraint and applies to all runs.
	const historyBased = patched("agent-supervisor-can-suggested-2026-04")
		? workflowInfo().continueAsNewSuggested
		: state.executionsSinceReset >= MAX_EXECUTIONS_BEFORE_CONTINUE_AS_NEW;

	return (
		historyBased ||
		Date.now() - state.startTime >= MAX_DURATION_BEFORE_CONTINUE_AS_NEW_MS
	);
}

function checkRateLimit(
	state: SupervisorState,
	config: DeploymentConfig,
): boolean {
	// Check minute rate limit
	if (state.minuteExecutionCount >= config.rateLimitPerMinute) {
		return false;
	}

	// Check hour rate limit
	if (state.hourExecutionCount >= config.rateLimitPerHour) {
		return false;
	}

	return true;
}

function resetRateLimitWindows(state: SupervisorState): void {
	const now = Date.now();

	// Reset minute window
	if (now - state.minuteWindowStart >= 60000) {
		state.minuteExecutionCount = 0;
		state.minuteWindowStart = now;
	}

	// Reset hour window
	if (now - state.hourWindowStart >= 3600000) {
		state.hourExecutionCount = 0;
		state.hourWindowStart = now;
	}
}
