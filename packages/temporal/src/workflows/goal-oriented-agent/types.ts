/**
 * Goal-Oriented Agent Workflow Types
 *
 * Types specific to goal-oriented execution that combines agent template
 * context building with orchestrator-style planning and verification.
 */

import type {
	AgentVariable,
	ALTKConfig,
	RoutingDecision,
	TaskPlan,
	TaskStep,
	TrajectoryStep,
} from "../orchestrator/types";

// Re-export orchestrator types that we reuse
export type {
	TaskPlan,
	TaskStep,
	RoutingDecision,
	AgentVariable,
	TrajectoryStep,
	ALTKConfig,
};

// =============================================================================
// Workflow Input/Output
// =============================================================================

export interface GoalOrientedAgentInput {
	executionId: string;
	deploymentId: string;
	instanceId: string;
	userId: string;
	organizationId?: string;

	/** The user's input message/prompt */
	input: Record<string, unknown>;

	/** Natural language description of the goal */
	goal: string;

	/** How to determine if the goal is achieved */
	successCriteria?: SuccessCriteria;

	/** Maximum iterations before giving up */
	maxIterations?: number;

	/** Trigger information */
	triggerType: string;
	triggerId?: string;

	/** Timeout for the entire workflow */
	timeoutMs: number;

	/** Optional supervisor workflow ID for signaling */
	supervisorWorkflowId?: string;

	/** Optional conversation ID for multi-turn */
	conversationId?: string;

	/** Optional image references for multimodal input */
	imageRefs?: Array<{
		storagePath: string;
		mimeType: string;
		name: string;
	}>;
}

export interface GoalOrientedAgentOutput {
	executionId: string;
	status: "COMPLETED" | "FAILED" | "CANCELLED" | "MAX_ITERATIONS_REACHED";

	/** Whether the goal was achieved */
	goalAchieved: boolean;

	/** Final response/summary */
	response: string;

	/** Detailed output data */
	output?: Record<string, unknown>;

	/** Steps executed */
	stepsExecuted: ExecutedStep[];

	/** Total iterations used */
	iterationsUsed: number;

	/** Token usage */
	tokenUsage?: {
		inputTokens: number;
		outputTokens: number;
		totalCost?: number;
	};

	/** Duration in milliseconds */
	durationMs: number;

	/** Error message if failed */
	error?: string;

	/** Verification result from final check */
	verificationResult?: GoalVerificationResult;
}

// =============================================================================
// Success Criteria
// =============================================================================

export interface SuccessCriteria {
	/** Type of verification */
	type: "llm_judge" | "output_contains" | "tool_success" | "custom";

	/** For llm_judge: the prompt to evaluate success */
	evaluationPrompt?: string;

	/** For output_contains: strings that must be present */
	requiredOutputs?: string[];

	/** For tool_success: tools that must complete successfully */
	requiredTools?: string[];

	/** Minimum confidence for LLM judge (0-1) */
	confidenceThreshold?: number;
}

// =============================================================================
// Goal Verification
// =============================================================================

export interface GoalVerificationResult {
	achieved: boolean;
	confidence: number;
	reasoning: string;
	suggestions?: string[];
	missingCriteria?: string[];
}

// =============================================================================
// Execution Tracking
// =============================================================================

export interface ExecutedStep {
	id: string;
	type: "planning" | "execution" | "verification" | "recovery";
	description: string;
	status: "completed" | "failed" | "skipped";
	startedAt: string;
	completedAt?: string;
	durationMs?: number;
	toolCalls?: Array<{
		name: string;
		args: Record<string, unknown>;
		result?: unknown;
		status: "success" | "error";
	}>;
	error?: string;
	artifacts?: Array<{
		id: string;
		type: string;
		name?: string;
	}>;
}

// =============================================================================
// Workflow State
// =============================================================================

export interface GoalOrientedWorkflowState {
	executionId: string;
	startTime: number;
	status:
		| "running"
		| "awaiting_approval"
		| "completed"
		| "failed"
		| "cancelled";
	cancelled: boolean;

	/** The goal we're trying to achieve */
	goal: string;
	successCriteria: SuccessCriteria;

	/** Agent template context */
	agentContext: {
		systemPrompt: string;
		model: string;
		mcpConfigIds: string[];
		workspaceIds: string[];
	} | null;

	/** Current iteration */
	currentIteration: number;
	maxIterations: number;

	/** Task plan (regenerated each iteration if needed) */
	taskPlan: TaskPlan | null;
	routingDecision: RoutingDecision | null;

	/** Cross-step variables */
	variables: Record<string, AgentVariable>;

	/** Execution history */
	executedSteps: ExecutedStep[];
	trajectorySteps: TrajectoryStep[];

	/** Verification history */
	verificationHistory: GoalVerificationResult[];

	/** Knowledge context from RAG */
	knowledgeContext: string;

	/** Accumulated response */
	accumulatedResponse: string;

	/** Token tracking */
	totalInputTokens: number;
	totalOutputTokens: number;

	/** Progress for UI */
	currentProgress: GoalOrientedProgressUpdate;
}

export interface GoalOrientedProgressUpdate {
	executionId: string;
	phase:
		| "initializing"
		| "planning"
		| "executing"
		| "verifying"
		| "recovering"
		| "completed"
		| "failed";
	message: string;
	currentIteration: number;
	maxIterations: number;
	goalAchieved: boolean;
	stepsCompleted: number;
	totalSteps: number;
	timestamp: string;
}

// =============================================================================
// Configuration
// =============================================================================

export interface GoalOrientedConfig {
	/** Enable task decomposition (planning) */
	taskDecomposition: boolean;

	/** Enable reflection after each step */
	reflection: boolean;

	/** Enable automatic recovery on failure */
	autoRecovery: boolean;

	/** Number of recovery attempts per step */
	maxRecoveryAttempts: number;

	/** Timeout per step in milliseconds */
	stepTimeoutMs: number;

	/** Timeout for entire workflow in milliseconds */
	workflowTimeoutMs: number;
}

export const DEFAULT_GOAL_ORIENTED_CONFIG: GoalOrientedConfig = {
	taskDecomposition: true,
	reflection: true,
	autoRecovery: true,
	maxRecoveryAttempts: 2,
	stepTimeoutMs: 5 * 60 * 1000, // 5 minutes
	workflowTimeoutMs: 30 * 60 * 1000, // 30 minutes
};

export const DEFAULT_SUCCESS_CRITERIA: SuccessCriteria = {
	type: "llm_judge",
	confidenceThreshold: 0.8,
};

// =============================================================================
// Helper to create initial state
// =============================================================================

export function createInitialGoalOrientedState(
	input: GoalOrientedAgentInput,
): GoalOrientedWorkflowState {
	const executionId = input.executionId;
	const startTime = Date.now();

	return {
		executionId,
		startTime,
		status: "running",
		cancelled: false,

		goal: input.goal,
		successCriteria: input.successCriteria || DEFAULT_SUCCESS_CRITERIA,

		agentContext: null,

		currentIteration: 0,
		maxIterations: input.maxIterations || 10,

		taskPlan: null,
		routingDecision: null,

		variables: {
			"sys.executionId": {
				name: "sys.executionId",
				value: executionId,
				setBy: "system",
				setAt: new Date().toISOString(),
				scope: "workflow",
				readonly: true,
			},
			"sys.userId": {
				name: "sys.userId",
				value: input.userId,
				setBy: "system",
				setAt: new Date().toISOString(),
				scope: "workflow",
				readonly: true,
			},
			"sys.organizationId": {
				name: "sys.organizationId",
				value: input.organizationId,
				setBy: "system",
				setAt: new Date().toISOString(),
				scope: "workflow",
				readonly: true,
			},
			"sys.goal": {
				name: "sys.goal",
				value: input.goal,
				setBy: "system",
				setAt: new Date().toISOString(),
				scope: "workflow",
				readonly: true,
			},
		},

		executedSteps: [],
		trajectorySteps: [],
		verificationHistory: [],

		knowledgeContext: "",
		accumulatedResponse: "",

		totalInputTokens: 0,
		totalOutputTokens: 0,

		currentProgress: {
			executionId,
			phase: "initializing",
			message: "Starting goal-oriented execution...",
			currentIteration: 0,
			maxIterations: input.maxIterations || 10,
			goalAchieved: false,
			stepsCompleted: 0,
			totalSteps: 0,
			timestamp: new Date().toISOString(),
		},
	};
}
