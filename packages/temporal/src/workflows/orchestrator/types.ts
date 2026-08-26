/**
 * Orchestrator Workflow Types
 *
 * Shared types for the modular orchestrator workflow phases.
 */

import type { LimitSignal } from "@repo/ai/limits";
import type { CircuitBreakerState } from "./circuit-breaker";
import type {
	AgentVariable as AgentVariableType,
	ApprovalSignalData as ApprovalSignalDataType,
	OrchestratorProgressUpdate as OrchestratorProgressUpdateType,
	OrchestratorStepResult as OrchestratorStepResultType,
	OrchestratorWorkflowInput as OrchestratorWorkflowInputType,
	OrchestratorWorkflowOutput as OrchestratorWorkflowOutputType,
	RoutingDecision as RoutingDecisionType,
	TaskPlan as TaskPlanType,
	TaskStep as TaskStepType,
	TrajectoryStep as TrajectoryStepType,
} from "./types/index";
import type { McpDefaultToolSignal } from "./types/mcp-default-tool-signal.types";

export * from "./orchestrator-config";
export type { RiskAssessmentResult, ToolCallForRisk } from "./risk-assessment";
// Re-export shared pure functions & config
export {
	assessToolCallRisk,
	isBulkOperation,
	isDestructiveStep,
} from "./risk-assessment";
// Re-export all types for external consumers
export type {
	// Agent types
	AgentCapability,
	AgentVariable,
	ALTKConfig,
	ApprovalSignalData,
	CapabilityType,
	// Memory types
	ExecutionMemorySummary,
	ExecutionMode,
	FailureWarning,
	HybridRoutingResult,
	HybridRoutingSuggestion,
	// MCP Default-Tool Signal Types
	McpDefaultToolFailedPayload,
	McpDefaultToolFailureKind,
	McpDefaultToolInvokedPayload,
	McpDefaultToolSignal,
	McpDefaultToolSurface,
	OrchestratorProgressUpdate,
	OrchestratorStepResult,
	OrchestratorWorkflowInput,
	OrchestratorWorkflowOutput,
	OrchestratorWorkspace,
	PolicyContext,
	// Policy types
	PolicyRule,
	RoutingDecision,
	SemanticMemoryResult,
	TaskPlan,
	TaskStep,
	Trajectory,
	TrajectoryStep,
} from "./types/index";

// Re-export constants needed by workflow
export {
	AGENT_REGISTRY,
	DEFAULT_ALTK_CONFIG,
	EXECUTION_MODE_CONFIGS,
} from "./types/index";

// Type aliases for internal use
type TaskPlan = TaskPlanType;
type RoutingDecision = RoutingDecisionType;
type AgentVariable = AgentVariableType;
type TrajectoryStep = TrajectoryStepType;
type OrchestratorWorkflowOutput = OrchestratorWorkflowOutputType;
type OrchestratorStepResult = OrchestratorStepResultType;
type ApprovalSignalData = ApprovalSignalDataType;
type OrchestratorProgressUpdate = OrchestratorProgressUpdateType;
type TaskStep = TaskStepType;
type OrchestratorWorkflowInput = OrchestratorWorkflowInputType;

/**
 * Orchestrator workflow status type
 */
export type OrchestratorWorkflowStatus =
	| "running"
	| "awaiting_approval"
	| "completed"
	| "failed"
	| "cancelled";

/**
 * Planning audit tracking - captures what influenced planning decisions
 */
export interface PlanningAudit {
	planningStartedAt: Date;
	planningCompletedAt: Date | null;
	contextSources: Array<{
		type: string;
		description: string;
		confidence?: number;
		used: boolean;
		usageReason?: string;
	}>;
	decisions: Array<{
		category: string;
		decision: string;
		reasoning: string;
		confidence: number;
	}>;
}

/**
 * Journey state for multi-turn conversation tracking
 */
export interface JourneyState {
	journeyId: string;
	phase: string;
	turnCount: number;
	decisions: Array<{ category: string; decision: string; reasoning: string }>;
	assumptions: Array<{ description: string; isValid?: boolean }>;
	blockers: Array<{ description: string; resolved: boolean }>;
	modifications: Array<{
		type: string;
		description: string;
		timestamp: string;
	}>;
	conversationHistory: Array<{
		role: string;
		content: string;
		timestamp: string;
	}>;
}

/**
 * Approval history entry
 */
export interface ApprovalHistoryEntry {
	approvalId: string;
	stepId: string;
	stepDescription: string;
	riskLevel: string;
	requestedAt: string;
	decidedAt: string | undefined;
	approved: boolean;
	feedback: string | undefined;
}

/**
 * Pending approval info
 */
export interface PendingApprovalInfo {
	approvalId: string;
	stepId: string;
	reason: string;
	checkboxText?: string;
	agent?: string;
	reviewType?: string;
}

/**
 * Pending clarifying-question info. A human-in-the-loop sibling of
 * PendingApprovalInfo: instead of approve/reject, the user answers an
 * open question (optionally choosing one of `options`). Mirrors the approval
 * pause mechanics (see waitForClarification in the workflow).
 */
export interface PendingClarificationInfo {
	clarificationId: string;
	/** Set for a per-step clarification; absent for an up-front (pre-planning) one. */
	stepId?: string;
	question: string;
	options?: string[];
}

/**
 * The user's answer to a clarifying question, delivered via the
 * `clarification` signal. `dismissed` mirrors the card's dismiss action.
 */
export interface ClarificationDecision {
	answer: string;
	dismissed?: boolean;
}

/**
 * Follow-up message
 */
export interface FollowUpMessage {
	message: string;
	isModification: boolean;
	receivedAt: string;
}

/**
 * Pending plan modification
 */
export interface PendingModification {
	type: string;
	description: string;
	affectedSteps: string[];
	requiresConfirmation: boolean;
}

/**
 * Tracks which capabilities are degraded due to initialization failures.
 *
 * Issue #9: Surface degraded state in planning audit and optionally in UI
 */
export interface DegradedCapabilities {
	/** Letta / semantic memory failed to initialize */
	memory: boolean;
	/** Workspace RAG context unavailable */
	rag: boolean;
	/** Fabric AI pattern enrichment failed */
	patterns: boolean;
	/** Policy enrichment failed */
	policies: boolean;
	/** Orchestrator episodic memory unavailable */
	orchestratorMemory: boolean;
	/** Instance memory / skills failed to load */
	instanceMemory: boolean;
}

/**
 * Token cost tracking for a single iteration (iterative mode)
 */
export interface IterationCost {
	iteration: number;
	toolName?: string;
	inputTokens: number;
	outputTokens: number;
	timestamp: string;
}

/**
 * Message in the iterative conversation history
 */
export interface IterativeMessage {
	role: "user" | "assistant" | "tool";
	content: string;
	toolCalls?: Array<{
		id: string;
		name: string;
		args: Record<string, unknown>;
		/** Provider-specific metadata (e.g. Gemini thoughtSignature) */
		providerMetadata?: Record<string, unknown>;
	}>;
	toolCallId?: string;
	timestamp: string;
	/** Which workflow iteration produced this message (for pruning) */
	iteration?: number;
}

/**
 * Pending tool approval in iterative mode
 */
export interface PendingToolApproval {
	toolCall: {
		id: string;
		name: string;
		args: Record<string, unknown>;
	};
	riskLevel: string;
	reason: string;
	iteration: number;
}

/**
 * Execution mode configuration type
 * Note: Full definition is in types/execution-mode.types.ts
 */
export interface ExecutionModeConfig {
	mode?: string;
	taskDecomposition: boolean;
	reflection: boolean;
	detailedThoughts?: boolean;
	maxRetries?: number;
	workflowTimeoutMs: number;
	stepTimeoutMs: number;
	/** Maximum iterations for iterative mode */
	maxIterations?: number;
	/** Iteration timeout in milliseconds (for iterative mode) */
	iterationTimeoutMs?: number;
	/** Maximum total tokens for iterative mode (cost control) */
	maxTotalTokens?: number;
}

/**
 * Meta-tool search quality metrics.
 *
 * Issue #11: Track search_tools effectiveness for observability
 */
export interface ToolSearchMetrics {
	/** Total search_tools invocations */
	totalSearches: number;
	/** Searches that returned 0 results */
	zeroResultSearches: number;
	/** Running sum of top-result confidence scores */
	confidenceSum: number;
	/** Names of tools discovered via search */
	toolsDiscovered: string[];
}

/**
 * Shared workflow state that is passed between phases
 */
export interface WorkflowState {
	executionId: string;
	startTime: number;
	status: OrchestratorWorkflowStatus;
	cancelled: boolean;

	// Plan and routing
	taskPlan: TaskPlan | null;
	routingDecision: RoutingDecision | null;

	// Variables for cross-step context
	variables: Record<string, AgentVariable>;

	// Execution tracking
	trajectorySteps: TrajectoryStep[];
	toolCalls: OrchestratorWorkflowOutput["toolCalls"];
	stepResults: OrchestratorStepResult[];

	// Approval state
	pendingApproval: PendingApprovalInfo | null;
	approvalDecision: ApprovalSignalData | null;
	approvalHistory: ApprovalHistoryEntry[];
	/** When true, all future checkpoints are auto-approved */
	autoApproveAll: boolean;

	// Clarifying-question (HITL) state — sibling of approval above.
	pendingClarification: PendingClarificationInfo | null;
	clarificationDecision: ClarificationDecision | null;

	// Planning audit
	planningAudit: PlanningAudit;

	// Journey state (multi-turn)
	journeyState: JourneyState;

	// Follow-up handling
	followUpMessages: FollowUpMessage[];
	pendingModification: PendingModification | null;

	// Context
	workspaceContext: string;
	enrichedMessage: string;
	enrichedSystemPrompt: string;
	lettaAgentId: string | null;

	// Preloaded resources (loaded once, reused for all steps)
	preloadedResources: PreloadedResources | null;

	// Progress
	currentProgress: OrchestratorProgressUpdate;

	// Iterative mode tracking
	/** Current iteration number (iterative mode only) */
	currentIteration: number;
	/** Cost tracking per iteration (iterative mode only) */
	iterationCosts: IterationCost[];
	/** Conversation history for iterative mode */
	iterativeConversationHistory: IterativeMessage[];
	/** Pending tool approval in iterative mode */
	pendingToolApproval: PendingToolApproval | null;
	/**
	 * Iteration number at which `iterativeConversationHistory` was last
	 * compacted (older turns replaced with a summary block). Used to enforce
	 * a cooldown between compactions so we don't re-summarize on every
	 * iteration once we cross the budget threshold.
	 */
	lastCompactionIteration: number;
	/**
	 * Set when the budget-exhaustion synthesis fires. Carries the structured
	 * "Progress so far" summary so the workflow output can include it in
	 * `handoffRecommended` for the frontend's "Continue in new chat" CTA.
	 */
	pendingHandoff: { reason: string; summary: string } | null;

	// Circuit breaker: per-agent failure tracking within this workflow execution
	agentCircuitBreakers: Record<string, CircuitBreakerState>;

	// Per-tool consecutive `success: false` counter; resets on first success.
	consecutiveToolFailures: Record<string, number>;

	// Issue #9: Track which capabilities are degraded
	degradedCapabilities: DegradedCapabilities;

	// Issue #11: Meta-tool search quality metrics
	toolSearchMetrics: ToolSearchMetrics;

	// Monotonic counter for Loom-added step IDs. Replaces a clock-based ID
	// (`safeNowMs()`) which was non-replay-stable for histories recorded under
	// pre-1.16 workers. See docs/bugs/ORCHESTRATOR_LOOM_STEP_ID_TIMESTAMP.md.
	loomAddedSeq: number;

	// Accumulated provider/internal budget exhaustion signals.
	// Populated by the classifier (`@repo/ai/limits`) in run-agent-iteration and
	// by iterative-execution when TokenBudgetManager reports exhaustion. Included
	// in the final workflow output and streamed as `limit_signal` SSE events so
	// the UI can show a banner or toast.
	limitSignals: LimitSignal[];

	// Accumulated managed-default MCP tool invocation / failure analytics
	// payloads. Populated by:
	//   - the catch blocks in `applyDefaultMcpEagerRouting`
	//   - the `executeMcpTool` caller wrapper for managed-default failures
	//   - the `executeMcpTool` caller wrapper for managed-default successes.
	// The per-event SSE forwarder downstream lets each entry surface in
	// the client hooks as a `mcp_default_tool_{invoked,failed}` event for
	// `useAnalytics().trackEvent`.
	mcpDefaultToolSignals: McpDefaultToolSignal[];

	/**
	 * Index of the next unflushed entry in `mcpDefaultToolSignals`.
	 * `flushMcpDefaultToolSignals` (in `iterative-execution.ts`) reads from
	 * this offset to the end, fires one telemetry activity per entry, then
	 * advances the cursor. Storing the cursor on workflow state (rather than
	 * as a closure variable inside the iteration loop) keeps the invariant
	 * intact across `continueAsNew` boundaries and across the
	 * iterative-vs-completion-phase split — both phases call the same
	 * flusher and share progress. Initialized to 0 in `createInitialState`.
	 */
	mcpDefaultToolSignalFlushIndex: number;
}

/**
 * Step context - comprehensive context passed to each step
 * Industry best practice: Include ALL relevant context for each step execution
 */
export interface StepExecutionContext {
	// Current step info
	stepIndex: number;
	totalSteps: number;
	currentStep: TaskStep;

	// Full context from previous steps (not truncated)
	previousStepResults: Array<{
		stepId: string;
		stepDescription: string;
		status: "complete" | "error" | "skipped";
		response?: string;
		toolCalls?: Array<{
			name: string;
			args: unknown;
			result: unknown;
			status: "success" | "error";
		}>;
		artifacts?: Array<{
			id: string;
			type: string;
			name?: string;
			content?: string;
		}>;
		// Key outputs that should be preserved
		keyOutputs?: Record<string, unknown>;
	}>;

	// Variables accumulated from all previous steps
	variables: Record<string, AgentVariable>;

	// Conversation context
	conversationHistory?: Array<{
		role: string;
		content: string;
	}>;

	// Original task and enriched message
	originalMessage: string;
	enrichedMessage: string;
	systemPrompt: string;

	// Workspace/RAG context
	workspaceContext?: string;

	// Memory context from semantic search
	memoryContext?: string;

	// Plan context - what steps are planned after this one
	remainingSteps: Array<{
		id: string;
		description: string;
		executor?: string;
	}>;
}

/**
 * Phase result - standard return type for each phase
 */
export interface PhaseResult<T = void> {
	success: boolean;
	data?: T;
	error?: string;
	shouldContinue: boolean;
}

/**
 * Preloaded resources - loaded ONCE at workflow start, reused for all steps
 * This avoids redundant database queries and MCP connections per step.
 */
export interface PreloadedResources {
	// User preferences (loaded once)
	userPreferences: {
		enabledMcpConfigIds: string[];
		enabledAgentIds: string[];
		trustLevel: number;
	} | null;

	// MCP tool definitions (loaded once, reused for all steps)
	mcpTools: {
		configId: string;
		serverId: string;
		serverName: string;
		tools: Array<{
			name: string;
			description: string;
			inputSchema: Record<string, unknown>;
		}>;
	}[];

	// Flattened tool map for quick lookup
	toolMap: Record<
		string,
		{
			configId: string;
			serverName: string;
			dispatchMetadata?: {
				integrationId: string;
				indexNames: string[];
			};
			definition: {
				name: string;
				description: string;
				inputSchema: Record<string, unknown>;
			};
		}
	>;

	// Agent registry (loaded once)
	agents: Array<{
		agentId: string;
		displayName: string;
		description: string;
		endpoint: string | null;
		protocol: string;
		capabilities: Record<string, unknown>;
	}>;

	// Preloaded at timestamp
	loadedAt: string;

	// Loading duration for metrics
	loadDurationMs: number;
}

/**
 * Recovery result
 */
export interface RecoveryResult {
	recovered: boolean;
	response?: string;
	strategyUsed?: string;
	attemptsMade: number;
	finalError?: string;
}

/**
 * Initialize workflow state with defaults
 */
export function createInitialState(
	input: OrchestratorWorkflowInput,
): WorkflowState {
	const executionId = input.executionId;
	const startTime = Date.now();

	return {
		executionId,
		startTime,
		status: "running",
		cancelled: false,

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
			...input.inheritedVariables,
		},

		trajectorySteps: [],
		toolCalls: [],
		stepResults: [],

		pendingApproval: null,
		approvalDecision: null,
		approvalHistory: [],
		autoApproveAll: false,

		pendingClarification: null,
		clarificationDecision: null,

		planningAudit: {
			planningStartedAt: new Date(),
			planningCompletedAt: null,
			contextSources: [],
			decisions: [],
		},

		journeyState: {
			journeyId: `journey-${executionId}`,
			phase: "initializing",
			turnCount: 1,
			decisions: [],
			assumptions: [],
			blockers: [],
			modifications: [],
			conversationHistory:
				input.history?.map((h) => ({
					role: h.role,
					content: h.content,
					timestamp: new Date().toISOString(),
				})) || [],
		},

		followUpMessages: [],
		pendingModification: null,

		workspaceContext: "",
		enrichedMessage: input.message,
		enrichedSystemPrompt: "",
		lettaAgentId: null,

		preloadedResources: null,

		currentProgress: {
			executionId,
			completedSteps: 0,
			totalSteps: 0,
			phase: "routing",
			message: "Starting orchestrator...",
			timestamp: new Date().toISOString(),
			stepResults: [],
		},

		// Iterative mode fields
		currentIteration: 0,
		iterationCosts: [],
		iterativeConversationHistory: [],
		pendingToolApproval: null,
		lastCompactionIteration: 0,
		pendingHandoff: null,

		// Circuit breaker state (starts empty — all circuits implicitly CLOSED)
		agentCircuitBreakers: {},
		consecutiveToolFailures: {},

		// Issue #9: All capabilities start as non-degraded
		degradedCapabilities: {
			memory: false,
			rag: false,
			patterns: false,
			policies: false,
			orchestratorMemory: false,
			instanceMemory: false,
		},

		// Issue #11: Search metrics start empty
		toolSearchMetrics: {
			totalSearches: 0,
			zeroResultSearches: 0,
			confidenceSum: 0,
			toolsDiscovered: [],
		},

		loomAddedSeq: 0,

		// Start with no limit signals
		limitSignals: [],

		// Start with no MCP default-tool signals. Pushed by the catch
		// blocks in `applyDefaultMcpEagerRouting`, the `executeMcpTool`
		// caller wrapper, and the success-branch wrapper.
		mcpDefaultToolSignals: [],
		// Flush cursor starts at 0; the helper publishes only the
		// entries at index >= cursor and advances on success.
		mcpDefaultToolSignalFlushIndex: 0,
	};
}
