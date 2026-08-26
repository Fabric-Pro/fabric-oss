/**
 * Recovery Manager
 *
 * Handles graceful recovery from step failures with intelligent strategies.
 * Supports retry, fallback, skip, and replan operations.
 *
 * Part of Phase 2: Intelligent Planning - Backtracking and Recovery
 */

import { logger } from "@repo/logs";
import { resolveAgentEndpointWithFallbacks } from "../delegation/resolve-endpoint";
import type { AgentVariable, TaskPlan, TaskStep } from "../types";

// =============================================================================
// Types
// =============================================================================

export type FailureType =
	| "executor_unavailable"
	| "input_invalid"
	| "timeout"
	| "rate_limited"
	| "permission_denied"
	| "resource_conflict"
	| "partial_success"
	| "unknown";

export interface FailureClassification {
	type: FailureType;
	message: string;
	isRetryable: boolean;
	suggestedDelay?: number;
	maxRetries?: number;
}

export interface RecoveryStrategy {
	name: string;
	description: string;
	applicability: number; // 0-1 confidence this will work
	action: RecoveryAction;
}

export type RecoveryAction =
	| { type: "retry"; delay: number; maxAttempts: number }
	| { type: "fallback_executor"; executorId: string; reason: string }
	| { type: "skip_step"; impact: string; preserveOutputs: boolean }
	| {
			type: "replan_from";
			stepId: string;
			newContext: Record<string, unknown>;
	  }
	| { type: "abort"; reason: string };

export interface RecoveryDecision {
	selectedStrategy: RecoveryStrategy;
	reasoning: string;
	shouldContinue: boolean;
	modifiedStep?: TaskStep;
	additionalContext?: Record<string, unknown>;
}

export interface RecoveryContext {
	step: TaskStep;
	plan: TaskPlan;
	error: Error | string;
	attemptNumber: number;
	previousAttempts: AttemptRecord[];
	variables: Record<string, AgentVariable>;
	availableExecutors: string[];
}

export interface AttemptRecord {
	timestamp: Date;
	error: string;
	strategy: string;
	durationMs: number;
}

// =============================================================================
// Failure Classification
// =============================================================================

/**
 * Classify a failure to determine appropriate recovery strategy.
 */
export function classifyFailure(
	error: Error | string,
	step: TaskStep,
): FailureClassification {
	const errorMessage = error instanceof Error ? error.message : String(error);
	const errorLower = errorMessage.toLowerCase();

	// Executor unavailable
	if (
		errorLower.includes("not found") ||
		errorLower.includes("unavailable") ||
		errorLower.includes("connection refused") ||
		errorLower.includes("endpoint not found") ||
		errorLower.includes("agent not registered")
	) {
		return {
			type: "executor_unavailable",
			message: `Executor '${step.executor}' is unavailable`,
			isRetryable: false, // Don't retry, need fallback
		};
	}

	// Timeout
	if (
		errorLower.includes("timeout") ||
		errorLower.includes("timed out") ||
		errorLower.includes("deadline exceeded")
	) {
		return {
			type: "timeout",
			message: "Operation timed out",
			isRetryable: true,
			suggestedDelay: 5000, // 5 seconds
			maxRetries: 2,
		};
	}

	// Rate limiting
	if (
		errorLower.includes("rate limit") ||
		errorLower.includes("too many requests") ||
		errorLower.includes("429")
	) {
		return {
			type: "rate_limited",
			message: "Rate limit exceeded",
			isRetryable: true,
			suggestedDelay: extractRetryDelay(errorMessage) || 30000, // 30 seconds default
			maxRetries: 3,
		};
	}

	// Permission denied
	if (
		errorLower.includes("permission denied") ||
		errorLower.includes("unauthorized") ||
		errorLower.includes("forbidden") ||
		errorLower.includes("access denied") ||
		errorLower.includes("401") ||
		errorLower.includes("403")
	) {
		return {
			type: "permission_denied",
			message: "Permission denied for this operation",
			isRetryable: false,
		};
	}

	// Resource conflict
	if (
		errorLower.includes("conflict") ||
		errorLower.includes("already exists") ||
		errorLower.includes("duplicate") ||
		errorLower.includes("409")
	) {
		return {
			type: "resource_conflict",
			message: "Resource conflict detected",
			isRetryable: false, // Need different approach
		};
	}

	// Input validation
	if (
		errorLower.includes("invalid") ||
		errorLower.includes("validation") ||
		errorLower.includes("required") ||
		errorLower.includes("missing") ||
		errorLower.includes("schema")
	) {
		return {
			type: "input_invalid",
			message: "Invalid input parameters",
			isRetryable: false,
		};
	}

	// Partial success
	if (
		errorLower.includes("partial") ||
		errorLower.includes("some") ||
		errorLower.includes("incomplete")
	) {
		return {
			type: "partial_success",
			message: "Operation partially completed",
			isRetryable: true,
			suggestedDelay: 2000,
			maxRetries: 1,
		};
	}

	// Unknown error
	return {
		type: "unknown",
		message: errorMessage,
		isRetryable: true,
		suggestedDelay: 5000,
		maxRetries: 2,
	};
}

function extractRetryDelay(errorMessage: string): number | undefined {
	// Look for retry-after patterns
	const patterns = [
		/retry[- ]?after[:\s]+(\d+)/i,
		/wait[:\s]+(\d+)\s*(?:second|sec|s)/i,
		/try again in[:\s]+(\d+)/i,
	];

	for (const pattern of patterns) {
		const match = errorMessage.match(pattern);
		if (match) {
			const seconds = Number.parseInt(match[1], 10);
			return seconds * 1000; // Convert to milliseconds
		}
	}

	return undefined;
}

// =============================================================================
// Recovery Strategy Selection
// =============================================================================

/**
 * Determine recovery strategies for a failed step.
 */
export function getRecoveryStrategies(
	context: RecoveryContext,
): RecoveryStrategy[] {
	const {
		step,
		error,
		attemptNumber,
		previousAttempts: _previousAttempts,
		availableExecutors,
	} = context;
	const classification = classifyFailure(error, step);
	const strategies: RecoveryStrategy[] = [];

	logger.info("[RecoveryManager] Analyzing failure", {
		stepId: step.id,
		failureType: classification.type,
		attemptNumber,
	});

	// Strategy 1: Retry with backoff (if retryable)
	if (
		classification.isRetryable &&
		attemptNumber < (classification.maxRetries || 3)
	) {
		const delay = calculateBackoff(
			attemptNumber,
			classification.suggestedDelay || 5000,
		);
		strategies.push({
			name: "retry_with_backoff",
			description: `Retry after ${delay}ms with exponential backoff`,
			applicability:
				attemptNumber === 1 ? 0.8 : 0.5 - attemptNumber * 0.1,
			action: {
				type: "retry",
				delay,
				maxAttempts: classification.maxRetries || 3,
			},
		});
	}

	// Strategy 2: Fallback executor (for executor-related failures)
	if (
		classification.type === "executor_unavailable" ||
		classification.type === "timeout"
	) {
		const fallbackExecutors = findFallbackExecutors(
			step,
			availableExecutors,
		);
		if (fallbackExecutors.length > 0) {
			strategies.push({
				name: "fallback_executor",
				description: `Use alternative executor: ${fallbackExecutors[0]}`,
				applicability: 0.7,
				action: {
					type: "fallback_executor",
					executorId: fallbackExecutors[0],
					reason: `Original executor '${step.executor}' failed: ${classification.message}`,
				},
			});
		}
	}

	// Strategy 3: Skip step (for non-critical steps)
	if (!step.requiresApproval && step.riskLevel !== "critical") {
		const impact = assessSkipImpact(step, context);
		strategies.push({
			name: "skip_step",
			description: "Skip this step and continue with plan",
			applicability: step.riskLevel === "low" ? 0.6 : 0.3,
			action: {
				type: "skip_step",
				impact,
				preserveOutputs: classification.type === "partial_success",
			},
		});
	}

	// Strategy 4: Replan from this point (for complex failures)
	if (
		classification.type === "input_invalid" ||
		classification.type === "resource_conflict" ||
		attemptNumber >= 3
	) {
		strategies.push({
			name: "replan_from_step",
			description: `Replan the execution from step '${step.id}'`,
			applicability: 0.4,
			action: {
				type: "replan_from",
				stepId: step.id,
				newContext: {
					failureReason: classification.message,
					previousApproach: step.description,
				},
			},
		});
	}

	// Strategy 5: Abort (always available as last resort)
	strategies.push({
		name: "abort",
		description: "Abort execution and report failure",
		applicability: 0.1,
		action: {
			type: "abort",
			reason: `Step '${step.id}' failed after ${attemptNumber} attempt(s): ${classification.message}`,
		},
	});

	// Sort by applicability
	return strategies.sort((a, b) => b.applicability - a.applicability);
}

function calculateBackoff(attemptNumber: number, baseDelay: number): number {
	// Exponential backoff with jitter
	const exponential = baseDelay * 2 ** (attemptNumber - 1);
	const jitter = exponential * 0.2 * Math.random();
	return Math.min(exponential + jitter, 60000); // Cap at 60 seconds
}

function findFallbackExecutors(
	step: TaskStep,
	availableExecutors: string[],
): string[] {
	const fallbacks: string[] = [];
	const currentExecutor = step.executor || "";

	// Static fallback map kept as a last-resort safety net for contexts where
	// tenant information is unavailable. The preferred path is
	// `findFallbackExecutorsDynamic` which discovers fallbacks from the DB.
	const fallbackMap: Record<string, string[]> = {
		// Document generators
		project_document_generator: ["document_generator"],
		document_generator: ["project_document_generator"],

		// Generalists
		cuga_generalist: ["api_agent", "mcp_tool_executor"],

		// Planners
		task_planner: ["story_breakdown"],

		// MCP executor fallback to LLM
		mcp_tool_executor: ["llm"],

		// Default fallback
		default: ["mcp_tool_executor", "llm"],
	};

	const potentialFallbacks =
		fallbackMap[currentExecutor] || fallbackMap.default;

	for (const fallback of potentialFallbacks) {
		if (
			availableExecutors.includes(fallback) &&
			fallback !== currentExecutor
		) {
			fallbacks.push(fallback);
		}
	}

	return fallbacks;
}

/**
 * Dynamically discover fallback executors for a failed agent by querying the
 * database for agents that share capability tags with the failed agent.
 *
 * This replaces the static `fallbackMap` approach and automatically adapts to
 * newly registered agents without code changes.
 *
 * @param failedAgentId  - The `executor` value from the failed TaskStep
 * @param userId         - Required for tenant-scoped DB lookups
 * @param organizationId - Optional; switches to org context when provided
 * @returns Ordered list of fallback executor IDs (primary excluded), freshest first
 */
export async function findFallbackExecutorsDynamic(
	failedAgentId: string,
	userId: string,
	organizationId?: string,
): Promise<string[]> {
	try {
		const candidates = await resolveAgentEndpointWithFallbacks(
			failedAgentId,
			userId,
			organizationId,
		);

		// Drop the first entry — that is the primary/failed agent itself (if found).
		// Return only the fallbacks as their agentId strings.
		const fallbacks = candidates
			.slice(1) // skip primary
			.map((a) => a.agentId);

		logger.info("[RecoveryManager] Dynamic fallback discovery complete", {
			failedAgentId,
			fallbackCount: fallbacks.length,
			fallbacks,
		});

		return fallbacks;
	} catch (err) {
		logger.warn(
			"[RecoveryManager] Dynamic fallback discovery failed, falling back to static map",
			{ failedAgentId, error: String(err) },
		);
		return [];
	}
}

function assessSkipImpact(step: TaskStep, context: RecoveryContext): string {
	const impacts: string[] = [];

	// Check if other steps depend on this step
	const dependentSteps = context.plan.steps.filter((s) => {
		if (!s.inputs) {
			return false;
		}
		const inputs = s.inputs as Record<string, unknown>;
		if (inputs.contextInputs && Array.isArray(inputs.contextInputs)) {
			return inputs.contextInputs.includes(step.id);
		}
		return false;
	});

	if (dependentSteps.length > 0) {
		impacts.push(
			`${dependentSteps.length} dependent step(s) may be affected`,
		);
	}

	// Check if this is a data-gathering step
	if (step.type === "research" || step.type === "api") {
		impacts.push("May miss important data for later steps");
	}

	// Check if this is a critical operation
	if (step.riskLevel === "high") {
		impacts.push("High-priority operation will be skipped");
	}

	return impacts.length > 0 ? impacts.join("; ") : "Minimal impact expected";
}

// =============================================================================
// Recovery Execution
// =============================================================================

/**
 * Select and execute recovery strategy.
 */
export function selectRecoveryStrategy(
	context: RecoveryContext,
	strategies: RecoveryStrategy[],
): RecoveryDecision {
	// If no strategies available, abort
	if (strategies.length === 0) {
		return {
			selectedStrategy: {
				name: "abort",
				description: "No recovery strategies available",
				applicability: 1,
				action: {
					type: "abort",
					reason: "No recovery strategies available",
				},
			},
			reasoning: "No viable recovery strategies could be determined",
			shouldContinue: false,
		};
	}

	// Select best strategy based on applicability and context
	const selectedStrategy = selectBestStrategy(strategies, context);

	// Determine if execution should continue
	const shouldContinue = selectedStrategy.action.type !== "abort";

	// Modify step if using fallback executor
	let modifiedStep: TaskStep | undefined;
	if (selectedStrategy.action.type === "fallback_executor") {
		modifiedStep = {
			...context.step,
			executor: selectedStrategy.action.executorId,
		};
	}

	logger.info("[RecoveryManager] Selected recovery strategy", {
		stepId: context.step.id,
		strategy: selectedStrategy.name,
		applicability: selectedStrategy.applicability,
		shouldContinue,
	});

	return {
		selectedStrategy,
		reasoning: `Selected '${selectedStrategy.name}' with ${(selectedStrategy.applicability * 100).toFixed(0)}% confidence`,
		shouldContinue,
		modifiedStep,
	};
}

function selectBestStrategy(
	strategies: RecoveryStrategy[],
	context: RecoveryContext,
): RecoveryStrategy {
	// Strategies are already sorted by applicability

	// Prefer retry for first failure
	if (context.attemptNumber === 1) {
		const retryStrategy = strategies.find((s) => s.action.type === "retry");
		if (retryStrategy && retryStrategy.applicability > 0.5) {
			return retryStrategy;
		}
	}

	// Prefer fallback for executor issues
	const classification = classifyFailure(context.error, context.step);
	if (classification.type === "executor_unavailable") {
		const fallbackStrategy = strategies.find(
			(s) => s.action.type === "fallback_executor",
		);
		if (fallbackStrategy) {
			return fallbackStrategy;
		}
	}

	// Prefer skip for low-risk steps after multiple failures
	if (context.attemptNumber >= 2 && context.step.riskLevel === "low") {
		const skipStrategy = strategies.find(
			(s) => s.action.type === "skip_step",
		);
		if (skipStrategy && skipStrategy.applicability > 0.3) {
			return skipStrategy;
		}
	}

	// Return highest applicability strategy
	return strategies[0];
}

// =============================================================================
// Checkpoint Management
// =============================================================================

export interface ExecutionCheckpoint {
	id: string;
	planId: string;
	stepId: string;
	timestamp: Date;
	variables: Record<string, AgentVariable>;
	completedSteps: string[];
	stepResults: Array<{
		stepId: string;
		status: "complete" | "error" | "skipped";
		response?: string;
		error?: string;
	}>;
}

/**
 * Create a checkpoint of the current execution state.
 */
export function createCheckpoint(
	planId: string,
	currentStepId: string,
	variables: Record<string, AgentVariable>,
	completedSteps: string[],
	stepResults: ExecutionCheckpoint["stepResults"],
): ExecutionCheckpoint {
	return {
		id: `checkpoint-${Date.now()}`,
		planId,
		stepId: currentStepId,
		timestamp: new Date(),
		variables: { ...variables },
		completedSteps: [...completedSteps],
		stepResults: [...stepResults],
	};
}

/**
 * Restore execution from a checkpoint.
 */
export function restoreFromCheckpoint(
	checkpoint: ExecutionCheckpoint,
	plan: TaskPlan,
): {
	startFromStep: number;
	variables: Record<string, AgentVariable>;
	skippedSteps: string[];
} {
	// Find the step index to resume from
	const startFromStep = plan.steps.findIndex(
		(s) => s.id === checkpoint.stepId,
	);

	// Mark completed steps
	const skippedSteps = checkpoint.completedSteps;

	return {
		startFromStep: startFromStep >= 0 ? startFromStep : 0,
		variables: checkpoint.variables,
		skippedSteps,
	};
}

// =============================================================================
// Recovery Helpers
// =============================================================================

/**
 * Determine if a step should be retried based on error and attempt count.
 */
export function shouldRetry(
	error: Error | string,
	step: TaskStep,
	attemptNumber: number,
	maxAttempts = 3,
): boolean {
	if (attemptNumber >= maxAttempts) {
		return false;
	}

	const classification = classifyFailure(error, step);
	return classification.isRetryable;
}

/**
 * Get delay before next retry attempt.
 */
export function getRetryDelay(
	error: Error | string,
	step: TaskStep,
	attemptNumber: number,
): number {
	const classification = classifyFailure(error, step);
	return calculateBackoff(
		attemptNumber,
		classification.suggestedDelay || 5000,
	);
}

/**
 * Format error for user display.
 */
export function formatRecoveryError(
	context: RecoveryContext,
	decision: RecoveryDecision,
): string {
	const classification = classifyFailure(context.error, context.step);

	const parts: string[] = [
		`Step "${context.step.description}" encountered an issue: ${classification.message}`,
	];

	if (decision.shouldContinue) {
		parts.push(`Recovery: ${decision.selectedStrategy.description}`);
	} else {
		parts.push(`Unable to recover. ${decision.reasoning}`);
	}

	return parts.join("\n");
}

// =============================================================================
// Activity Wrappers
// These wrap pure functions as activities for Temporal workflow compatibility
// =============================================================================

/**
 * Activity wrapper for classifyFailure.
 * Required because dynamic imports are not allowed in Temporal workflows.
 */
export async function classifyFailureActivity(
	error: string,
	step: TaskStep,
): Promise<FailureClassification> {
	return classifyFailure(error, step);
}

/**
 * Activity wrapper for shouldRetry.
 */
export async function shouldRetryActivity(
	error: string,
	step: TaskStep,
	attemptNumber: number,
	maxAttempts?: number,
): Promise<boolean> {
	return shouldRetry(error, step, attemptNumber, maxAttempts);
}

/**
 * Activity wrapper for getRetryDelay.
 */
export async function getRetryDelayActivity(
	error: string,
	step: TaskStep,
	attemptNumber: number,
): Promise<number> {
	return getRetryDelay(error, step, attemptNumber);
}

/**
 * Activity wrapper for findFallbackExecutorsDynamic.
 *
 * Discovers fallback executors from the database using capability tag matching.
 * Falls back to the static map (via `findFallbackExecutors`) when the dynamic
 * lookup returns no results.
 *
 * @param step           - The failed TaskStep (uses `step.executor` as the failed agent ID)
 * @param userId         - Required for tenant-scoped DB lookups
 * @param organizationId - Optional; switches to org context when provided
 * @returns Ordered list of fallback executor IDs, freshest first
 */
export async function findFallbackExecutorsDynamicActivity(
	step: TaskStep,
	availableExecutors: string[],
	userId: string,
	organizationId?: string,
): Promise<string[]> {
	const failedAgentId = step.executor || "";

	// Attempt dynamic DB-based discovery first
	const dynamicFallbacks = await findFallbackExecutorsDynamic(
		failedAgentId,
		userId,
		organizationId,
	);

	if (dynamicFallbacks.length > 0) {
		// Filter to executors the orchestrator considers available
		const filtered = dynamicFallbacks.filter(
			(id) => availableExecutors.includes(id) && id !== failedAgentId,
		);
		if (filtered.length > 0) {
			return filtered;
		}
	}

	// Fall back to static map when dynamic discovery yields nothing
	logger.info(
		"[RecoveryManager] Dynamic fallbacks empty or unavailable, using static map",
		{ failedAgentId },
	);
	return findFallbackExecutors(step, availableExecutors);
}
