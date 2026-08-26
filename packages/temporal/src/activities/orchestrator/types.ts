/**
 * Orchestrator Activity Types
 *
 * Type definitions for all orchestrator activities.
 * Extracted from orchestrator-activities.ts for better organization.
 */

import type {
	AgentVariable,
	ALTKConfig,
	ExecutionMode,
	OrchestratorWorkspace,
	PolicyContext,
	RoutingDecision,
	TaskStep,
	TrajectoryStep,
} from "../../workflows/orchestrator/types";

// =============================================================================
// Activity Input/Output Types
// =============================================================================

export interface AnalyzeAndRouteInput {
	message: string;
	history: Array<{ role: "user" | "assistant"; content: string }>;
	userId: string;
	organizationId?: string;
	// SECURITY: Credentials are fetched internally by activities
	// API keys are NOT passed in workflow inputs to avoid storing them in Temporal history
	enabledMcpConfigIds?: string[] | null;
	enabledAgentIds?: string[] | null;
	enabledFabricToolIds?: string[] | null;
	/** Enabled workflow integration IDs (null = all) */
	enabledIntegrationIds?: string[] | null;
	/** Prioritized tool IDs - these get boosted confidence in semantic search */
	prioritizedToolIds?: string[];
	/** Prioritized agent IDs - these get boosted confidence in agent selection */
	prioritizedAgentIds?: string[];
	/** Prioritized MCP server config IDs - tools from these servers get boosted */
	prioritizedMcpConfigIds?: string[];
	/** Prioritized workflow integration IDs - these get boosted confidence */
	prioritizedIntegrationIds?: string[];
	/** Memory context including learned patterns from past interactions */
	memoryContext?: string;
	/** Attached image URLs for image editing/generation */
	attachedImageUrls?: string[];
}

export interface CreateTaskPlanInput {
	message: string;
	routingDecision: RoutingDecision;
	userId: string;
	organizationId?: string;
	enabledMcpConfigIds?: string[] | null;
	enabledAgentIds?: string[] | null;
	executionMode: ExecutionMode;
	/** User-starred tool IDs - these should be prioritized in planning */
	prioritizedToolIds?: string[];
	/** User-starred MCP server config IDs - tools from these should be prioritized */
	prioritizedMcpConfigIds?: string[];
	/** Conversation history for context in planning */
	history?: Array<{ role: "user" | "assistant"; content: string }>;
	/** Attached image URLs for image editing/generation */
	attachedImageUrls?: string[];
}

export interface ExecuteStepInput {
	step: TaskStep;
	message: string;
	systemPrompt: string;
	variables: Record<string, AgentVariable>;
	userId: string;
	organizationId?: string;
	/** Execution ID for real-time PartyKit updates */
	executionId?: string;
	/** Real conversation ID for linking persisted artifacts to the chat */
	conversationId?: string;
	enabledMcpConfigIds?: string[] | null;
	enabledAgentIds?: string[] | null;
	executionMode: ExecutionMode;
	/** Workspace IDs for RAG queries (passed from workflow input) */
	workspaceIds?: string[];
	/** Project ID for project-specific RAG queries (passed from workflow input) */
	projectId?: string;
	altkConfig?: ALTKConfig;
	/** Total number of steps in the plan */
	totalSteps: number;
	/** Current step index (1-based) */
	stepIndex: number;
	/** Results from previous steps for context */
	previousStepResults: Array<{
		stepId: string;
		stepDescription: string;
		response?: string;
		/** Key outputs extracted from tool calls (IDs, counts, names) */
		keyOutputs?: Record<string, unknown>;
	}>;
	/** Letta agent ID for semantic memory and tool result caching */
	lettaAgentId?: string | null;
	/** Conversation history for context in follow-up questions */
	conversationHistory?: Array<{
		role: "user" | "assistant" | "system";
		content: string;
	}>;
	/**
	 * Preloaded MCP tools - pass this to skip per-step tool loading.
	 * These are loaded ONCE at workflow start and reused for all steps.
	 */
	preloadedTools?: {
		toolMap: Record<
			string,
			{
				configId: string;
				serverName: string;
				definition: {
					name: string;
					description: string;
					inputSchema: Record<string, unknown>;
				};
			}
		>;
	};
	/**
	 * Matched MCP tools from routing semantic search.
	 * Used to filter tools sent to LLM for better focus and reduced tokens.
	 */
	matchedMcpTools?: Array<{
		toolName: string;
		configId: string;
		description?: string;
		confidence: number;
		/** Input schema for the tool - CRITICAL for LLM to know parameter names */
		inputSchema?: Record<string, unknown>;
	}>;
	/** Attached image URLs for image editing/generation */
	attachedImageUrls?: string[];
	/**
	 * Matched integrations from routing semantic search.
	 * Used to determine if an integration can handle the step.
	 */
	matchedIntegrations?: Array<{
		integrationId: string;
		name: string;
		provider: string;
		description: string;
		confidence: number;
		reason: string;
		capabilities: string[];
	}>;
}

export interface ExecuteStepOutput {
	/** Step ID this output corresponds to */
	stepId?: string;
	/** Status of the step execution */
	status?: "completed" | "failed" | "partial" | "pending" | "auth_required";
	outputs?: Record<string, unknown>;
	variables?: Record<string, AgentVariable>;
	toolCalls?: Array<{
		id: string;
		name: string;
		args: unknown;
		result: unknown;
		status: "success" | "error";
		durationMs: number;
	}>;
	response?: string;
	/** Artifacts generated by this step (documents, code, data, charts) */
	artifacts?: Array<{
		id: string;
		type:
			| "document"
			| "code"
			| "data"
			| "tool_result"
			| "file"
			| "error"
			| "chart";
		name?: string;
		content?: string;
		metadata?: Record<string, unknown>;
	}>;
	/**
	 * OAuth authorization is required for an MCP server used by this step.
	 * When set, the workflow should pause and signal the UI to show the connection dialog.
	 */
	authRequired?: {
		configId: string;
		serverName: string;
	};
}

export interface ExecuteMcpToolInput {
	toolName: string;
	args: Record<string, unknown>;
	userId: string;
	organizationId?: string;
	/** Project ID for per-project AI usage attribution on Fabric AI tools */
	projectId?: string;
	mcpConfigId?: string;
	/**
	 * Orchestrator execution ID. Binds runtime authority checks to this run so a
	 * grant approved for one chat session cannot authorize another.
	 */
	executionId?: string;
	/** Letta agent ID for tool result caching */
	lettaAgentId?: string | null;
	/** Attached image URLs (fallback for image tools when not in args) */
	attachedImageUrls?: string[];
	/**
	 * Opt-in hard cap for a single tool execution (ms). When set, the call is
	 * raced against a timer and returns a `success:false` timeout result if it
	 * has not settled — bounding a hung MCP call so it cannot block the caller
	 * (or leak the heartbeat interval). Default `undefined` = no timeout.
	 */
	timeoutMs?: number;
}

export interface ExecuteMcpToolOutput {
	output: unknown;
	durationMs: number;
	success: boolean;
	/** Whether the result was retrieved from cache */
	cached?: boolean;
	/** Number of times this cached result has been used */
	cacheHitCount?: number;
	/**
	 * OAuth authorization is required for this MCP server.
	 * When true, the workflow should pause and signal the UI to show the connection dialog.
	 */
	authRequired?: boolean;
	/** MCP config ID that needs authorization */
	authRequiredConfigId?: string;
	/** Server name for display */
	authRequiredServerName?: string;
	/** MCP App: ui:// resource URI for the interactive HTML UI (if tool has MCP App support) */
	mcpAppResourceUri?: string;
	/** MCP App: MCP config ID for proxying tool calls back to the server */
	mcpAppConfigId?: string;
}

export interface ExecuteAgentAsToolInput {
	agentId: string;
	input: Record<string, unknown>;
	userId: string;
	organizationId?: string;
	projectId?: string;
	parentExecutionId?: string;
	inheritedVariables?: Record<string, AgentVariable>;
}

export interface TriggerWorkflowInput {
	workflowId: string;
	userId: string;
	organizationId?: string;
	variables?: Record<string, unknown>;
}

export interface ApplyPolicyEnrichmentInput {
	message: string;
	userId: string;
	organizationId?: string;
	policyContext: PolicyContext;
}

export interface ApplyPolicyEnrichmentOutput {
	enrichedMessage?: string;
	systemPromptAdditions?: string;
	blocked: boolean;
	blockReason?: string;
}

export interface ValidateWithALTKInput {
	input: unknown;
	output: unknown;
	config: ALTKConfig;
}

export interface ReflectOnOutputInput {
	stepDescription: string;
	output: unknown;
	expectedOutcome: string;
}

export interface ReflectOnOutputOutput {
	satisfactory: boolean;
	reason?: string;
	suggestions?: string[];
}

export interface SaveTrajectoryInput {
	taskDescription: string;
	steps: TrajectoryStep[];
	outcome: "success" | "partial" | "failure";
	totalDurationMs: number;
	userId: string;
	organizationId?: string;
	/** Final workspace state for replay */
	finalWorkspace?: OrchestratorWorkspace;
}

export interface FindSimilarTrajectoryInput {
	taskDescription: string;
	userId: string;
	organizationId?: string;
}

/**
 * Represents an item that will be affected by a destructive operation
 */
export interface AffectedItem {
	/** Unique identifier for the item */
	id: string;
	/** Display name or title of the item */
	name: string;
	/** Type of item (e.g., "board", "card", "file") */
	type: string;
	/** Additional metadata about the item */
	metadata?: Record<string, unknown>;
}

export interface CreateApprovalRequestInput {
	executionId: string;
	stepId: string;
	stepDescription: string;
	stepType: string;
	userId: string;
	organizationId?: string;
	riskScore?: number;
	riskLevel?: string;
	riskFactors?: string[];
	weaveExecutionId?: string;
	weavePlanId?: string;
	weaveContext?: Record<string, unknown>;
	/**
	 * Items that will be affected by this destructive operation.
	 * Used to show per-item approval for bulk operations like delete/create.
	 */
	affectedItems?: AffectedItem[];
}

export interface UpdateExecutionProgressInput {
	executionId: string;
	phase: string;
	message: string;
	currentStep?: TaskStep;
	completedSteps: number;
	totalSteps: number;
}

// =============================================================================
// Internal Types
// =============================================================================

export interface ToolCallPattern {
	toolName: string;
	successfulArgs: Record<string, unknown>[];
	errorPatterns: Array<{
		badArgs: Record<string, unknown>;
		errorMessage: string;
		correctedArgs?: Record<string, unknown>;
		learnedAt: string;
	}>;
	lastSuccessfulCall?: {
		args: Record<string, unknown>;
		timestamp: string;
	};
}

// =============================================================================
// Agent Resolution Types
// =============================================================================

export interface ResolvedAgent {
	agentId: string;
	name: string;
	deploymentUrl: string;
	/** All agents MUST support A2A protocol for orchestrator communication */
	protocol: "a2a";
	skills: Array<{ id: string; name: string; description: string }>;
	supportsStreaming: boolean;
	isExternal: boolean;
}

// =============================================================================
// Agent Capability Types
// =============================================================================

/**
 * Agent capability category for filtering and matching.
 */
export type AgentCategory =
	| "document_generation"
	| "task_planning"
	| "code_execution"
	| "browser_automation"
	| "api_integration"
	| "research"
	| "general";

/**
 * Capabilities extracted from agent card.
 * Used to determine if an agent is a generalist that can handle complete tasks.
 */
export interface AgentCardCapabilities {
	// Core autonomy capabilities
	autonomousExecution?: boolean;
	taskDecomposition?: boolean;
	contextPreservation?: boolean;
	maxAutonomyLevel?: "step" | "subtask" | "task" | "session";

	// Execution capabilities
	codeExecution?: boolean;
	browserAutomation?: boolean;
	apiOrchestration?: boolean;
	fileOperations?: boolean;

	// Memory and learning
	memoryEnabled?: boolean;
	learningEnabled?: boolean;

	// Planning capabilities
	multiStepPlanning?: boolean;

	// Streaming support
	streaming?: boolean;

	// Push notifications
	pushNotifications?: boolean;

	// State transition history tracking
	stateTransitionHistory?: boolean;

	// MCP tool access - list of MCP tools this agent can directly use
	// If undefined or empty, agent cannot use MCP tools and orchestrator must handle them
	mcpToolAccess?: string[];

	// Indicates if agent can use any/all MCP tools (vs specific ones)
	hasMcpAccess?: boolean;

	// Security and isolation
	multiTenancyAware?: boolean;
	sandboxed?: boolean;

	// Agent skills (from agent card)
	skills?: Array<{
		id: string;
		name: string;
		description?: string;
		tags?: string[];
	}>;

	// Agent tags for capability matching
	tags?: string[];

	// ==========================================================================
	// NEW: Dynamic Discovery Fields
	// ==========================================================================

	/**
	 * What this agent CANNOT do.
	 * Used for suitability filtering during step assignment.
	 *
	 * Examples:
	 * - "Cannot access MCP tools"
	 * - "Cannot access Fabric workspaces"
	 * - "Cannot delegate to other agents"
	 * - "Cannot trigger workflows"
	 */
	limitations?: string[];

	/**
	 * Categories this agent belongs to.
	 * Used for faster filtering during capability discovery.
	 */
	categories?: AgentCategory[];

	/**
	 * Pre-computed embedding for semantic matching.
	 * Generated from name + description + skills.
	 */
	descriptionEmbedding?: number[];

	/**
	 * When the embedding was last computed.
	 */
	embeddingComputedAt?: Date;

	/**
	 * Whether this agent has Fabric workspace access.
	 * If false, agent cannot read/write workspace documents.
	 */
	hasWorkspaceAccess?: boolean;

	/**
	 * Whether this agent can delegate tasks to other agents.
	 */
	canDelegateToAgents?: boolean;

	/**
	 * Whether this agent has access to Fabric resources (RAG, embeddings, etc).
	 */
	hasFabricResourceAccess?: boolean;
}

// =============================================================================
// Delegation Types
// =============================================================================

export interface DelegateToAgentInput {
	agentId: string;
	message: string;
	context?: Record<string, unknown>;
	userId: string;
	organizationId?: string;
	/** Project scope for per-project AI usage attribution */
	projectId?: string;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Whether to stream results */
	stream?: boolean;

	// Generalist Agent Delegation Context
	delegationMode?: "complete-task" | "single-step";
	preserveContext?: boolean;
	inheritedVariables?: Record<string, unknown>;
	originalTaskDescription?: string;
	expectedArtifacts?: Array<
		"code" | "browser-state" | "subtasks" | "variables" | "file"
	>;

	/** Workspace inherited from orchestrator */
	inheritedWorkspace?: {
		files?: Array<{
			id: string;
			path: string;
			name: string;
			content: string;
			fileType: string;
		}>;
		codeExecutions?: Array<{
			id: string;
			code: string;
			language: string;
			output?: string;
			error?: string;
		}>;
		browserStates?: Array<{
			id: string;
			url: string;
			title?: string;
			screenshot?: string;
		}>;
		completedSubtasks?: Array<{
			id: string;
			description: string;
			result: string;
		}>;
	};

	/** Conversation history for context in follow-up questions */
	conversationHistory?: Array<{
		role: "user" | "assistant" | "system";
		content: string;
	}>;

	/** Execution ID for PartyKit real-time updates */
	executionId?: string;
	/** Step ID for PartyKit real-time updates */
	stepId?: string;
}

export interface DelegateToAgentOutput {
	response: string;
	artifacts: Array<{
		id: string;
		name: string;
		mimeType: string;
		content: unknown;
	}>;
	status: "completed" | "failed" | "input-required";
	taskId?: string;
	durationMs: number;
}

// Re-export workflow types for convenience
export type {
	AgentVariable,
	ALTKConfig,
	ExecutionMode,
	OrchestratorWorkspace,
	PolicyContext,
	RoutingDecision,
	TaskPlan,
	TaskStep,
	Trajectory,
	TrajectoryStep,
} from "../../workflows/orchestrator/types";

// =============================================================================
// Context Analysis Types
// =============================================================================

/**
 * Information need identified during context analysis.
 */
export interface InformationNeed {
	type:
		| "market_data"
		| "competitors"
		| "best_practices"
		| "technical_docs"
		| "user_data"
		| "domain_knowledge";
	description: string;
	sources: ("web" | "workspace" | "mcp_tool" | "agent")[];
	priority: "required" | "helpful" | "optional";
}

/**
 * Result of analyzing what context/research is needed for a task.
 */
export interface ContextRequirements {
	/** Whether pre-planning research is needed */
	requiresResearch: boolean;
	/** Specific search queries to execute */
	researchQueries: string[];
	/** Categorized information needs */
	informationNeeds: InformationNeed[];
	/** Tools that can help gather this context */
	suggestedTools: string[];
	/** Agents that can help gather this context */
	suggestedAgents: string[];
	/** Estimated number of research steps */
	estimatedResearchSteps: number;
}

/**
 * A single finding from research.
 */
export interface ResearchFinding {
	source: string;
	content: string;
	relevance: number;
	type: "web" | "workspace" | "tool" | "agent";
}

/**
 * Result of a single research query.
 */
export interface ResearchResult {
	query: string;
	findings: ResearchFinding[];
	synthesizedContext: string;
	keyFacts: string[];
	confidence: number;
}

/**
 * Artifact produced during execution.
 */
export interface ExecutionArtifact {
	id: string;
	name: string;
	content: unknown;
	stepId: string;
	type?: "draft" | "review" | "output";
}

/**
 * Synthesized context from research, ready for agent consumption.
 */
export interface SynthesizedContext {
	summary: string;
	keyFacts: string[];
	requirements: string[];
	constraints: string[];
	recommendations: string[];
	openQuestions: string[];
}

/**
 * ContextBag accumulates context throughout execution.
 * This replaces the flat variables approach with a structured context flow.
 */
export interface ContextBag {
	/** Raw research data */
	research: {
		webSearchResults: ResearchResult[];
		workspaceExtracts: Array<{
			query: string;
			content: string;
			source: string;
		}>;
		agentResponses: Array<{
			agentId: string;
			query: string;
			response: string;
		}>;
		toolOutputs: Array<{
			toolName: string;
			args: unknown;
			output: unknown;
		}>;
	};
	/** Synthesized context (ready for agent consumption) */
	synthesized: SynthesizedContext;
	/** Execution artifacts */
	artifacts: {
		drafts: ExecutionArtifact[];
		reviews: ExecutionArtifact[];
		outputs: ExecutionArtifact[];
	};
	/** Cross-step variables (existing pattern) */
	variables: Record<string, AgentVariable>;
}

// =============================================================================
// Context Activity Input/Output Types
// =============================================================================

export interface AnalyzeContextRequirementsInput {
	message: string;
	userId: string;
	organizationId?: string;
	availableAgents: Array<{ id: string; name: string; description: string }>;
	availableMcpTools: string[];
	workspaceIds?: string[];
}

export interface ExecuteResearchAgentInput {
	researchQueries: string[];
	informationNeeds: InformationNeed[];
	originalTask: string;
	userId: string;
	organizationId?: string;
	workspaceIds?: string[];
	availableTools: string[];
	availableAgents: string[];
	maxSteps?: number;
	/** Enabled MCP config IDs for tool access */
	enabledMcpConfigIds?: string[] | null;
}

export interface SynthesizeContextInput {
	researchResults: ResearchResult[];
	originalTask: string;
	previousStepResults: Array<{
		stepId: string;
		stepDescription: string;
		response?: string;
	}>;
	userId: string;
	organizationId?: string;
}

// =============================================================================
// Enhanced Planning Types
// =============================================================================

/**
 * Execution strategy determines the overall flow pattern.
 */
export type ExecutionStrategy =
	| "research-then-generate" // Research → Synthesize → Generate (for PRDs, reports)
	| "iterative-refinement" // Draft → Review → Refine loop (quality-critical)
	| "parallel-gather" // Multiple parallel research → Merge
	| "hierarchical-delegation" // Delegate to sub-orchestrator
	| "direct-execution"; // Single step, no research needed

/**
 * A phase in the enhanced task plan.
 */
export interface TaskPhase {
	id: string;
	name: string;
	description?: string;
	type?: "research" | "synthesis" | "generation" | "review" | "execution";
	order?: number;
	steps: TaskStep[];
	/** Context keys this phase requires from previous phases */
	requiredContext?: string[];
	/** Context keys this phase produces for later phases */
	producesContext?: string[];
	/** Whether steps in this phase can run in parallel */
	parallelizable?: boolean;
	/** Status of the phase */
	status?: "pending" | "in_progress" | "completed" | "failed";
}

/**
 * Risk assessment for a plan.
 */
export interface PlanRiskAssessment {
	level?: "low" | "medium" | "high" | "critical";
	factors?: string[];
	/** Overall risk level (alias for level) */
	overallRisk?: "low" | "medium" | "high" | "critical";
	/** Risk factors (alias for factors) */
	riskFactors?: string[];
	/** Whether approval is required */
	requiresApproval?: boolean;
	/** Count of critical risk steps */
	criticalStepCount?: number;
	/** Count of high risk steps */
	highRiskStepCount?: number;
}

/**
 * Enhanced task plan with strategy and phases.
 */
export interface EnhancedTaskPlan {
	id: string;
	/** Execution strategy */
	strategy: ExecutionStrategy;
	/** Phases of execution */
	phases: TaskPhase[];
	/** Context flow configuration */
	contextFlow: Record<string, string[]>;
	/** Groups of step IDs that can run in parallel */
	parallelizableGroups: string[][];
	/** Total estimated steps */
	estimatedSteps: number;
	/** Risk assessment */
	riskAssessment: PlanRiskAssessment;
}

export interface CreateEnhancedTaskPlanInput extends CreateTaskPlanInput {
	contextRequirements: ContextRequirements;
	synthesizedContext?: SynthesizedContext;
	availableAgents: Array<{
		id: string;
		name: string;
		description: string;
		skills?: string[];
	}>;
	availableMcpTools: string[];
}

// =============================================================================
// Capability Registry Types
// =============================================================================

/**
 * A capability represents something the orchestrator can use (agent, tool, workflow).
 */
export interface Capability {
	id: string;
	type: "agent" | "mcp_tool" | "workflow" | "integration";
	name: string;
	description: string;
	/** What this capability can do */
	skills: string[];
	/** Input types it accepts */
	inputTypes: string[];
	/** Output types it produces */
	outputTypes: string[];
	/** Risk level */
	riskLevel: "low" | "medium" | "high" | "critical";
	/** Whether approval is needed */
	requiresApproval: boolean;
	/** Runtime availability */
	isAvailable: boolean;
	/** Health status */
	healthStatus: "healthy" | "degraded" | "unhealthy";
	/** For tools: parameter schema */
	parameters?: Record<string, unknown>;
	/** For agents: detailed capabilities */
	agentCapabilities?: AgentCardCapabilities;
}

/**
 * Result of matching capabilities to a task.
 */
export interface CapabilityMatch {
	capability: Capability;
	score: number;
	matchedNeeds: string[];
	suggestedUse: string;
}

export interface DiscoverCapabilitiesInput {
	userId: string;
	organizationId?: string;
	enabledMcpConfigIds?: string[] | null;
	enabledAgentIds?: string[] | null;
}

// Re-export heartbeat types from root types
export type { OrchestratorHeartbeatDetails } from "../../types";
