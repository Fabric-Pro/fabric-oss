/**
 * Workflow I/O Types
 *
 * Defines input and output types for the orchestrator workflow.
 * Includes workflow input, output, progress updates, and signals.
 */

import type { LimitSignal, TokenBudgetStatus } from "@repo/ai/limits";
import type { ALTKConfig } from "./altk.types";
import type { ExecutionMode } from "./execution-mode.types";
import type { PolicyContext } from "./policy.types";
import type { RoutingDecision } from "./routing.types";
import type { TaskPlan, TaskStep } from "./task.types";
import type { Trajectory } from "./trajectory.types";
import type { AgentVariable } from "./variable.types";
import type { OrchestratorWorkspace } from "./workspace.types";

// =============================================================================
// Workflow Input
// =============================================================================

/**
 * The chat turn a run belongs to, as activities receive it: the durable
 * turn row's id plus the execution, user and organization the run carries.
 * The dispatch check compares all four with the row before every provider
 * request (activities/orchestrator/turn-dispatch.ts).
 */
export interface OrchestratorTurnScope {
	turnId: string;
	executionId: string;
	userId: string;
	organizationId: string;
	/**
	 * The turn's generation (its number in the conversation), or null for a
	 * turn with no conversation. Sent only under the `orch-turn-budget-v1`
	 * marker; absent on an older run and then not compared. When present the
	 * dispatch check and every ledger reservation require it to match the
	 * turn row.
	 */
	generation?: number | null;
	/**
	 * The budget contract this run's workflow speaks
	 * (`ORCHESTRATOR_TURN_BUDGET_CONTRACT_VERSION`), sent only under the
	 * `orch-turn-budget-v1` marker. Requests reserve against the turn's token
	 * ledger only when this AND the turn row's `budgetContractVersion` both
	 * say 1; otherwise the turn runs unledgered (see turn-contract.ts).
	 */
	budgetContractVersion?: number;
}

/** The budget contract a workflow speaks; see `budgetContractVersion`. */
export const ORCHESTRATOR_TURN_BUDGET_CONTRACT_VERSION = 1;

/**
 * How a ledgered turn's request counts against its allowance. Set only by the
 * workflow, on the activity input (`budgetAttemptKind`): FINALIZATION for the
 * synthesis that writes the turn's answer after a stop, EXPLORATION for a
 * main round. Everything else under the turn is AUXILIARY.
 */
export type OrchestratorBudgetAttemptKind = "EXPLORATION" | "FINALIZATION";

/**
 * The structured record of a turn that stopped on its token allowance. The
 * live stream's `completed` event, the turn row (`budgetStop`) and a
 * reconnect all carry this same payload. Counts are tokens; `outstanding` is
 * reservations not yet settled plus attempts whose usage is unknown, kept as
 * a conservative charge — never measured usage.
 */
export interface TurnBudgetStop {
	kind: "token_allowance";
	allowance: number;
	measured: number;
	outstanding: number;
	enforcement: "ENFORCED" | "MEASURED_ONLY" | null;
	/**
	 * `allowance_exhausted`: a request did not fit and the reserved
	 * finalization wrote the answer. `finalization_unavailable`: the
	 * finalization request could not be made or failed too, so the answer is
	 * the static summary of the work done.
	 */
	stopReason: "allowance_exhausted" | "finalization_unavailable";
}

/** A ledger reading an activity returns after its requests settled. */
export interface TurnLedgerSnapshot {
	allowance: number;
	finalizationReserve: number;
	measured: number;
	outstanding: number;
	enforcement: "ENFORCED" | "MEASURED_ONLY" | null;
}

/** The turn contract a chat starter speaks; see `turnContractVersion`. */
export const ORCHESTRATOR_TURN_CONTRACT_VERSION = 1;

export interface OrchestratorWorkflowInput {
	/** Unique execution ID */
	executionId: string;
	/**
	 * The durable `ConversationTurn` row this run serves, set by every chat
	 * starter (the Advisor stream route and its non-stream sibling). When
	 * present — and the run recorded the `orch-turn-cancellation-v1` marker —
	 * every provider request is preceded by the turn's dispatch check, and
	 * the run writes the turn's terminal state before it ends. Absent on a
	 * legacy run (started before turns existed) and on non-chat starters
	 * (story automations, Weave, project setup), which keep the old
	 * behaviour.
	 */
	turnId?: string;
	/** `ORCHESTRATOR_TURN_CONTRACT_VERSION` of the starter that set `turnId`. */
	turnContractVersion?: number;
	/**
	 * The turn row's generation (null for a turn with no conversation), set
	 * by the starter with `turnId`. The workflow carries it in its turn scope
	 * under the `orch-turn-budget-v1` marker.
	 */
	turnGeneration?: number | null;
	/** User's message/task */
	message: string;
	/** Conversation history */
	history: Array<{ role: "user" | "assistant"; content: string }>;
	/** User ID */
	userId: string;
	/**
	 * Set by starters a person drives — the chat routes they type into (the
	 * Advisor and the Fabric Agent drawer, in orchestrator mode), a story
	 * automation their move fired, a Weave execution they started (Fizzy
	 * #2770): every AI step of the run may then run on that person's own
	 * ChatGPT plan (Fizzy #2939). Delegations and system starts leave it unset
	 * and stay on the organization's provider.
	 */
	planEligible?: boolean;
	/** Organization ID */
	organizationId?: string;
	// SECURITY: API keys are NOT passed in workflow inputs
	// Workflow arguments are stored in Temporal's database and visible in Web UI
	// Activities fetch credentials internally using getAIModelWithMetadata() or similar
	/** Execution mode */
	executionMode: ExecutionMode;
	/** Enabled MCP config IDs (null = all) */
	enabledMcpConfigIds?: string[] | null;
	/** Enabled Agent IDs (null = all from registry) */
	enabledAgentIds?: string[] | null;
	/** Enabled Fabric AI tool IDs (null = all) */
	enabledFabricToolIds?: string[] | null;
	/** Enabled workflow integration IDs (null = all) */
	enabledIntegrationIds?: string[] | null;
	/** Prioritized tool IDs - these get boosted confidence in semantic search */
	prioritizedToolIds?: string[];
	/** Prioritized agent IDs - these get boosted confidence in agent selection */
	prioritizedAgentIds?: string[];
	/** Prioritized MCP server config IDs - tools from these servers get boosted confidence */
	prioritizedMcpConfigIds?: string[];
	/** Prioritized workflow integration IDs - these get boosted confidence */
	prioritizedIntegrationIds?: string[];
	/** Policy context */
	policyContext?: PolicyContext;
	/** ALTK configuration */
	altkConfig?: ALTKConfig;
	/** Trajectory ID to replay (for save_reuse mode) */
	replayTrajectoryId?: string;
	/** Parent execution ID (for nested agent calls) */
	parentExecutionId?: string;
	/** Variables passed from parent agent */
	inheritedVariables?: Record<string, AgentVariable>;
	/** Workspace inherited from parent (for nested delegations) */
	inheritedWorkspace?: OrchestratorWorkspace;
	/** Workspace IDs for document RAG retrieval */
	workspaceIds?: string[];
	/** Project ID for project-specific context loading */
	projectId?: string;
	/** Conversation ID for episodic memory (optional, defaults to executionId) */
	conversationId?: string;
	/** System prompt / instructions (for agent template instances) */
	systemPrompt?: string;
	/** Agent template instance ID (for tracking and display) */
	instanceId?: string;
	/** Attached image URLs for image editing/generation */
	attachedImageUrls?: string[];
	/**
	 * Chat-document IDs attached to the user's message (paperclip uploads).
	 * Image-typed documents among these are passed to vision-capable models as
	 * real image parts on the first iteration so the model sees the pixels — not
	 * only the RAG-extracted description. Distinct from `attachedImageUrls`,
	 * which are storage paths consumed by image generation/editing tools.
	 */
	attachedDocumentIds?: string[];
	/** Explicit model override - used by chatbot when user selects a specific model */
	modelOverride?: string;
	/**
	 * UI surface that initiated this workflow run.
	 *
	 * Surface-aware routing helpers (e.g. `applyDefaultMcpEagerRouting`)
	 * gate on this literal so behavior changes are scoped to the surface
	 * that opted in. Absent on legacy callers — treat as "any non-routed
	 * surface" and skip surface-specific routing.
	 */
	surface?:
		| "nexus"
		| "copilot"
		| "document-editor"
		| "agent-template"
		| "weave"
		// The standalone Loom Orchestrator chat (FabricTemporalOrchestratorChat),
		// sent by `useOrchestratorStream`. Gates the up-front clarifying-question
		// pause so it fires only on that single-execution surface — never on
		// Nexus's per-agent parallel runs.
		| "loom-orchestrator";
	/**
	 * Organization slug from the request URL — used to construct
	 * surface-specific deep links (e.g. the `/app/{slug}/mcp-servers`
	 * "connect Excalidraw" CTA emitted by the Nexus routing helper).
	 * Absent on personal-context callers.
	 */
	organizationSlug?: string;
	/**
	 * Proof from the stream route that this turn acts for `userId` in
	 * `organizationId`, which the Fabric MCP gateway requires of the agent
	 * runtime for the workflow and frame tools. Minted by the route (valid for
	 * the hour a turn's workflow may run); the worker only carries it. Without
	 * it the turn's calls to those tools are refused with a message telling the
	 * person to send their message again.
	 */
	actingGrant?: string;
	/**
	 * The page the chat was opened from — a Workspace's id and whether the page
	 * is an artifact or a workspace surface — so a page the agent writes lands
	 * where the person is and "update this page" means the one they have open.
	 * Never widens access. Distinct from `surface`, which names the UI that
	 * started the run.
	 */
	launchWorkspaceId?: string;
	/** Launch frame authorized by the request boundary; absent in old histories. */
	usageFrameId?: string;
	launchSurface?: "artifact" | "workspace";
	/**
	 * Set only by the Orchestrator stream route, for a chat started from the
	 * Advisor (the Fabric AI page or the Fabric Agent drawer, with or without
	 * a custom agent chosen there). It lets the turn tell the model which
	 * organization it works for and search that organization's company
	 * context, for its members only; membership and the feature gate are
	 * still checked on every use. The MCP chat dialog, a registered agent's
	 * try workspace and Nexus leave it unset. Absent in histories recorded
	 * before it existed, which is the same as unset.
	 */
	companyContextAdvisor?: boolean;
	/**
	 * Autonomy level for approval behavior.
	 * CONSERVATIVE: Always ask for medium+ risk
	 * BALANCED: Ask for high/critical risk only (default)
	 * AUTONOMOUS: Only critical requires approval
	 */
	autonomyLevel?: "CONSERVATIVE" | "BALANCED" | "AUTONOMOUS";
	/**
	 * Weave plan ID — when set, the orchestrator operates in weave mode:
	 * creates sandbox, converts plan to task steps, executes via wave scheduling,
	 * then destroys sandbox on completion.
	 */
	weavePlanId?: string;
	/**
	 * Database execution record ID for weave-mode runs.
	 * Used to keep WeaveExecution status/checkpoint state synchronized with the
	 * running orchestrator workflow.
	 */
	weaveExecutionId?: string;
	/**
	 * Explicit implementation provider choice for this Weave execution.
	 * Allows the user to delegate the approved plan to Background Agents or
	 * local development tooling without relying on a single project-wide mode.
	 */
	weaveImplementationProvider?: "BACKGROUND_AGENTS" | "KANBAN_LOCAL";
	/**
	 * State carried forward from a continueAsNew continuation.
	 * When present, the workflow resumes from this state instead of starting fresh.
	 * Only populated by the execution phase when issuing a continueAsNew.
	 *
	 * Issue #6: Now carries the full set of fields needed to skip re-initialization.
	 */
	resumeState?: {
		startTime: number;
		taskPlan: import("./task.types").TaskPlan | null;
		stepResults: import("../types").OrchestratorStepResult[];
		variables: Record<string, import("./variable.types").AgentVariable>;
		trajectorySteps: import("./trajectory.types").TrajectoryStep[];
		toolCalls: import("../types").OrchestratorWorkflowOutput["toolCalls"];
		approvalHistory: import("../types").ApprovalHistoryEntry[];
		planningAudit: import("../types").PlanningAudit;
		followUpMessages: import("../types").FollowUpMessage[];
		pendingModification: import("../types").PendingModification | null;
		currentProgress: import("../types").OrchestratorProgressUpdate;
		routingDecision: import("./routing.types").RoutingDecision | null;
		// Fields previously missing from continueAsNew (Issue #6)
		preloadedResources: import("../types").PreloadedResources | null;
		enrichedMessage: string;
		enrichedSystemPrompt: string;
		lettaAgentId: string | null;
		workspaceContext: string;
		journeyState: import("../types").JourneyState;
		agentCircuitBreakers: Record<
			string,
			import("../circuit-breaker").CircuitBreakerState
		>;
		degradedCapabilities: import("../types").DegradedCapabilities;
		toolSearchMetrics: import("../types").ToolSearchMetrics;
		iterativeConversationHistory: import("../types").IterativeMessage[];
		currentIteration: number;
		iterationCosts: import("../types").IterationCost[];
		loomAddedSeq: number;
	};
}

// =============================================================================
// Approval History
// =============================================================================

export interface ApprovalHistoryEntry {
	approvalId: string;
	stepId: string;
	stepDescription: string;
	riskLevel: string;
	requestedAt: string;
	decidedAt?: string;
	approved: boolean;
	feedback?: string;
}

// =============================================================================
// Planning Audit
// =============================================================================

export interface PlanningAuditSummary {
	/** One-line summary of how the plan was created */
	headline: string;
	/** Key factors that influenced the plan */
	keyFactors: string[];
	/** Sources of information used (e.g., "Workspace Documents", "Past Executions") */
	sourcesUsed: string[];
	/** Whether memory was consulted */
	usedMemory: boolean;
	/** Whether fresh research was done */
	usedResearch: boolean;
	/** Total context sources consulted */
	totalSourcesConsulted: number;
	/** Total decisions made */
	totalDecisions: number;
	/** Planning duration in ms */
	planningDurationMs?: number;
}

// =============================================================================
// Step Result
// =============================================================================

export interface OrchestratorStepResult {
	stepId: string;
	stepDescription: string;
	status: "complete" | "error" | "skipped";
	response?: string;
	toolCalls: Array<{
		id: string;
		name: string;
		args: unknown;
		result: unknown;
		status: "success" | "error";
		durationMs: number;
		/** MCP App: ui:// resource URI for interactive HTML UI */
		mcpAppResourceUri?: string;
		/** MCP App: MCP config ID for proxying iframe tool calls */
		mcpAppConfigId?: string;
	}>;
	durationMs: number;
	error?: string;
	/** Artifacts produced by this step */
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
}

// =============================================================================
// Workflow Output
// =============================================================================

export interface OrchestratorWorkflowOutput {
	executionId: string;
	status:
		| "completed"
		| "failed"
		| "cancelled"
		| "awaiting_approval"
		| "awaiting_auth";
	/** Final response text */
	response?: string;
	/** Task plan that was executed */
	taskPlan?: TaskPlan;
	/** Routing decision */
	routingDecision?: RoutingDecision;
	/** All tool calls made */
	toolCalls: Array<{
		id: string;
		name: string;
		args: unknown;
		result: unknown;
		status: "success" | "error";
		durationMs: number;
		/** MCP App: ui:// resource URI for interactive HTML UI */
		mcpAppResourceUri?: string;
		/** MCP App: MCP config ID for proxying iframe tool calls */
		mcpAppConfigId?: string;
	}>;
	/** Variables at end of execution */
	variables: Record<string, AgentVariable>;
	/** Trajectory for save & reuse */
	trajectory?: Trajectory;
	/** Error if failed */
	error?: string;
	/** Total duration */
	totalDurationMs: number;
	/** Pending approval if awaiting */
	pendingApproval?: {
		approvalId: string;
		stepId: string;
		reason: string;
	};
	/** Approval history - all approval requests and decisions made during execution */
	approvalHistory?: ApprovalHistoryEntry[];
	/** Final workspace state (files, code executions, browser states) */
	workspace?: OrchestratorWorkspace;
	/** Planning audit trail - tracks what influenced planning decisions */
	planningAudit?: PlanningAuditSummary;
	/** Step results with per-step artifacts */
	stepResults?: OrchestratorStepResult[];
	/** All artifacts produced during execution */
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
		stepId: string;
		createdAt: string;
		metadata?: Record<string, unknown>;
	}>;
	/**
	 * OAuth authorization is required for an MCP server.
	 * When set, the workflow is paused waiting for user to authorize.
	 * UI should show the connection dialog for the specified server.
	 */
	blockedOnAuth?: {
		/** MCP config ID that needs authorization */
		configId: string;
		/** Server name for display */
		serverName: string;
		/** Step ID that was blocked */
		stepId?: string;
	};
	/**
	 * Limit/budget exhaustion signals accumulated during the run.
	 * Each entry represents a detected provider-limit or internal-budget event
	 * that the UI should surface to the user (banner/toast). Populated by the
	 * classifier in `@repo/ai/limits` and by the orchestrator's internal
	 * TokenBudgetManager.
	 */
	limitSignals?: LimitSignal[];
	/**
	 * Final snapshot of the orchestrator's internal token budget at the end of
	 * the run. Feeds the `TokenBudgetCard` in the execution dashboard.
	 */
	tokenBudget?: TokenBudgetStatus;
	/**
	 * Set when the conversation hit its hard token-budget cap and a graceful
	 * "continue in a fresh chat" handoff is recommended. The frontend renders
	 * a CTA above the input box; clicking it creates a new conversation
	 * pre-seeded with `summary` as carried-over context. Independent of the
	 * `failed` status — the workflow itself completed successfully via the
	 * exhaustion-synthesis fallback.
	 */
	handoffRecommended?: {
		reason: string;
		summary: string;
	};
	/**
	 * Set when the turn stopped because it used its token allowance (a
	 * ledgered turn only). The chat offers no new-chat workaround for it: the
	 * user can ask to continue in the same chat.
	 */
	budgetStop?: TurnBudgetStop;
	/**
	 * The final answer stopped at the output-token ceiling, so it ends
	 * mid-way. The chat says so and offers to continue (review F25).
	 */
	truncated?: "output_limit";
}

// =============================================================================
// Progress Update
// =============================================================================

export interface OrchestratorProgressUpdate {
	executionId: string;
	/** Absent in progress responses from workers predating routing metadata. */
	routingDecision?: Pick<
		RoutingDecision,
		| "primaryAgent"
		| "confidence"
		| "riskLevel"
		| "requiredConnections"
		| "missingIntegrations"
		| "blockedOnConnections"
	>;
	currentStep?: TaskStep;
	completedSteps: number;
	totalSteps: number;
	phase:
		| "routing"
		| "planning"
		| "executing"
		| "iterating"
		| "reflecting"
		| "awaiting_approval"
		| "awaiting_auth"
		| "complete"
		| "error";
	message: string;
	timestamp: string;
	/** Results from completed steps - for streaming per-step display */
	stepResults?: OrchestratorStepResult[];
	/**
	 * OAuth authorization info when phase is "awaiting_auth".
	 * UI should show the connection dialog for the specified server.
	 */
	blockedOnAuth?: {
		configId: string;
		serverName: string;
	};
}

// =============================================================================
// Signals
// =============================================================================

export interface ApprovalSignalData {
	approved: boolean;
	feedback?: string;
	decidedBy?: string;
	/**
	 * The `pendingApproval.approvalId` the person answered. Absent from a
	 * client that predates it, which answers whatever is pending.
	 */
	approvalId?: string;
}
