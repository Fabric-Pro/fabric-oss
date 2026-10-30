/**
 * The Orchestrator chat's client-side shapes: its messages, its turn state,
 * and the tool-call helpers both transports (the stream route's and the agent
 * runtime's) feed into the same state.
 */
import type {
	ExecutionMode,
	MissingIntegration,
	OrchestratorWorkflowOutput,
	RequiredConnection,
	TaskPlan,
} from "@repo/temporal";
import type { StreamModelInfo, StreamStatus } from "../hooks/useDirectStream";
import type { ChatTurnTruncation } from "./chat-turn-truncation";
import type { ChatGptPlanApiBilling } from "./chatgpt-plan-api-billing";
import type { TurnBudgetStop } from "./turn-budget-stop";

/** A multi-agent message, as the runtime stream hands it over (see `multiAgentSend`). */
export interface MultiAgentSendRun {
	threadId: string;
	content: string;
	history: Array<{ role: "user" | "assistant"; content: string }>;
	/** The run's options a single turn would send (agent fields resolved on the server). */
	forwardedProps: Record<string, unknown>;
	/** The question's thumbnails. */
	displayImageUrls?: string[];
	/**
	 * The turn was refused before it started: the chat puts the question
	 * back, as for a refused single turn (`onTurnRefused`), and may say more.
	 */
	onRefused: () => string | undefined;
}

export interface UseOrchestratorStreamOptions {
	organizationId?: string;
	executionMode?: ExecutionMode;
	enabledMcpConfigIds?: string[] | null;
	enabledAgentIds?: string[] | null;
	enabledFabricToolIds?: string[] | null;
	/** Enabled workflow integration IDs */
	enabledIntegrationIds?: string[] | null;
	/** Prioritized tool IDs - get boosted confidence in routing */
	prioritizedToolIds?: string[];
	/** Prioritized agent IDs - get boosted confidence in routing */
	prioritizedAgentIds?: string[];
	/** Prioritized MCP server config IDs - tools from these get boosted */
	prioritizedMcpConfigIds?: string[];
	/** Prioritized workflow integration IDs */
	prioritizedIntegrationIds?: string[];
	/** Workspace IDs for workspace document RAG retrieval */
	workspaceIds?: string[];
	/** Optional document IDs to scope workspace retrieval to */
	attachedDocumentIds?: string[];
	/** Project ID for project context retrieval */
	projectId?: string | null;
	/** Conversation ID - backend will fetch attached workspaces if workspaceIds not provided */
	conversationId?: string | null;
	/** System prompt / instructions (for agent template instances) */
	systemPrompt?: string;
	/** Agent template instance ID (for tracking) */
	instanceId?: string;
	/**
	 * Model the orchestrator itself reasons and synthesises with (#2040).
	 *
	 * Scoped to the orchestrator's own calls. The specialists it delegates to
	 * resolve their model independently, per agent, in the
	 * `delegate-to-agent` activity — so picking a model here cannot multiply
	 * the per-message cost across a delegation fan-out.
	 *
	 * Sent on the initial POST only. A reconnect re-attaches to the running
	 * workflow by `executionId`, which still holds its original input, so
	 * resending it would be redundant rather than protective.
	 */
	modelOverride?: string;
	/**
	 * Set only by the Advisor (the Fabric AI page and the Fabric Agent
	 * drawer), never by the MCP chat dialog or a registered agent's try
	 * workspace, which mount the same chat. The route lets only an Advisor
	 * chat draw on the organization's company context; membership is still
	 * checked on the server (Fizzy #2719). Sent on the initial POST only: a
	 * reconnect starts nothing.
	 */
	advisorOrigin?: boolean;
	/**
	 * Where the chat was opened, for the tools that place what they create: a
	 * Workspace's id, and whether the page is an artifact or a workspace
	 * surface. A default, never a grant. Sent on the initial POST only: a
	 * reconnect starts nothing.
	 */
	launchWorkspaceId?: string | null;
	launchFrameId?: string | null;
	launchSurface?: "artifact" | "workspace" | null;
	/**
	 * Surface that mounts this hook — used for the
	 * `ai_generation_cancelled` telemetry event. The orchestrator hook
	 * is mounted by the standalone Loom Orchestrator page; surfaces
	 * routing through here from another context can override.
	 */
	surface?: "loom-orchestrator";
	/**
	 * Surface reported on the `ai_generation_cancelled` telemetry event,
	 * when it differs from the workflow `surface`. The drawer runs the
	 * Loom orchestrator workflow surface (so its clarifying-question card
	 * works) but keeps its own analytics tag (#2040).
	 */
	telemetrySurface?: "loom-orchestrator" | "fabric-agent-launcher";
	/**
	 * Invoked when the fire-and-forget cancel POST receives a non-2xx
	 * response. The consumer typically surfaces a non-blocking toast —
	 * the visual state of the message does NOT revert (/
	 * decision 11).
	 */
	onStopFailed?: () => void;
	/**
	 * Invoked with the message's text when the server refused it because a
	 * different message is already being answered in this conversation
	 * (`TURN_IN_PROGRESS`, possibly from another tab). The hook has already
	 * removed the message from `messages` and set the notice in
	 * `state.result.error`; the consumer can put the text back in its
	 * composer so the user can send it once the other answer finishes.
	 * A sentence it returns is appended to that notice (the chat says so
	 * when the message's attachments were not sent).
	 */
	onTurnRefused?: (content: string) => string | undefined;
	/**
	 * Agent runtime only: the conversation a new chat's first turn created
	 * (the runtime creates it), once the run has started. The stream route's
	 * chat creates its conversation itself.
	 */
	onConversationStarted?: (conversationId: string) => void;
	/**
	 * Agent runtime only: set while the chat has two or more agents picked
	 * (`useMultiAgentChat`). A new message is then that multi-agent turn's
	 * run, with the same options and attachments a single turn's run carries.
	 */
	multiAgentSend?: (run: MultiAgentSendRun) => Promise<void>;
	/**
	 * Agent runtime only: the settings a conversation the runtime creates is
	 * created with (the stream route's chat saves them with its first turn).
	 */
	conversationSettings?: {
		executionMode?: "lite" | "balanced" | "deep" | "planner";
		instanceId?: string;
		selectedMcpConfigIds?: string[];
		documentChatId?: string;
	};
}

/**
 * Shown in place of a message the server refused with `TURN_IN_PROGRESS`.
 */
export const TURN_IN_PROGRESS_NOTICE =
	"Your message was not sent: another message in this conversation is already being answered, possibly in another tab. Send yours when that answer finishes.";

export interface SendMessageOverrides {
	/** Server turn to continue; only sent on the initial request for this message. */
	continueFromTurnId?: string;
	/**
	 * The conversation this send belongs to, when it was created for this
	 * send and the hook's `conversationId` option has not caught up.
	 */
	conversationId?: string;
	/**
	 * A turn already running (opened after a reload mid-turn): show its
	 * question and stream it by this id instead of starting a new one. Every
	 * request is then a reconnect, the first included.
	 */
	attachExecutionId?: string;
	/**
	 * Agent runtime only: the chat this send's documents are stored under,
	 * for the conversation the run creates (a first upload creates it before
	 * the `conversationSettings` option catches up).
	 */
	documentChatId?: string;
}

export interface OrchestratorStreamMessage {
	metadata?: Record<string, unknown>;
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: Date;
	/** Storage paths (not signed URLs) — rendered via /api/storage/image proxy */
	imageUrls?: string[];
	toolCalls?: Array<{
		id: string;
		name: string;
		args: unknown;
		result?: unknown;
		status: "pending" | "running" | "complete" | "error";
	}>;
	isStreaming?: boolean;
	isError?: boolean;
	/**
	 * Stream lifecycle status — see `useDirectStream.StreamStatus`. Stored
	 * alongside the message body in the existing JSON blob so reload
	 * rendering can surface the inline `Stopped` caption.
	 */
	streamStatus?: StreamStatus;
	/** ISO timestamp stamped when the user halted this assistant turn. */
	cancelledAt?: string;
}

interface PlanningAuditSummary {
	headline: string;
	keyFactors: string[];
	sourcesUsed: string[];
	usedMemory: boolean;
	usedResearch: boolean;
	totalSourcesConsulted: number;
	totalDecisions: number;
	planningDurationMs?: number;
}

interface WorkflowArtifact {
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
}

export interface LimitSignalSummary {
	kind:
		| "internal_budget"
		| "provider_quota"
		| "provider_rate_limit"
		| "context_length"
		| "provider_overloaded"
		| "subscription_exhausted"
		| "subscription_reconnect";
	provider?: string;
	message: string;
	retryAfterMs?: number;
	budget?: {
		used: number;
		total: number;
		usagePercentage: number;
		warning?: string;
		estimatedCost?: number;
	};
	budgetLimit?: "tokens" | "iterations" | "time";
}

export interface OrchestratorStreamState {
	executionId: string | null;
	turnId?: string;
	turnGeneration?: number | null;
	status:
		| "idle"
		| "running"
		| "awaiting_approval"
		| "awaiting_auth"
		| "completed"
		| "failed"
		| "cancelled";
	plan: TaskPlan | null;
	variables: Record<string, unknown>;
	result: {
		response?: string;
		status?: string;
		/**
		 * The final answer stopped at the output-token ceiling — the chat
		 * says so and offers to continue (review F25).
		 */
		truncated?: ChatTurnTruncation;
		routingDecision?: {
			primaryAgent: string;
			agentName: string;
			confidence: number;
			riskLevel?: string;
			requiredConnections?: RequiredConnection[];
			missingIntegrations?: MissingIntegration[];
			blockedOnConnections?: boolean;
		};
		error?: string;
		/** OAuth authorization is required for an MCP server */
		blockedOnAuth?: {
			configId: string;
			serverName: string;
			stepId?: string;
		};
	} | null;
	approvalHistory?: OrchestratorWorkflowOutput["approvalHistory"];
	pendingApproval: {
		approvalId?: string;
		stepId: string;
		reason: string;
	} | null;
	pendingClarification: {
		clarificationId: string;
		stepId?: string;
		question: string;
		options?: string[];
	} | null;
	/**
	 * Clarifying questions the user answered during THIS execution, oldest
	 * first. Persisted with the execution so the exchange survives a reload and
	 * travels in the next turn's `history` — without that the clarity gate is
	 * blind to its own prior question and re-asks it (Fizzy #2406). Dismissed
	 * questions are not recorded: there is no answer to carry forward.
	 */
	answeredClarifications: Array<{ question: string; answer: string }>;
	planningAudit: PlanningAuditSummary | null;
	artifacts: WorkflowArtifact[];
	/**
	 * Live list of provider / internal token-budget exhaustion
	 * signals surfaced during the run. Updated in real time via
	 * `execution.limit_signal` SSE events.
	 */
	limitSignals: LimitSignalSummary[];
	/**
	 * Final token-budget snapshot, populated when the `workflow_complete`
	 * event arrives with `output.tokenBudget` set (iterative runs only).
	 */
	tokenBudget?: {
		used: number;
		total: number;
		usagePercentage: number;
		warning?: string;
		estimatedCost?: number;
	};
	/**
	 * Set when the orchestrator hit its hard token-budget cap and produced
	 * an exhaustion synthesis. The frontend renders a "Continue in a new
	 * chat" CTA above the input box; clicking it calls
	 * `agents.conversations.continueInNewChat` with `summary` to spawn a
	 * fresh conversation pre-seeded with this context.
	 */
	handoffRecommended?: {
		reason: string;
		summary: string;
	};
	/**
	 * The turn's structured token-allowance stop, as its row stores it, when
	 * it has one. A completed turn that stopped on its allowance shows it: the
	 * chat says so and offers no new-chat workaround, the user can ask to
	 * continue in this chat. A cancelled turn keeps the payload it stored but
	 * uses terminal status to decide its card (`budgetStopToShow`).
	 */
	budgetStop?: TurnBudgetStop;
	/** The model that served this answer. */
	model?: StreamModelInfo;
	/**
	 * The turn runs on the organization's API billing because every ChatGPT
	 * plan is spent (Fizzy #3048); the chat says so under the answer.
	 */
	apiBilling?: ChatGptPlanApiBilling;
	/**
	 * Mid-execution conversation compaction events. Each entry corresponds to
	 * one `execution.context_compacted` SSE event — older history was folded
	 * into a single summary block to keep the run under the token cap. The UI
	 * surfaces this as an unobtrusive notice so users aren't surprised when
	 * the model "forgets" specifics from earlier in the chat.
	 */
	contextCompactions: ContextCompactionEvent[];
}

/** The state of a chat with no turn: on mount and after `reset`. */
export function idleOrchestratorStreamState(): OrchestratorStreamState {
	return {
		executionId: null,
		status: "idle",
		plan: null,
		variables: {},
		result: null,
		approvalHistory: undefined,
		pendingApproval: null,
		pendingClarification: null,
		answeredClarifications: [],
		planningAudit: null,
		artifacts: [],
		limitSignals: [],
		contextCompactions: [],
	};
}

export interface ContextCompactionEvent {
	iteration: number;
	compactedTurns: number;
	summaryChars: number;
	historyLengthBefore: number;
	timestamp: string;
}

export interface ToolCallState {
	id: string;
	name: string;
	args: unknown;
	result?: unknown;
	status: "pending" | "running" | "complete" | "error";
	durationMs?: number;
	/** MCP App: ui:// resource URI for interactive HTML UI */
	mcpAppResourceUri?: string;
	/** MCP App: MCP config ID for proxying iframe tool calls */
	mcpAppConfigId?: string;
}

// Step result with response for sequential rendering
// Matches OrchestratorStepResult from @repo/temporal
export interface StreamingStepResult {
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
}

/**
 * The orchestrator's `buildWorkflowOutput` truncates oversized non-MCP-App
 * tool call args/results to a sentinel string before returning the
 * workflow output. The same sentinel can leak through several SSE event
 * paths in this hook (`step_complete`, `completed`, partykit progress)
 * and clobber the live-streamed args. If a sentinel reaches McpAppFrame's
 * `toolArgs`/`toolResult`, the Excalidraw widget renders an empty canvas
 * even though the diagram data was fully streamed earlier. `completion.ts`'s
 * budget-aware cap is the primary fix; rejecting the sentinel everywhere
 * we read tool call args/result from incoming SSE/PartyKit events is the
 * defense-in-depth that survives stale persisted chats and edge cases
 * where the route falls back to the truncated workflow output.
 */
function isTruncatedSentinel(value: unknown): boolean {
	return typeof value === "string" && value.startsWith("[Object truncated,");
}

/**
 * Returns the incoming value if it isn't the truncation sentinel, else
 * `undefined`. Use this anywhere we copy `tc.args` / `tc.result` from a
 * raw SSE/PartyKit payload into our state — the sentinel is never
 * useful render data, and storing `undefined` lets McpAppFrame fall back
 * to whatever was previously set without sending garbage to its bridge.
 */
export function safeToolField<T>(value: T): T | undefined {
	return isTruncatedSentinel(value) ? undefined : value;
}

export function mergeStreamingToolCall(
	existingToolCalls: ToolCallState[],
	incoming: ToolCallState,
): ToolCallState[] {
	const existingIndex = existingToolCalls.findIndex(
		(tc) => tc.id === incoming.id || tc.name === incoming.name,
	);

	if (existingIndex < 0) {
		return [...existingToolCalls, incoming];
	}

	return existingToolCalls.map((tc, index) =>
		index === existingIndex
			? {
					...tc,
					...incoming,
					args: isTruncatedSentinel(incoming.args)
						? tc.args
						: (incoming.args ?? tc.args),
					result: isTruncatedSentinel(incoming.result)
						? tc.result
						: (incoming.result ?? tc.result),
					status:
						tc.status === "complete" || tc.status === "error"
							? tc.status
							: incoming.status,
					mcpAppResourceUri:
						incoming.mcpAppResourceUri ?? tc.mcpAppResourceUri,
					mcpAppConfigId:
						incoming.mcpAppConfigId ?? tc.mcpAppConfigId,
				}
			: tc,
	);
}

/**
 * A per-message idempotency key for the server-owned turn: the stream route
 * returns the turn this key already created instead of starting another, and
 * Stop can cancel by it before the browser has the executionId.
 */
export function newClientRequestKey(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	return `key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Sleep that gives up as soon as the turn is aborted. Resolves `true` when
 * the wait was cut short by the signal — the caller must not reconnect in
 * that case, because the user pressed Stop during the gap.
 */
export function waitBeforeResume(
	ms: number,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		if (signal?.aborted) {
			resolve(true);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(false);
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve(true);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
