/**
 * Dynamic Agent Workflow Types
 *
 * Types for the dynamic agent execution workflow that loads configuration
 * from the Visual Agent Builder and executes with goal-oriented patterns.
 */

import type {
	ExecutedStep,
	GoalVerificationResult,
	SuccessCriteria,
	TaskPlan,
	TrajectoryStep,
} from "../goal-oriented-agent/types";

// Re-export useful types
export type { ExecutedStep, GoalVerificationResult, SuccessCriteria };

// =============================================================================
// Agent Configuration (from Visual Builder)
// =============================================================================

export interface DynamicAgentConfig {
	id: string;
	name: string;
	displayName: string;
	description?: string;
	avatar?: string;
	category: string;
	tags: string[];

	/** System prompt / instructions */
	instructions: string;

	/** AI model settings */
	model: string;
	temperature: number;
	maxTokens: number;
	reasoningMode: "fast" | "balanced" | "thorough";

	/** Connected knowledge sources (workspace IDs) */
	workspaceIds: string[];

	/** Connected tools (MCP config IDs) */
	mcpConfigIds: string[];

	/** Configured triggers */
	triggers: TriggerConfig[];

	/** Scope settings */
	scope: "USER" | "ORGANIZATION" | "SYSTEM";

	/** Owner info */
	userId: string;
	organizationId?: string;
}

export interface TriggerConfig {
	id: string;
	type: "webhook" | "schedule" | "slack" | "email";
	enabled: boolean;
	config: Record<string, unknown>;
}

// =============================================================================
// Workflow Input/Output
// =============================================================================

export interface DynamicAgentInput {
	/** Execution ID for tracking */
	executionId: string;

	/** Agent configuration ID (loads from DB) OR inline config */
	agentConfigId?: string;
	agentConfig?: DynamicAgentConfig;

	/** The user's input/message */
	input: {
		message: string;
		attachments?: Array<{
			id: string;
			type: string;
			name: string;
			url?: string;
		}>;
		metadata?: Record<string, unknown>;
	};

	/** Goal to achieve (optional - uses agent's default if not provided) */
	goal?: string;

	/** Success criteria (optional) */
	successCriteria?: SuccessCriteria;

	/** Trigger context */
	trigger: {
		type: "manual" | "webhook" | "schedule" | "slack" | "email";
		id?: string;
		source?: string;
		metadata?: Record<string, unknown>;
	};

	/** User context */
	userId: string;
	organizationId?: string;

	/** Conversation context for multi-turn */
	conversationId?: string;
	parentMessageId?: string;

	/** Limits */
	maxIterations?: number;
	timeoutMs?: number;
}

export interface DynamicAgentOutput {
	executionId: string;
	agentId: string;
	agentName: string;

	status: "COMPLETED" | "FAILED" | "CANCELLED" | "TIMEOUT";
	goalAchieved: boolean;

	/** Final response */
	response: string;

	/** Detailed output */
	output?: {
		variables?: Record<string, unknown>;
		artifacts?: Array<{
			id: string;
			type: string;
			name?: string;
			url?: string;
		}>;
	};

	/** Execution details */
	stepsExecuted: ExecutedStep[];
	iterationsUsed: number;

	/** Token usage */
	tokenUsage?: {
		inputTokens: number;
		outputTokens: number;
		totalCost?: number;
	};

	/** Timing */
	durationMs: number;

	/** Error if failed */
	error?: string;

	/** Verification result */
	verificationResult?: GoalVerificationResult;

	/** Conversation tracking */
	conversationId?: string;
	messageId?: string;
}

// =============================================================================
// Workflow State
// =============================================================================

export interface DynamicAgentWorkflowState {
	executionId: string;
	startTime: number;
	status: "initializing" | "running" | "completed" | "failed" | "cancelled";
	cancelled: boolean;

	/** Loaded agent configuration */
	agentConfig: DynamicAgentConfig | null;

	/** Current goal */
	goal: string;
	successCriteria: SuccessCriteria;

	/** Iteration tracking */
	currentIteration: number;
	maxIterations: number;

	/** Current plan */
	taskPlan: TaskPlan | null;

	/** Execution history */
	executedSteps: ExecutedStep[];
	trajectorySteps: TrajectoryStep[];
	verificationHistory: GoalVerificationResult[];

	/** Context */
	knowledgeContext: string;
	conversationHistory: Array<{
		role: "user" | "assistant" | "system";
		content: string;
		timestamp: string;
	}>;

	/** Accumulated output */
	accumulatedResponse: string;
	variables: Record<string, unknown>;
	artifacts: Array<{
		id: string;
		type: string;
		name?: string;
		url?: string;
	}>;

	/** Token tracking */
	totalInputTokens: number;
	totalOutputTokens: number;

	/** Progress for UI */
	currentProgress: DynamicAgentProgress;
}

export interface DynamicAgentProgress {
	executionId: string;
	agentId?: string;
	agentName?: string;
	phase:
		| "initializing"
		| "loading_config"
		| "fetching_knowledge"
		| "planning"
		| "executing"
		| "verifying"
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

export interface DynamicAgentWorkflowConfig {
	/** Enable RAG knowledge retrieval */
	enableRag: boolean;

	/** Enable context pruning for long conversations */
	enableContextPruning: boolean;
	contextPruningThreshold: number;

	/** Enable sub-agent delegation */
	enableSubAgents: boolean;
	maxSubAgentDepth: number;

	/** Enable goal verification loop */
	enableGoalVerification: boolean;

	/** Recovery settings */
	autoRecovery: boolean;
	maxRecoveryAttempts: number;

	/** Timeouts */
	stepTimeoutMs: number;
	workflowTimeoutMs: number;
}

export const DEFAULT_DYNAMIC_AGENT_CONFIG: DynamicAgentWorkflowConfig = {
	enableRag: true,
	enableContextPruning: true,
	contextPruningThreshold: 80000, // 80k tokens

	enableSubAgents: true,
	maxSubAgentDepth: 4,

	enableGoalVerification: true,

	autoRecovery: true,
	maxRecoveryAttempts: 2,

	stepTimeoutMs: 5 * 60 * 1000, // 5 minutes
	workflowTimeoutMs: 30 * 60 * 1000, // 30 minutes
};

// =============================================================================
// Helpers
// =============================================================================

export function createInitialDynamicAgentState(
	input: DynamicAgentInput,
): DynamicAgentWorkflowState {
	const startTime = Date.now();

	return {
		executionId: input.executionId,
		startTime,
		status: "initializing",
		cancelled: false,

		agentConfig: input.agentConfig || null,

		goal: input.goal || input.input.message,
		successCriteria: input.successCriteria || {
			type: "llm_judge",
			confidenceThreshold: 0.8,
		},

		currentIteration: 0,
		maxIterations: input.maxIterations || 10,

		taskPlan: null,

		executedSteps: [],
		trajectorySteps: [],
		verificationHistory: [],

		knowledgeContext: "",
		conversationHistory: [
			{
				role: "user",
				content: input.input.message,
				timestamp: new Date().toISOString(),
			},
		],

		accumulatedResponse: "",
		variables: {
			"sys.executionId": input.executionId,
			"sys.userId": input.userId,
			"sys.organizationId": input.organizationId,
			"sys.trigger": input.trigger,
		},
		artifacts: [],

		totalInputTokens: 0,
		totalOutputTokens: 0,

		currentProgress: {
			executionId: input.executionId,
			phase: "initializing",
			message: "Starting dynamic agent execution...",
			currentIteration: 0,
			maxIterations: input.maxIterations || 10,
			goalAchieved: false,
			stepsCompleted: 0,
			totalSteps: 0,
			timestamp: new Date().toISOString(),
		},
	};
}
