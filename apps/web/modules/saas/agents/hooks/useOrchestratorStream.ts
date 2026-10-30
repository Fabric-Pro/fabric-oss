"use client";

/**
 * useOrchestratorStream
 * React hook for streaming Temporal orchestrator execution via SSE.
 * Replaces the earlier polling-based orchestrator hook with real-time streaming.
 * Now enhanced with PartyKit WebSocket for instant tool execution updates.
 * SSE provides workflow-level events, PartyKit provides real-time tool calls.
 */

import type {
	ExecutionMode,
	MissingIntegration,
	OrchestratorWorkflowOutput,
	RequiredConnection,
	TaskPlan,
	TaskStep,
} from "@repo/temporal";
import {
	isAiUsageLimitExceededPayload,
	useShowAiUsageLimitToast,
} from "@saas/payments/lib/ai-usage-limit-toast";
import {
	describeAiError,
	isChatGptPlanSpentCode,
} from "@saas/shared/lib/ai-error-message";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	type ApprovalSendResult,
	approvalSendResult,
} from "../lib/approval-response";
import { emitCancelEvent } from "../lib/cancel-telemetry";
import { createChatEventReplay } from "../lib/chat-event-replay";
import { ChatStreamProtocolError } from "../lib/chat-stream-protocol";
import {
	type ChatTurnTruncation,
	parseTurnTruncation,
} from "../lib/chat-turn-truncation";
import {
	type ChatGptPlanApiBilling,
	parseChatGptPlanApiBilling,
	readChatGptPlanApiBilling,
} from "../lib/chatgpt-plan-api-billing";
import { formatClarificationTurn } from "../lib/clarification-turns";
import { readPersistedModel } from "../lib/direct-chat-history";
import { settleUnfinishedToolCalls } from "../lib/direct-chat-turns";
import {
	type OrchestratorStreamEvent,
	parseOrchestratorStreamEvent,
	toTaskPlan,
} from "../lib/orchestrator-stream-protocol";
import { executionModeUsesTurns } from "../lib/orchestrator-turn-modes";
import { readChatEventStream } from "../lib/read-chat-event-stream";
import {
	parseTurnBudgetStop,
	type TurnBudgetStop,
} from "../lib/turn-budget-stop";
import type { StreamStatus } from "./useDirectStream";
import { useOrchestratorPartyKit } from "./useOrchestratorPartyKit";

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
}

/**
 * Shown in place of a message the server refused with `TURN_IN_PROGRESS`.
 */
const TURN_IN_PROGRESS_NOTICE =
	"Your message was not sent: another message in this conversation is already being answered, possibly in another tab. Send yours when that answer finishes.";

interface SendMessageOverrides {
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

interface LimitSignalSummary {
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
	model?: import("@saas/agents/hooks/useDirectStream").StreamModelInfo;
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

export interface ContextCompactionEvent {
	iteration: number;
	compactedTurns: number;
	summaryChars: number;
	historyLengthBefore: number;
	timestamp: string;
}

interface ToolCallState {
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
interface StreamingStepResult {
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
function safeToolField<T>(value: T): T | undefined {
	return isTruncatedSentinel(value) ? undefined : value;
}

function mergeStreamingToolCall(
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

const ORCHESTRATOR_STREAM_ENDPOINT =
	"/api/agents/fabric-ai/orchestrator-temporal/stream";

/**
 * Fifteen timeout resumes allow sixteen 10-minute server windows (160 minutes),
 * covering the two-hour execution timeout plus 40 minutes of margin.
 * Unclean closes have a smaller consecutive budget, reset by delivered progress.
 */
const MAX_TIMEOUT_RESUMES = 15;
const MAX_UNCLEAN_RESUMES = 3;
const UNCLEAN_RESUME_DELAY_MS = 2000;
/** The total counter allows the timeout budget plus nine transport recoveries. */
const MAX_TOTAL_RESUMES = 24;
/**
 * Events the server re-sends on every window, so receiving one proves
 * nothing about the connection's health and must not refill the
 * unclean-close budget. `started` is a per-window handshake, not progress,
 * and `stream_timeout` is the server closing the window on purpose.
 * `start_pending` says the run has not been seen to start, so it proves
 * nothing either (and must not let a retry loop refill its own budget).
 */
const REPLAY_HANDSHAKE_EVENT_TYPES = new Set([
	"started",
	"stream_timeout",
	"start_pending",
]);

/**
 * The stream route writes at least a `: ping` every 15 s while a run is open,
 * so a window that delivers nothing for three of them is a connection that
 * died without closing. Without a limit the read waits forever: the turn
 * hangs, and whatever the run asks next (an approval) never reaches the
 * person. It is handled as any other mid-stream failure, by reconnecting, and
 * the new window sends what is pending again.
 */
const STREAM_SILENCE_LIMIT_MS = 45_000;

async function readBeforeSilence(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const silence = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reader.cancel().catch(() => undefined);
			reject(new Error("The stream went silent"));
		}, STREAM_SILENCE_LIMIT_MS);
	});
	try {
		return await Promise.race([reader.read(), silence]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Sleep that gives up as soon as the turn is aborted. Resolves `true` when
 * the wait was cut short by the signal — the caller must not reconnect in
 * that case, because the user pressed Stop during the gap.
 */
function waitBeforeResume(
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

/**
 * A per-message idempotency key for the server-owned turn: the stream route
 * returns the turn this key already created instead of starting another, and
 * Stop can cancel by it before the browser has the executionId.
 */
function newClientRequestKey(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	return `key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function useOrchestratorStream(
	options: UseOrchestratorStreamOptions = {},
) {
	const {
		organizationId,
		executionMode = "balanced",
		enabledMcpConfigIds = null,
		enabledAgentIds = null,
		enabledFabricToolIds = null,
		enabledIntegrationIds = null,
		prioritizedToolIds,
		prioritizedAgentIds,
		prioritizedMcpConfigIds,
		prioritizedIntegrationIds,
		workspaceIds,
		attachedDocumentIds,
		projectId,
		conversationId,
		systemPrompt,
		instanceId,
		modelOverride,
		advisorOrigin = false,
		launchWorkspaceId,
		launchFrameId,
		launchSurface,
		surface = "loom-orchestrator",
		telemetrySurface,
		onStopFailed,
		onTurnRefused,
	} = options;

	// Latest-value refs so `stop` does not need to memoize on these.
	const surfaceRef = useRef(surface);
	surfaceRef.current = surface;
	const telemetrySurfaceRef = useRef(telemetrySurface ?? surface);
	telemetrySurfaceRef.current = telemetrySurface ?? surface;
	const onStopFailedRef = useRef(onStopFailed);
	onStopFailedRef.current = onStopFailed;
	const onTurnRefusedRef = useRef(onTurnRefused);
	onTurnRefusedRef.current = onTurnRefused;

	// Shared destructive toast for the AI_USAGE_LIMIT_EXCEEDED error
	// code. Captured in a ref so the
	// downstream callbacks (memoised below) don't have to recreate when
	// the translator identity changes.
	const showAiUsageLimitToast = useShowAiUsageLimitToast();
	const showAiUsageLimitToastRef = useRef(showAiUsageLimitToast);
	showAiUsageLimitToastRef.current = showAiUsageLimitToast;

	// State
	const [messages, setMessages] = useState<OrchestratorStreamMessage[]>([]);
	const [isLoading, setIsLoading] = useState(false);

	// Track if we should start fresh (set by reset, cleared after first message)
	const startFreshRef = useRef(false);
	const [state, setState] = useState<OrchestratorStreamState>({
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
	});

	// Step results accumulated during streaming - each step with its tool calls and response
	const [stepResults, setStepResults] = useState<StreamingStepResult[]>([]);
	const [currentPhase, setCurrentPhase] = useState<string>("idle");
	const [progressMessage, setProgressMessage] = useState<string>("");
	const [currentStep, setCurrentStep] = useState<TaskStep | null>(null);
	const [completedSteps, setCompletedSteps] = useState(0);
	const [totalSteps, setTotalSteps] = useState(0);

	// Track tool calls for the CURRENT step being executed (streaming)
	const [streamingToolCalls, setStreamingToolCalls] = useState<
		ToolCallState[]
	>([]);

	// Refs for cleanup
	const abortControllerRef = useRef<AbortController | null>(null);

	// Track when we're transitioning from approval - prevents race conditions where
	// SSE progress events reset the phase back to "awaiting_approval" before the
	// workflow has processed the approval signal
	const isTransitioningFromApprovalRef = useRef(false);

	/**
	 * The approval the server raised last. A run can ask again while the answer
	 * to its previous request is still on its way back, so an answer clears the
	 * card only when it is still the one it decided.
	 */
	const latestApprovalIdRef = useRef<string | null>(null);

	/**
	 * Freeze gate — once an assistant message id has been added, all
	 * subsequent SSE events targeting it are dropped (decision 12 /
	 *).
	 */
	const cancelledMessageIdsRef = useRef<Set<string>>(new Set());
	/**
	 * Wall-clock instant the most recent stream started, used for
	 * `latency_to_cancel_ms` in the cancel telemetry event.
	 */
	const streamStartedAtRef = useRef<number | null>(null);
	/**
	 * Id of the assistant message currently receiving deltas. Captured
	 * by `sendMessage` and read by `stop` so the synchronous flip
	 * always targets the right entry.
	 */
	const activeAssistantIdRef = useRef<string | null>(null);
	/**
	 * Mirror of `messages` for `stop` so we can compute
	 * `partial_token_count` without depending on stale closure state.
	 */
	const messagesRef = useRef<OrchestratorStreamMessage[]>([]);
	/**
	 * Live executionId of the turn in flight. `state.executionId` is unusable
	 * from inside `sendMessage`: the callback closes over the value that was
	 * current when it was created, which on a fresh turn is always `null`.
	 * The resume loop needs the id the `started` event just delivered, so it
	 * reads it here (issue #2269).
	 */
	const executionIdRef = useRef<string | null>(null);
	const eventReplayRef = useRef(createChatEventReplay());
	/**
	 * The in-flight message's idempotency key and the conversation it was
	 * sent in. Sent on the initial POST and on every retry of that message,
	 * and used by `stop` when no executionId has arrived yet.
	 */
	const clientRequestKeyRef = useRef<string | null>(null);
	const turnConversationIdRef = useRef<string | null>(null);
	const organizationIdRef = useRef(organizationId);
	organizationIdRef.current = organizationId;
	/**
	 * Step ids already counted into `completedSteps`. A resumed stream
	 * replays every `step_complete` from the beginning of the run, so the
	 * counter has to be idempotent per step rather than a bare increment.
	 */
	const completedStepIdsRef = useRef<Set<string>>(new Set());
	// Output may arrive in separate tool/step state before the next React render.
	const hasTurnOutputRef = useRef(false);

	// Track when we should clear content on next text_delta instead of immediately
	// on text_start - this prevents a blank flash between iterations
	const shouldClearOnNextDeltaRef = useRef(false);
	/**
	 * Becomes `true` after any tool event (start / result) interrupts the
	 * text stream. The next `text_delta` to land on the same assistant
	 * message prepends a `\n\n` so the post-tool sentence doesn't get
	 * jammed against the pre-tool sentence (e.g. "pattern.Onion
	 * architecture.." in the merged content). Reset once the separator
	 * has been applied so further deltas in the same text run flow
	 * normally. Lives in a ref because it's a transient stream-event
	 * boundary, not React state.
	 */
	const needsTextSeparatorRef = useRef(false);

	// ==========================================================================
	// PartyKit Integration for Real-Time Tool Updates
	// ==========================================================================
	// PartyKit provides instant WebSocket updates for tool execution,
	// complementing the SSE stream with sub-second tool call visibility
	// Ref to track previous tool calls to avoid unnecessary state updates
	const prevToolCallsRef = useRef<string>("");

	const {
		isConnected: isPartykitConnected,
		toolCalls: partykitToolCalls,
		stepProgress: partykitStepProgress,
		currentPhase: _partykitPhase,
		reset: resetPartykit,
		notifyStepStart: notifyPartykitStepStart,
	} = useOrchestratorPartyKit({
		executionId: state.executionId,
		enabled: isLoading && state.status === "running",
		onStepProgress: (progress) => {
			// Only update state if tool calls have actually changed
			// This prevents unnecessary re-renders from frequent heartbeats
			const newToolCalls: ToolCallState[] = (
				progress.toolCalls || []
			).map((tc) => ({
				id: tc.id,
				name: tc.name,
				// Reject the truncation sentinel here — see `safeToolField`.
				args: safeToolField(tc.args),
				result: safeToolField(tc.result),
				status: tc.status,
				durationMs: tc.durationMs,
				mcpAppResourceUri: (tc as any).mcpAppResourceUri,
				mcpAppConfigId: (tc as any).mcpAppConfigId,
			}));

			// Create a stable key for comparison.
			// Include args/result so partial MCP tool input updates trigger re-renders.
			const newKey = newToolCalls
				.map(
					(tc) =>
						`${tc.id}:${tc.status}:${JSON.stringify(tc.args ?? null)}:${JSON.stringify(tc.result ?? null)}`,
				)
				.join("|");

			if (newKey !== prevToolCallsRef.current) {
				prevToolCallsRef.current = newKey;
				setStreamingToolCalls(newToolCalls);
			}
		},
	});

	// Merge PartyKit real-time updates with SSE streaming tool calls
	// PartyKit updates are faster, so prefer them when available
	const effectiveStreamingToolCalls =
		partykitToolCalls.length > 0
			? partykitToolCalls.map((tc) => ({
					id: tc.id,
					name: tc.name,
					// Reject the truncation sentinel here — see `safeToolField`.
					args: safeToolField(tc.args),
					result: safeToolField(tc.result),
					status: tc.status,
					durationMs: tc.durationMs,
					mcpAppResourceUri: (tc as any).mcpAppResourceUri,
					mcpAppConfigId: (tc as any).mcpAppConfigId,
				}))
			: streamingToolCalls;

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			abortControllerRef.current?.abort();
		};
	}, []);

	// Mirror `messages` into a ref so `stop` can compute the partial
	// token count for the cancel telemetry event without depending on
	// stale closure state.
	useEffect(() => {
		messagesRef.current = messages;
	}, [messages]);

	/**
	 * Send a message and stream the orchestrator execution
	 * @param content - The message content
	 * @param history - Previous conversation history to include
	 * @param forceNewChat - If true, start fresh and ignore any existing messages
	 * @param templateInstructions - Optional instructions from @template mentions to prepend to system prompt
	 * @param templateIntegrationIds - Optional integration IDs from @template mentions to merge with enabled integrations
	 * @param templateMcpConfigIds - Optional MCP config IDs from @template mentions to merge with enabled configs
	 * @param templateFabricToolIds - Optional Fabric AI tool IDs from @template mentions to merge with enabled tools
	 */
	const sendMessage = useCallback(
		async (
			content: string,
			history: Array<{
				role: "user" | "assistant";
				content: string;
			}> = [],
			forceNewChat = false,
			templateInstructions?: string | null,
			templateIntegrationIds?: string[],
			templateMcpConfigIds?: string[],
			templateFabricToolIds?: string[],
			/** All image storage paths sent to the backend (includes carried-forward) */
			attachedImageUrls?: string[],
			/** Images to display as thumbnails in the UI (only newly-attached, not carried-forward) */
			displayImageUrls?: string[],
			/**
			 * Document IDs freshly uploaded from the composer this send. Merged
			 * with the option-level `attachedDocumentIds` (pre-attached project /
			 * workspace context) in the request body — never replacing it.
			 */
			sessionDocumentIds?: string[],
			/**
			 * Extracted-text envelopes for composer-attached documents, delivered
			 * inline. The orchestrator-temporal route already bounds and appends
			 * these to the message.
			 */
			inlineAttachmentContexts?: string[],
			overrides?: SendMessageOverrides,
		) => {
			if (!content.trim() || isLoading) {
				return null;
			}
			// A conversation created for this very send has not reached the
			// `conversationId` option yet (#2040).
			const effectiveConversationId =
				overrides?.conversationId ?? conversationId;
			const attachExecutionId = overrides?.attachExecutionId ?? null;

			// Cancel any existing request
			abortControllerRef.current?.abort();
			const sendController = new AbortController();
			abortControllerRef.current = sendController;

			// Check if we should start fresh (either explicit flag or from previous reset)
			const shouldStartFresh = forceNewChat || startFreshRef.current;
			startFreshRef.current = false; // Clear the flag

			// Add user message — show only newly-attached images, not carried-forward ones
			const userMessage: OrchestratorStreamMessage = {
				id: `msg-${Date.now()}-user`,
				role: "user",
				content: content.trim(),
				timestamp: new Date(),
				imageUrls: displayImageUrls,
			};

			// Add placeholder assistant message
			const assistantMessage: OrchestratorStreamMessage = {
				id: `msg-${Date.now()}-assistant`,
				role: "assistant",
				content: "",
				timestamp: new Date(),
				isStreaming: true,
				toolCalls: [],
				streamStatus: "streaming",
			};

			// Track the active assistant id and stream-start instant for
			// `stop` and the cancel telemetry payload.
			activeAssistantIdRef.current = assistantMessage.id;
			streamStartedAtRef.current = Date.now();

			// If starting fresh, replace messages entirely instead of appending
			if (shouldStartFresh) {
				setMessages([userMessage, assistantMessage]);
			} else {
				setMessages((prev) => [...prev, userMessage, assistantMessage]);
			}
			setIsLoading(true);
			setStepResults([]);
			setStreamingToolCalls([]);
			setCurrentPhase("routing");
			setProgressMessage("");
			setCurrentStep(null);
			setCompletedSteps(0);
			setTotalSteps(0);
			// Reset PartyKit state to clear tool calls from previous execution
			// This prevents old tool calls from being shown during the transition period
			// before the new executionId is received
			resetPartykit();
			// Also reset the comparison ref so new tool calls are properly detected
			prevToolCallsRef.current = "";
			// Reset deferred clear flag for new execution
			shouldClearOnNextDeltaRef.current = false;
			needsTextSeparatorRef.current = false;
			// New turn — the previous run's executionId must not be reachable
			// by this turn's resume loop, and its counted steps start over.
			executionIdRef.current = attachExecutionId;
			eventReplayRef.current = createChatEventReplay();
			completedStepIdsRef.current = new Set();
			hasTurnOutputRef.current = false;
			// One key per user message; retries of this message reuse it. An
			// attached turn's key stayed with the tab that sent it, and its
			// executionId already identifies it everywhere a key would.
			const clientRequestKey = attachExecutionId
				? null
				: newClientRequestKey();
			clientRequestKeyRef.current = clientRequestKey;
			turnConversationIdRef.current = effectiveConversationId ?? null;

			setState((prev) => ({
				...prev,
				status: "running",
				// The previous message's execution must not be reachable from
				// this one: Stop, follow-ups and approvals act on the current
				// turn only (until `started` delivers its id, Stop uses the
				// message's key).
				executionId: attachExecutionId,
				plan: null,
				result: null,
				approvalHistory: undefined,
				pendingApproval: null,
				// Scoped to one execution: the previous turn's answers were
				// already persisted with that execution and now travel in
				// `history`, so carrying them here would double-count them.
				answeredClarifications: [],
				planningAudit: null,
				artifacts: [],
				limitSignals: [],
				tokenBudget: undefined,
				handoffRecommended: undefined,
				budgetStop: undefined,
				turnId: undefined,
				turnGeneration: undefined,
				contextCompactions: [],
				model: undefined,
				apiBilling: undefined,
			}));

			// Preserve partial output and settle active tool cards on transport failure.
			const failWithoutDiscardingContent = (
				reason: string,
				includeErrorInEmptyContent = false,
			) => {
				setStreamingToolCalls(
					(prev) => settleUnfinishedToolCalls(prev) ?? prev,
				);
				setMessages((prev) =>
					prev.map((m) =>
						m.id === assistantMessage.id
							? {
									...m,
									content:
										includeErrorInEmptyContent &&
										!m.content &&
										!hasTurnOutputRef.current
											? `Error: ${reason}`
											: m.content,
									isError: true,
									isStreaming: false,
									streamStatus: "error" as const,
								}
							: m,
					),
				);
				setState((prev) => ({
					...prev,
					status: "failed",
					result: { ...prev.result, error: reason },
				}));
				setCurrentPhase("error");
				setIsLoading(false);
			};

			// The server refused this message: a different message is already
			// being answered in this conversation (another tab, or a turn this
			// tab lost track of). It never ran, so it must not look sent or
			// answered, and must not reach the conversation's saved history.
			// Attaching to the other turn instead would show that turn's answer
			// under this question, and the chat's save would then persist the
			// pair. So: drop the question and its placeholder, leave
			// `state.executionId` null (the chat saves a turn only once it has
			// one), and put the notice where the chat renders a failed turn.
			const refuseBecauseAnotherTurnIsLive = () => {
				// By identity, not id: ids come from `Date.now()`, so a
				// message sent in the same millisecond as the previous one
				// shares its ids, and an id filter would drop that one too.
				// Nothing has replaced these two objects yet: the refusal
				// arrives before any stream event for them.
				setMessages((prev) =>
					prev.filter(
						(m) => m !== userMessage && m !== assistantMessage,
					),
				);
				if (activeAssistantIdRef.current === assistantMessage.id) {
					activeAssistantIdRef.current = null;
				}
				// No turn holds this key, so there is nothing for Stop to
				// cancel by it.
				if (clientRequestKeyRef.current === clientRequestKey) {
					clientRequestKeyRef.current = null;
				}
				executionIdRef.current = null;
				const addition = onTurnRefusedRef.current?.(content.trim());
				setState((prev) => ({
					...prev,
					status: "failed",
					executionId: null,
					result: {
						error: addition
							? `${TURN_IN_PROGRESS_NOTICE} ${addition}`
							: TURN_IN_PROGRESS_NOTICE,
					},
				}));
				setCurrentPhase("idle");
				setProgressMessage("");
				setIsLoading(false);
			};

			try {
				// Debug: Log workspace IDs being sent
				console.log(
					"[useOrchestratorStream] Sending request with workspaceIds:",
					workspaceIds,
					"conversationId:",
					effectiveConversationId,
				);

				// Merge template instructions with system prompt (template takes precedence)
				const effectiveSystemPrompt = templateInstructions
					? templateInstructions +
						(systemPrompt ? `\n\n---\n\n${systemPrompt}` : "")
					: systemPrompt;

				// Merge template integration IDs with configured enabled IDs
				// Template IDs are additive - they enable additional integrations for this message
				const effectiveIntegrationIds = (() => {
					const baseIds = enabledIntegrationIds ?? [];
					const templateIds = templateIntegrationIds ?? [];
					if (templateIds.length === 0) {
						return enabledIntegrationIds;
					}
					// Merge and deduplicate
					return [...new Set([...baseIds, ...templateIds])];
				})();

				// Merge template MCP config IDs with configured enabled IDs
				const effectiveMcpConfigIds = (() => {
					const baseIds = enabledMcpConfigIds ?? [];
					const templateIds = templateMcpConfigIds ?? [];
					if (templateIds.length === 0) {
						return enabledMcpConfigIds;
					}
					// Merge and deduplicate
					return [...new Set([...baseIds, ...templateIds])];
				})();

				// Merge template Fabric AI tool IDs with configured enabled IDs
				const effectiveFabricToolIds = (() => {
					const baseIds = enabledFabricToolIds ?? [];
					const templateIds = templateFabricToolIds ?? [];
					if (templateIds.length === 0) {
						return enabledFabricToolIds;
					}
					// Merge and deduplicate
					return [...new Set([...baseIds, ...templateIds])];
				})();

				// Merge pre-attached prop docs with composer-uploaded docs,
				// de-duplicated, so neither channel clobbers the other.
				const mergedAttachedDocumentIds = (() => {
					const merged = [
						...(attachedDocumentIds ?? []),
						...(sessionDocumentIds ?? []),
					];
					return merged.length > 0 ? [...new Set(merged)] : undefined;
				})();

				// Start the streaming workflow
				// Pass conversationId so backend can fetch attached workspaces if workspaceIds is empty
				const initialRequestBody = JSON.stringify({
					eventReplay: true,
					message: content.trim(),
					history: history.map((m) => ({
						role: m.role,
						content: m.content,
					})),
					organizationId,
					executionMode,
					enabledMcpConfigIds: effectiveMcpConfigIds,
					enabledAgentIds,
					enabledFabricToolIds: effectiveFabricToolIds,
					enabledIntegrationIds: effectiveIntegrationIds,
					prioritizedToolIds,
					prioritizedAgentIds,
					prioritizedMcpConfigIds,
					systemPrompt: effectiveSystemPrompt,
					instanceId,
					modelOverride,
					prioritizedIntegrationIds,
					workspaceIds,
					attachedDocumentIds: mergedAttachedDocumentIds,
					inlineAttachmentContexts,
					projectId: projectId || undefined,
					conversationId: effectiveConversationId,
					continueFromTurnId: overrides?.continueFromTurnId,
					attachedImageUrls,
					// UI surface that started this run. Read by the
					// orchestrator workflow to scope the up-front clarifying
					// question to the standalone Loom chat
					// ("loom-orchestrator"). Without it the workflow sees
					// surface: undefined and never asks.
					surface: surfaceRef.current,
					// Omitted, not false, outside the Advisor.
					advisorOrigin: advisorOrigin ? true : undefined,
					launchWorkspaceId: launchWorkspaceId ?? undefined,
					launchFrameId: launchFrameId ?? undefined,
					launchSurface: launchSurface ?? undefined,
					// The message's idempotency key: a retry of this POST
					// attaches to the turn it already created.
					clientRequestKey,
				});

				// A reconnect is the executionId and nothing else: the
				// workflow already holds the message, history, tool selection
				// and context from the window that started it. `organizationId`
				// still has to travel for the route's membership check, and
				// `surface` keeps parity with the initial POST.
				// Before `started` there is no executionId to reconnect with;
				// the initial body is re-sent instead, and its key makes the
				// server attach to the turn it already created rather than
				// start a second one.
				const buildResumeRequestBody = () =>
					executionIdRef.current
						? JSON.stringify({
								eventReplay: true,
								afterEvent: eventReplayRef.current.cursor,
								executionId: executionIdRef.current,
								organizationId,
								conversationId: effectiveConversationId,
								instanceId,
								surface: surfaceRef.current,
								clientRequestKey,
							})
						: initialRequestBody;

				let timeoutResumes = 0;
				let consecutiveUncleanResumes = 0;
				// Counts reconnects of BOTH kinds and is never reset — see
				// MAX_TOTAL_RESUMES.
				let totalResumes = 0;
				let isResume = attachExecutionId !== null;

				// One iteration per streaming window — the initial POST, then
				// one per reconnect. `isLoading` and `state.status` are left
				// untouched across the gap: the PartyKit socket is gated on
				// `isLoading && status === "running"`, so any intermediate
				// value would tear it down and back up for nothing.
				// A message the server runs as a turn is idempotent by its key,
				// so a request whose outcome is unknown can be sent again;
				// a Weave message has no turn and cannot (see the shared
				// orchestrator-turn-modes module).
				const keyIdempotent = executionModeUsesTurns(executionMode);
				while (true) {
					let sawTerminal = false;
					let sawStreamTimeout = false;
					// The server could not confirm the turn's workflow
					// started (its start response was lost); the turn is
					// still pending. Retried with the same key below.
					let sawStartPending = false;
					let streamStarted = false;
					let streamError: unknown = null;
					// The request's outcome is unknown: the fetch itself failed
					// (no response arrived), a proxy answered 502/503/504, or
					// the response had no readable body. The server may have
					// admitted and started the turn regardless.
					let ambiguousOutcome = false;
					let responseReceived = false;

					try {
						const response = await fetch(
							ORCHESTRATOR_STREAM_ENDPOINT,
							{
								method: "POST",
								headers: {
									"Content-Type": "application/json",
								},
								body: isResume
									? buildResumeRequestBody()
									: initialRequestBody,
								// The turn's controller, reused deliberately:
								// a Stop landing in a reconnect gap has to
								// abort the fetch that follows it too.
								signal: abortControllerRef.current.signal,
							},
						);

						responseReceived = true;
						if (
							!response.ok &&
							keyIdempotent &&
							(response.status === 502 ||
								response.status === 503 ||
								response.status === 504)
						) {
							ambiguousOutcome = true;
							throw new Error(
								`The stream request ended with HTTP ${response.status}`,
							);
						}
						if (!response.ok) {
							const error = await response.json();
							// A different message is already being answered
							// in this conversation. Refused, never attached to
							// that turn — see `refuseBecauseAnotherTurnIsLive`.
							// The server checks a message's own key first and
							// attaches a retry of it, so this code means the
							// key has no turn: on a first request, and equally
							// on a retry whose earlier attempt never reached
							// the server. A reconnect by executionId skips
							// admission and cannot get it.
							if (
								response.status === 409 &&
								error?.code === "TURN_IN_PROGRESS"
							) {
								// Stop, reset and a newer send each abort this
								// send's controller. A refusal read after that
								// belongs to nothing on screen any more, and
								// its writes would land on whatever replaced it.
								if (!sendController.signal.aborted) {
									refuseBecauseAnotherTurnIsLive();
								}
								return null;
							}
							// The live turn exists but its workflow has not
							// started yet (its starter is still doing
							// pre-work): retry the same request after the
							// server's delay. Not a failure.
							if (
								response.status === 409 &&
								error?.code === "TURN_PENDING" &&
								totalResumes < MAX_TOTAL_RESUMES
							) {
								if (typeof error.executionId === "string") {
									executionIdRef.current = error.executionId;
								}
								totalResumes++;
								isResume = true;
								setProgressMessage(
									"Waiting for the run to start…",
								);
								const retryAfterSeconds = Number(
									response.headers?.get?.("Retry-After") ??
										"2",
								);
								const abortedDuringWait =
									await waitBeforeResume(
										Number.isFinite(retryAfterSeconds)
											? Math.min(
													Math.max(
														retryAfterSeconds,
														0,
													),
													10,
												) * 1000
											: 2000,
										abortControllerRef.current?.signal,
									);
								if (abortedDuringWait) {
									return null;
								}
								continue;
							}
							// This message was stopped before it started.
							if (
								response.status === 409 &&
								error?.code === "TURN_CANCELLED"
							) {
								setMessages((prev) =>
									prev.map((m) =>
										m.id === assistantMessage.id
											? {
													...m,
													isStreaming: false,
													streamStatus:
														"cancelled" as const,
												}
											: m,
									),
								);
								setState((prev) => ({
									...prev,
									status: "cancelled",
								}));
								setCurrentPhase("idle");
								setIsLoading(false);
								return null;
							}
							// Every ChatGPT plan serving the member is spent
							// (Fizzy #2770): say until when, in the turn itself.
							// The app's fetch interceptor raises the toast, with
							// the API-billing switch when the server offers it.
							if (isChatGptPlanSpentCode(error?.code)) {
								throw new Error(
									describeAiError(response.status, error)
										.description,
								);
							}
							// AI usage-limit short-circuit. The orchestrator stream route emits
							// a 429 with `code: "AI_USAGE_LIMIT_EXCEEDED"` and a
							// structured `data` payload when the chokepoint
							// blocks before the SSE stream starts; render the
							// shared destructive toast and reset to idle so the
							// user is not left with a generic error card. A
							// resume can no longer land here — the route skips
							// the chokepoint for executionId-only bodies.
							if (error?.code === "AI_USAGE_LIMIT_EXCEEDED") {
								const payload = isAiUsageLimitExceededPayload(
									error?.data,
								)
									? error.data
									: isAiUsageLimitExceededPayload(error)
										? error
										: null;
								if (payload) {
									showAiUsageLimitToastRef.current(payload);
								}
								setIsLoading(false);
								setState((prev) => ({
									...prev,
									status: "idle",
								}));
								setCurrentPhase("idle");
								return;
							}
							throw new Error(
								error.error || "Failed to start orchestrator",
							);
						}

						// A resume carries no marker; the turn's first
						// response already said (Fizzy #3048).
						const apiBilling = readChatGptPlanApiBilling(response);
						if (apiBilling) {
							setState((prev) => ({ ...prev, apiBilling }));
						}

						if (!response.body) {
							ambiguousOutcome = true;
							throw new Error("No response body");
						}
						streamStarted = true;
						await readChatEventStream(response.body, {
							readChunk: readBeforeSilence,
							dispatchOnLine: true,
							parse: parseOrchestratorStreamEvent,
							onEvent: (data) => {
								if (
									sendController.signal.aborted ||
									!eventReplayRef.current.accept(
										data.eventCursor,
									)
								) {
									return;
								}
								if (data.type === "stream_timeout") {
									sawStreamTimeout = true;
								} else if (data.type === "start_pending") {
									if (keyIdempotent) {
										sawStartPending = true;
									} else {
										sawTerminal = true;
										handleStreamEvent(
											{
												type: "error",
												message:
													"The run's start could not be confirmed",
											},
											assistantMessage.id,
										);
									}
								} else if (
									data.type === "completed" ||
									data.type === "error"
								) {
									sawTerminal = true;
								}
								if (
									!REPLAY_HANDSHAKE_EVENT_TYPES.has(data.type)
								) {
									consecutiveUncleanResumes = 0;
								}
								handleStreamEvent(data, assistantMessage.id);
								eventReplayRef.current.commit(data.eventCursor);
							},
							isOutcome: (event) =>
								[
									"stream_timeout",
									"start_pending",
									"completed",
									"error",
								].includes(event.type),
							isTerminal: (event) =>
								[
									"stream_timeout",
									"start_pending",
									"completed",
									"error",
								].includes(event.type),
						});
					} catch (error) {
						// A first-window failure is not resumable — there is no
						// run to get back to, so the outer catch owns it. A
						// resume attempt that never opened its stream IS
						// resumable: it takes the unclean-close budget, so a
						// transient 502 on the reconnect POST (the likeliest
						// real failure, arriving right after a 660s function
						// kill) can't discard everything the earlier windows
						// streamed.
						//
						// Exception: for a turn-mode message, a FIRST request
						// whose outcome is unknown (no response, a gateway
						// 5xx, no body) is retried with the same body and key —
						// the server attaches to the turn it may already have
						// started rather than start another. Authorization,
						// validation and usage-limit refusals are definite
						// answers and are never retried.
						const fetchNeverAnswered =
							!responseReceived &&
							(error as Error)?.name !== "AbortError";
						const retryableInitial =
							keyIdempotent &&
							!streamStarted &&
							(ambiguousOutcome || fetchNeverAnswered);
						if (
							error instanceof ChatStreamProtocolError ||
							(!streamStarted && !isResume && !retryableInitial)
						) {
							throw error;
						}
						// A mid-read throw is the usual shape of a platform
						// kill; it takes the same resume decision as a clean
						// close, so hold it in case we end up not resuming.
						streamError = error;
					}

					// Stop wins over everything: the optimistic flip has
					// already written the final `cancelled` state.
					if (
						cancelledMessageIdsRef.current.has(
							assistantMessage.id,
						) ||
						abortControllerRef.current?.signal.aborted === true
					) {
						if (streamError) {
							throw streamError;
						}
						break;
					}

					// `completed` / `error` already finished the run.
					if (sawTerminal) {
						break;
					}

					// `state.executionId` is the stale closure value here —
					// always read the ref. Without one, the message's key
					// still lets the initial body reconnect (see
					// `buildResumeRequestBody`) — but only in a mode the
					// server runs as a turn: Weave has no turn, the server
					// ignores the key, and a re-send would start a second
					// run.
					const resumableExecutionId =
						executionIdRef.current ??
						(executionModeUsesTurns(executionMode)
							? clientRequestKey
							: null);

					// Backstop for both budgets below. Nothing resets this, so a
					// loop that keeps refilling the unclean allowance with
					// replayed progress still terminates here.
					const totalBudgetLeft = totalResumes < MAX_TOTAL_RESUMES;

					// The server closed the window on purpose and the
					// workflow is still running: reconnect right away.
					if (
						sawStreamTimeout &&
						resumableExecutionId &&
						timeoutResumes < MAX_TIMEOUT_RESUMES &&
						totalBudgetLeft
					) {
						timeoutResumes++;
						totalResumes++;
						isResume = true;
						setProgressMessage(
							"Reconnecting to the running workflow…",
						);
						continue;
					}

					// The start could not be confirmed: send the same
					// message key again (still loading). The server's
					// reattach waits for the workflow or settles the turn.
					// Same bounded budget as an unclean close.
					if (
						sawStartPending &&
						consecutiveUncleanResumes < MAX_UNCLEAN_RESUMES &&
						totalBudgetLeft
					) {
						consecutiveUncleanResumes++;
						totalResumes++;
						isResume = true;
						setProgressMessage("Waiting for the run to start…");
						const abortedDuringWait = await waitBeforeResume(
							UNCLEAN_RESUME_DELAY_MS,
							abortControllerRef.current?.signal,
						);
						if (abortedDuringWait) {
							break;
						}
						continue;
					}

					// Either the stream died without a terminal event and
					// without the server's handoff, or a reconnect POST never
					// opened a stream at all. Both are transport failures that
					// a retry can fix, so they share one budget.
					if (
						!sawStreamTimeout &&
						resumableExecutionId &&
						consecutiveUncleanResumes < MAX_UNCLEAN_RESUMES &&
						totalBudgetLeft
					) {
						consecutiveUncleanResumes++;
						totalResumes++;
						isResume = true;
						setProgressMessage(
							"Reconnecting to the running workflow…",
						);
						const abortedDuringWait = await waitBeforeResume(
							UNCLEAN_RESUME_DELAY_MS,
							abortControllerRef.current?.signal,
						);
						if (abortedDuringWait) {
							break;
						}
						continue;
					}

					// Out of reconnect budget, or there is no executionId to
					// reconnect with. The workflow may well still be running
					// on Temporal, so say that instead of claiming the run
					// failed — and keep everything it streamed. The held
					// `streamError` is the only record of why the last attempt
					// died, so log it rather than dropping it.
					console.warn(
						`[OrchestratorStream] Resume budget exhausted after ${totalResumes} reconnect(s); giving up on the stream.`,
						streamError ??
							"(stream closed cleanly without a terminal event)",
					);
					failWithoutDiscardingContent(
						"The run's streaming window could not be resumed. The workflow may still be running.",
					);
					return null;
				}

				return executionIdRef.current;
			} catch (error) {
				// Cancellation gate (mirror of useDirectStream): once the user
				// has clicked Stop on this turn, the optimistic flip already
				// wrote the final `cancelled` state. Drop trailing errors
				// silently — both `AbortError` and any other late failure
				// (e.g. `TypeError` from a chunked-transfer hiccup) — so they
				// do not overwrite the visible "Stopped" caption or flip the
				// state to `failed`.
				if (cancelledMessageIdsRef.current.has(assistantMessage.id)) {
					return null;
				}

				if ((error as Error).name === "AbortError") {
					return null;
				}

				const errorMessage =
					error instanceof Error
						? error.message
						: "An error occurred";

				failWithoutDiscardingContent(
					errorMessage,
					!(error instanceof ChatStreamProtocolError),
				);
				return null;
			}
		},
		[
			isLoading,
			organizationId,
			executionMode,
			enabledMcpConfigIds,
			enabledAgentIds,
			enabledFabricToolIds,
			enabledIntegrationIds,
			prioritizedToolIds,
			prioritizedAgentIds,
			prioritizedMcpConfigIds,
			prioritizedIntegrationIds,
			workspaceIds,
			projectId,
			conversationId,
			systemPrompt,
			instanceId,
			modelOverride,
			advisorOrigin,
			launchWorkspaceId,
			launchFrameId,
			launchSurface,
			resetPartykit,
		],
	);

	/**
	 * Show a turn that is already running — one the conversation's read says
	 * is still in progress, after a reload or from another tab — as the live
	 * turn: its question, then its progress, any pending approval and its
	 * answer as they stream. Sends nothing new; Stop, approvals and follow-ups
	 * act on it as on a turn sent here.
	 */
	const attach = useCallback(
		(
			executionId: string,
			question: string,
			attachConversationId?: string,
		) =>
			sendMessage(
				question,
				[],
				false,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				{
					attachExecutionId: executionId,
					conversationId: attachConversationId,
				},
			),
		[sendMessage],
	);

	/**
	 * Handle incoming SSE events
	 */
	const handleStreamEvent = useCallback(
		(data: OrchestratorStreamEvent, assistantMessageId: string) => {
			// Freeze gate (decision 12 /): once the user has clicked
			// Stop on this turn, every subsequent SSE event for it is
			// dropped client-side so the `Stopped` caption is honoured
			// even while the workflow finishes its tear-down.
			if (cancelledMessageIdsRef.current.has(assistantMessageId)) {
				return;
			}

			switch (data.type) {
				case "started":
					setState((prev) => ({
						...prev,
						executionId: data.executionId,
						...(data.resumed
							? {
									pendingApproval: null,
									pendingClarification: null,
									status: "running" as const,
								}
							: {}),
						turnId:
							typeof data.turnId === "string"
								? data.turnId
								: prev.turnId,
						turnGeneration:
							typeof data.turnGeneration === "number"
								? data.turnGeneration
								: prev.turnGeneration,
					}));
					// The resume loop in `sendMessage` can't read
					// `state.executionId` — see `executionIdRef`.
					executionIdRef.current = data.executionId;
					if (data.resumed && !eventReplayRef.current.cursor) {
						// Reconnected mid-run: the text deltas that were in
						// flight when the previous window closed are gone for
						// good (Redis pub/sub doesn't replay). Appending the
						// post-resume deltas onto what survived would splice
						// two halves together across a silent hole, and
						// `completed`'s `data.response || m.content` fallback
						// would then preserve the gapped text. So the body has
						// to be replaced rather than extended (issue #2269).
						//
						// Defer that replacement instead of clearing here: the
						// server sends this handshake before it polls, so a
						// transport that dies just after it is the very shape
						// the retry loop exists for — and an immediate clear
						// would have already destroyed the only copy of the
						// prior windows' output, leaving the exhaustion path to
						// freeze an empty message. Reusing the hook's
						// defer-clear flag means the first post-resume delta
						// replaces the whole body (still no splice), a
						// `completed.response` replaces it wholesale, and if
						// neither ever arrives the old content survives.
						shouldClearOnNextDeltaRef.current = true;
						needsTextSeparatorRef.current = false;
					}
					break;

				case "phase":
					setCurrentPhase(data.phase);
					break;

				case "routing":
					setState((prev) => ({
						...prev,
						result: {
							...prev.result,
							routingDecision: {
								primaryAgent: data.primaryAgent,
								agentName: data.agentName,
								confidence: data.confidence,
								riskLevel: data.riskLevel,
								requiredConnections: data.requiredConnections,
								missingIntegrations: data.missingIntegrations,
								blockedOnConnections: data.blockedOnConnections,
							},
						},
					}));
					break;

				case "planning":
					if (data.plan) {
						const plan = toTaskPlan(data.plan);
						setState((prev) => ({
							...prev,
							plan,
						}));
						setTotalSteps(plan.steps.length);
					}
					setCurrentPhase("planning");
					break;

				case "step_start":
					setCurrentPhase("executing");
					// Reset streaming tool calls for new step
					setStreamingToolCalls([]);
					// Reset the comparison ref so new tool calls are properly detected
					prevToolCallsRef.current = "";
					// Notify PartyKit of step change to synchronize state and prevent tool call bleeding
					// This clears PartyKit tool calls from the previous step
					notifyPartykitStepStart(data.stepId);
					setCurrentStep({
						id: data.stepId,
						description: data.description,
						type: "agent",
						order: data.order,
						status: "in_progress",
					});
					// Update plan step status to in_progress
					setState((prev) => {
						if (!prev.plan) {
							return prev;
						}
						const updatedSteps = prev.plan.steps.map((s) =>
							s.id === data.stepId
								? { ...s, status: "in_progress" as const }
								: s,
						);
						return {
							...prev,
							plan: { ...prev.plan, steps: updatedSteps },
						};
					});
					break;

				case "step_complete": {
					if (data.response || data.toolCalls?.length) {
						hasTurnOutputRef.current = true;
					}
					// Add the completed step with its tool calls AND response
					const stepStatus = (data.status || "complete") as
						| "complete"
						| "error"
						| "skipped";
					const completedStep: StreamingStepResult = {
						stepId: data.stepId,
						stepDescription: data.stepDescription,
						status: stepStatus,
						response: data.response,
						toolCalls: (data.toolCalls || []).map((tc, idx) => ({
							id: tc.id || `tc-${data.stepId}-${idx}`,
							name: tc.name,
							// Reject the truncation sentinel here so a
							// fallback path in route.ts (when progress
							// query fails / returns empty) can't clobber
							// MCP App args with garbage. See
							// `safeToolField` doc above.
							args: safeToolField(tc.args),
							result: safeToolField(tc.result) ?? null,
							status: (tc.status || "success") as
								| "success"
								| "error",
							durationMs: tc.durationMs ?? 0,
							mcpAppResourceUri: tc.mcpAppResourceUri,
							mcpAppConfigId: tc.mcpAppConfigId,
						})),
						durationMs: data.durationMs ?? 0,
					};

					setStepResults((prev) => {
						// Replace any existing step with same ID, or add new
						const filtered = prev.filter(
							(s) => s.stepId !== data.stepId,
						);
						return [...filtered, completedStep];
					});

					// Clear streaming tool calls — BUT preserve any with MCP App UIs
					// so the McpAppFrame iframe stays mounted (avoids blank flash
					// while the completed step's McpAppFrame re-initializes).
					// The completed step section renders its own McpAppFrame,
					// but keeping the streaming one prevents an unmount/remount cycle.
					setStreamingToolCalls((prev) => {
						const mcpAppCalls = prev.filter(
							(tc) => tc.mcpAppResourceUri && tc.mcpAppConfigId,
						);
						return mcpAppCalls.length > 0 ? mcpAppCalls : [];
					});
					// `setStepResults` above replaces by stepId, so a replayed
					// step is harmless there — a bare increment is not. Count
					// each stepId once so a resumed stream, which re-emits
					// every completed step, doesn't inflate the progress
					// readout (issue #2269).
					if (!completedStepIdsRef.current.has(data.stepId)) {
						completedStepIdsRef.current.add(data.stepId);
						setCompletedSteps((prev) => prev + 1);
					}
					setCurrentStep(null);

					// Update plan step status to complete/error/skipped
					setState((prev) => {
						if (!prev.plan) {
							return prev;
						}
						const updatedSteps = prev.plan.steps.map((s) =>
							s.id === data.stepId
								? { ...s, status: stepStatus }
								: s,
						);
						return {
							...prev,
							plan: { ...prev.plan, steps: updatedSteps },
						};
					});
					break;
				}

				case "text_start": {
					// New iteration starting - defer clearing until first text_delta arrives
					// This prevents a blank flash between iterations while tool calls execute
					shouldClearOnNextDeltaRef.current = true;
					break;
				}

				case "text_delta": {
					// Append streaming text delta to the assistant message content
					if (data.content) {
						// If a new iteration started (text_start received), clear old content
						// on the first delta so there's no blank flash between iterations
						const shouldReplace = shouldClearOnNextDeltaRef.current;
						if (shouldReplace) {
							shouldClearOnNextDeltaRef.current = false;
							// A replacement starts a fresh text run, so a
							// pending tool-boundary separator refers to content
							// that is being discarded. Left set, it would splice
							// a `\n\n` into the middle of this run on the very
							// next delta.
							needsTextSeparatorRef.current = false;
						}
						// When a tool event interrupted the previous text run,
						// prepend a paragraph break so the post-tool text
						// doesn't merge into the pre-tool text. Only applies
						// when there's existing content AND the boundary
						// isn't already whitespace on either side.
						const needsSeparator =
							needsTextSeparatorRef.current && !shouldReplace;
						if (needsSeparator) {
							needsTextSeparatorRef.current = false;
						}
						setMessages((prev) =>
							prev.map((m) => {
								if (m.id !== assistantMessageId) {
									return m;
								}
								if (shouldReplace) {
									return { ...m, content: data.content };
								}
								const existing = m.content || "";
								const incoming = data.content;
								const separator =
									needsSeparator &&
									existing.length > 0 &&
									!/\s$/.test(existing) &&
									!/^\s/.test(incoming)
										? "\n\n"
										: "";
								return {
									...m,
									content: existing + separator + incoming,
								};
							}),
						);
					}
					break;
				}

				case "tool_start": {
					const toolName = data.toolName ?? data.name;
					if (!toolName) {
						break;
					}

					// Mark a text-segment boundary so the next text_delta
					// arriving on this assistant message gets a paragraph
					// break before it (avoids "pattern.Onion" sentence
					// merges across pre-tool / post-tool runs).
					needsTextSeparatorRef.current = true;

					const newToolCall: ToolCallState = {
						id: data.toolCallId || `tc-${Date.now()}-${toolName}`,
						name: toolName,
						args: data.args,
						status: data.status || "running",
						mcpAppResourceUri: data.mcpAppResourceUri,
						mcpAppConfigId: data.mcpAppConfigId,
					};

					setStreamingToolCalls((prev) =>
						mergeStreamingToolCall(prev, newToolCall),
					);
					break;
				}

				case "tool_input": {
					const toolName = data.toolName ?? data.name;
					if (!toolName) {
						break;
					}

					const newToolCall: ToolCallState = {
						id: data.toolCallId || `tc-${Date.now()}-${toolName}`,
						name: toolName,
						args: data.args,
						status: data.status || "pending",
						mcpAppResourceUri: data.mcpAppResourceUri,
						mcpAppConfigId: data.mcpAppConfigId,
					};

					setStreamingToolCalls((prev) =>
						mergeStreamingToolCall(prev, newToolCall),
					);
					break;
				}

				case "tool_result": {
					const status =
						data.status === "error" ? "error" : "complete";
					const toolName = data.toolName ?? data.name;
					if (!toolName) {
						break;
					}

					hasTurnOutputRef.current = true;

					const newToolCall: ToolCallState = {
						id: data.toolCallId || `tc-${Date.now()}-${toolName}`,
						name: toolName,
						args: data.args,
						result: data.result,
						status,
						durationMs: data.durationMs,
						mcpAppResourceUri: data.mcpAppResourceUri,
						mcpAppConfigId: data.mcpAppConfigId,
					};
					setStreamingToolCalls((prev) =>
						mergeStreamingToolCall(prev, newToolCall),
					);
					break;
				}

				case "limit_signal": {
					// Record a provider or internal budget signal so
					// the dashboard can render a LimitBanner + TokenBudgetCard.
					const signal = data.signal as
						| LimitSignalSummary
						| undefined;
					if (!signal || !signal.kind) {
						break;
					}
					setState((prev) => ({
						...prev,
						limitSignals: [...prev.limitSignals, signal],
						tokenBudget:
							signal.kind === "internal_budget" && signal.budget
								? signal.budget
								: prev.tokenBudget,
					}));
					break;
				}

				case "context_compacted": {
					const event: ContextCompactionEvent = {
						iteration: Number(data.iteration ?? 0),
						compactedTurns: Number(data.compactedTurns ?? 0),
						summaryChars: Number(data.summaryChars ?? 0),
						historyLengthBefore: Number(
							data.historyLengthBefore ?? 0,
						),
						timestamp: new Date().toISOString(),
					};
					setState((prev) => ({
						...prev,
						contextCompactions: [...prev.contextCompactions, event],
					}));
					break;
				}

				case "progress":
					setCompletedSteps(data.completedSteps || 0);
					setTotalSteps(data.totalSteps || 0);
					if (data.message) {
						setProgressMessage(data.message);
					}
					if (data.phase) {
						// Prevent race condition: when transitioning from approval, ignore
						// progress events that would reset us back to awaiting_approval
						// until we receive a non-approval phase from the server
						if (isTransitioningFromApprovalRef.current) {
							if (data.phase !== "awaiting_approval") {
								// Server has acknowledged the approval - clear the flag
								isTransitioningFromApprovalRef.current = false;
								setCurrentPhase(data.phase);
							}
							// Skip setting phase if still awaiting_approval during transition
						} else {
							setCurrentPhase(data.phase);
						}
					}
					break;

				case "approval_required":
					// Reset transition flag - we're waiting for approval again
					isTransitioningFromApprovalRef.current = false;
					latestApprovalIdRef.current = data.approvalId ?? null;
					setCurrentPhase("awaiting_approval");
					setState((prev) => ({
						...prev,
						status: "awaiting_approval",
						pendingApproval: {
							approvalId: data.approvalId,
							stepId: data.stepId,
							reason: data.reason,
						},
					}));
					break;

				case "approval_resolved":
					// Approval was granted - execution is resuming
					// Clear the transition flag since server has confirmed
					isTransitioningFromApprovalRef.current = false;
					setCurrentPhase("executing");
					setState((prev) => ({
						...prev,
						status: "running",
						pendingApproval: null,
					}));
					break;

				case "clarifying_question":
					// Orchestrator is paused waiting for the user to answer a
					// clarifying question (HITL sibling of approval).
					setCurrentPhase("awaiting_approval");
					setState((prev) => ({
						...prev,
						status: "awaiting_approval",
						pendingClarification: {
							clarificationId:
								typeof data.clarificationId === "string"
									? data.clarificationId
									: "",
							stepId:
								typeof data.stepId === "string"
									? data.stepId
									: undefined,
							question:
								typeof data.question === "string"
									? data.question
									: "Could you clarify how you'd like me to proceed?",
							options: Array.isArray(data.options)
								? (data.options.filter(
										(o: unknown) => typeof o === "string",
									) as string[])
								: undefined,
						},
					}));
					break;

				case "clarifying_resolved":
					setCurrentPhase("executing");
					setState((prev) => ({
						...prev,
						status: "running",
						pendingClarification: null,
					}));
					break;

				case "completed": {
					// `data.status` is the run's DOMAIN status: a stopped turn
					// completes in Temporal with status "cancelled" and must be
					// shown as cancelled, not as a finished answer.
					const domainStatus: "completed" | "cancelled" | "failed" =
						data.status === "cancelled"
							? "cancelled"
							: data.status === "failed"
								? "failed"
								: "completed";
					const turnCancelled = domainStatus === "cancelled";
					setCurrentPhase("complete");
					setState((prev) => ({
						...prev,
						approvalHistory: data.approvalHistory,
						status: domainStatus,
						result: {
							...prev.result,
							response: data.response,
							status: data.status,
							truncated: parseTurnTruncation(data.truncated),
						},
						plan: data.plan ? toTaskPlan(data.plan) : prev.plan,
						variables: data.variables || {},
						pendingApproval: null,
						planningAudit: data.planningAudit || null,
						artifacts: data.artifacts || [],
						// Final workflow output may carry the accumulated
						// limitSignals (replaces the live SSE-seeded list if present)
						// and the final tokenBudget snapshot for the dashboard.
						limitSignals:
							(data.limitSignals as LimitSignalSummary[]) ??
							prev.limitSignals,
						tokenBudget:
							(data.tokenBudget as typeof prev.tokenBudget) ??
							prev.tokenBudget,
						// "Continue in new chat" handoff signal — frontend renders
						// a CTA above the input box when set. A cancelled turn
						// offers none.
						handoffRecommended: turnCancelled
							? undefined
							: ((data.handoffRecommended as typeof prev.handoffRecommended) ??
								prev.handoffRecommended),
						// The structured token-allowance stop, live or restored
						// from the turn record on a reconnect, kept whatever the
						// status: it is the row's record of what the turn used.
						// Whether a card shows it is decided by the status (a
						// only terminal turns offer continuation; see `budgetStopToShow`).
						budgetStop:
							parseTurnBudgetStop(data.budgetStop) ??
							prev.budgetStop,
						// Every plan ran out mid-turn and API billing finished
						// it; the turn's first response could not say so
						// (Fizzy #3048).
						model: readPersistedModel(data),
						apiBilling:
							parseChatGptPlanApiBilling(data.apiBilling) ??
							prev.apiBilling,
					}));

					// Mark assistant message as done streaming and set content
					setMessages((prev) =>
						prev.map((m) =>
							m.id === assistantMessageId
								? {
										...m,
										// Set message content from response
										content:
											data.response || m.content || "",
										streamStatus: "completed",
										isStreaming: false,
										...(turnCancelled
											? {
													streamStatus:
														"cancelled" as const,
													cancelledAt:
														m.cancelledAt ??
														new Date().toISOString(),
												}
											: {}),
									}
								: m,
						),
					);

					// If we have step results from server that we haven't received via step_complete events,
					// add them (this handles workflows that don't emit per-step events)
					setStepResults((prev) => {
						// If we already have step results with tool calls, keep them
						if (
							prev.length > 0 &&
							prev.some(
								(s) => s.toolCalls?.length > 0 || s.response,
							)
						) {
							return prev;
						}
						// If server sent stepResults, use them
						if (data.stepResults && data.stepResults.length > 0) {
							return data.stepResults.map(
								(sr): StreamingStepResult => ({
									stepId: sr.stepId,
									stepDescription: sr.stepDescription,
									status: (sr.status || "complete") as
										| "complete"
										| "error"
										| "skipped",
									response: sr.response,
									toolCalls: (sr.toolCalls || []).map(
										(tc, idx) => ({
											id:
												tc.id ||
												`tc-${sr.stepId}-${idx}`,
											name: tc.name,
											// Reject sentinel — see
											// `safeToolField` doc.
											args: safeToolField(tc.args),
											result:
												safeToolField(tc.result) ??
												null,
											status: (tc.status || "success") as
												| "success"
												| "error",
											durationMs: tc.durationMs ?? 0,
											mcpAppResourceUri:
												tc.mcpAppResourceUri,
											mcpAppConfigId: tc.mcpAppConfigId,
										}),
									),
									durationMs: sr.durationMs ?? 0,
								}),
							);
						}
						// Fallback: build a single step from all tool calls
						if (data.toolCalls && data.toolCalls.length > 0) {
							return [
								{
									stepId: "execution",
									stepDescription: "Task execution",
									status: "complete" as const,
									response: data.response,
									toolCalls: data.toolCalls.map(
										(tc, idx) => ({
											id: tc.id || `tc-final-${idx}`,
											name: tc.name,
											// Reject sentinel — this fallback
											// fires when no progress query
											// data was available, so the
											// `data.toolCalls` here is the
											// truncated workflow output.
											args: safeToolField(tc.args),
											result:
												safeToolField(tc.result) ??
												null,
											status: (tc.status || "success") as
												| "success"
												| "error",
											durationMs: tc.durationMs ?? 0,
											mcpAppResourceUri:
												tc.mcpAppResourceUri,
											mcpAppConfigId: tc.mcpAppConfigId,
										}),
									),
									durationMs: data.totalDurationMs || 0,
								},
							];
						}
						return prev;
					});

					// Clear streaming state
					setStreamingToolCalls([]);
					setCurrentStep(null);
					setIsLoading(false);
					break;
				}

				case "error": {
					if (data.approvalHistory) {
						setState((prev) => ({
							...prev,
							approvalHistory: data.approvalHistory,
						}));
					}
					// AI usage-limit short-circuit. When the chokepoint blocks mid-stream
					// the route emits a structured SSE error event with
					// `code: "AI_USAGE_LIMIT_EXCEEDED"`. Render the
					// shared destructive toast and clear the streaming
					// placeholder so the user is not left with a
					// generic "Error:" stub.
					if (data.code === "AI_USAGE_LIMIT_EXCEEDED") {
						const payload = isAiUsageLimitExceededPayload(
							data?.data,
						)
							? data.data
							: isAiUsageLimitExceededPayload(data)
								? data
								: null;
						if (payload) {
							showAiUsageLimitToastRef.current(payload);
						}
						setCurrentPhase("idle");
						setProgressMessage("");
						setCurrentStep(null);
						setStreamingToolCalls(
							(prev) => settleUnfinishedToolCalls(prev) ?? prev,
						);
						const hadTurnOutput = hasTurnOutputRef.current;
						setMessages((prev) =>
							prev.flatMap((message) => {
								if (message.id !== assistantMessageId) {
									return [message];
								}
								// Keep earlier work; only the empty streaming placeholder is removed.
								if (
									!message.content.trim() &&
									!message.toolCalls?.length &&
									!hadTurnOutput
								) {
									return [];
								}
								return [
									{
										...message,
										isStreaming: false,
										isError: true,
										streamStatus: "error" as const,
										toolCalls: settleUnfinishedToolCalls(
											message.toolCalls,
										),
									},
								];
							}),
						);
						setIsLoading(false);
						setState((prev) => ({
							...prev,
							status: "idle",
							budgetStop:
								parseTurnBudgetStop(data.budgetStop) ??
								prev.budgetStop,
						}));
						break;
					}
					setCurrentPhase("error");
					// A failed run cannot finish the calls it left open; leave
					// them spinning and they read as still working (F11).
					setStreamingToolCalls(
						(prev) => settleUnfinishedToolCalls(prev) ?? prev,
					);
					// Handle both `error` and `message` field names for compatibility
					const errorMessage =
						data.error || data.message || "Unknown error";
					setState((prev) => ({
						...prev,
						status: "failed",
						result: {
							...prev.result,
							error: errorMessage,
						},
						// The turn row's stored token-allowance stop, which the
						// route sends on a failed turn's `error` event, live and
						// on a reconnect, exactly as on a `completed` one. Kept
						// as the record of what the turn used; a failed turn
						// uses terminal status for its card (`budgetStopToShow`).
						budgetStop:
							parseTurnBudgetStop(data.budgetStop) ??
							prev.budgetStop,
					}));

					setMessages((prev) =>
						prev.map((m) =>
							m.id === assistantMessageId
								? {
										...m,
										content:
											m.content ||
											`Error: ${errorMessage}`,
										streamStatus: "error",
										isError: true,
										isStreaming: false,
									}
								: m,
						),
					);

					setIsLoading(false);
					break;
				}
			}
		},
		[notifyPartykitStepStart],
	);

	/**
	 * Send approval/rejection for a pending step. "stale" means the run no
	 * longer waits on this approval; its card is cleared like an answered one.
	 */
	const sendApproval = useCallback(
		async (
			approved: boolean,
			feedback?: string,
		): Promise<ApprovalSendResult> => {
			if (!state.executionId) {
				return "failed";
			}
			const decidedApprovalId = latestApprovalIdRef.current;

			try {
				const response = await fetch(
					"/api/agents/fabric-ai/orchestrator-temporal/approve",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							executionId: state.executionId,
							approved,
							feedback,
							// The run takes the answer only for this approval.
							...(decidedApprovalId
								? { approvalId: decidedApprovalId }
								: {}),
						}),
					},
				);

				const result = approvalSendResult(response);
				if (result === "failed") {
					const error = await response.json();
					throw new Error(error.error || "Failed to send approval");
				}

				// The run may already have asked again (the stream delivered
				// the next request before this answer came back): that card
				// stays.
				if (latestApprovalIdRef.current !== decidedApprovalId) {
					return result;
				}

				// Set transition flag BEFORE updating state to prevent race condition
				// where progress events reset us back to awaiting_approval
				if (approved && result === "sent") {
					isTransitioningFromApprovalRef.current = true;
				}

				// Clear pending approval state; a stale card is cleared too,
				// since the run no longer waits on it.
				setState((prev) => ({
					...prev,
					status: "running",
					pendingApproval: null,
				}));
				setCurrentPhase("executing");
				// "Approval needed: …" described the card just answered; left
				// on screen it reads as a request with no card.
				setProgressMessage("");

				return result;
			} catch (error) {
				console.error("[OrchestratorStream] Approval error:", error);
				return "failed";
			}
		},
		[state.executionId],
	);

	/**
	 * Answer (or dismiss) a pending clarifying question. Signals the workflow via
	 * the /clarify route, which resumes the paused orchestration.
	 */
	const sendClarification = useCallback(
		async (answer: string, dismissed = false) => {
			if (!state.executionId) {
				return false;
			}
			try {
				const response = await fetch(
					"/api/agents/fabric-ai/orchestrator-temporal/clarify",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							executionId: state.executionId,
							answer,
							dismissed,
						}),
					},
				);
				if (!response.ok) {
					const error = await response.json();
					throw new Error(
						error.error || "Failed to send clarification",
					);
				}
				// Add the answered question to the live transcript. This is the
				// path that fixes the reported case: the next message in the
				// same session builds its history from `messages` plus a
				// `completedExecutions` that React has not re-rendered yet, so
				// an answer recorded only on the execution record would not
				// reach the following turn (Fizzy #2406). It also leaves the
				// exchange visible after the card is dismissed, instead of the
				// question and answer vanishing from the thread.
				const answeredQuestion = state.pendingClarification?.question;
				if (!dismissed && answer.trim() && answeredQuestion) {
					setMessages((prev) => [
						...prev,
						{
							id: `msg-${Date.now()}-clarification`,
							metadata: {
								clarification: {
									question: answeredQuestion,
									answer: answer.trim(),
								},
							},
							role: "user",
							content: formatClarificationTurn({
								question: answeredQuestion,
								answer: answer.trim(),
							}),
							timestamp: new Date(),
						},
					]);
				}

				setState((prev) => ({
					...prev,
					status: "running",
					pendingClarification: null,
					// Also record it on the execution, which is what rebuilds
					// history after a page reload — `messages` is not the
					// authoritative source there (Fizzy #2406). Read from
					// `prev` so this needs no extra dependency. A dismissal
					// carries no answer, so nothing to record.
					answeredClarifications:
						dismissed ||
						!answer.trim() ||
						!prev.pendingClarification
							? prev.answeredClarifications
							: [
									...prev.answeredClarifications,
									{
										question:
											prev.pendingClarification.question,
										answer: answer.trim(),
									},
								],
				}));
				setCurrentPhase("executing");
				return true;
			} catch (error) {
				console.error(
					"[OrchestratorStream] Clarification error:",
					error,
				);
				return false;
			}
		},
		[state.executionId, state.pendingClarification],
	);

	/**
	 * Send a follow-up message to modify or clarify the current execution.
	 * Only works when an execution is in progress.
	 */
	const sendFollowUp = useCallback(
		async (message: string, isModification = false) => {
			if (!state.executionId) {
				console.warn(
					"[OrchestratorStream] Cannot send follow-up: no active execution",
				);
				return false;
			}

			if (
				state.status !== "running" &&
				state.status !== "awaiting_approval"
			) {
				console.warn(
					"[OrchestratorStream] Cannot send follow-up: execution not active",
				);
				return false;
			}

			// Add user message optimistically so it appears in the UI immediately
			const followUpMessage: OrchestratorStreamMessage = {
				id: `msg-${Date.now()}-followup`,
				role: "user",
				content: message,
				timestamp: new Date(),
			};
			setMessages((prev) => [...prev, followUpMessage]);

			try {
				const response = await fetch(
					"/api/agents/fabric-ai/orchestrator-temporal/follow-up",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							executionId: state.executionId,
							message,
							isModification,
						}),
					},
				);

				if (!response.ok) {
					const error = await response.json();
					throw new Error(error.error || "Failed to send follow-up");
				}

				console.log("[OrchestratorStream] Follow-up sent:", {
					executionId: state.executionId,
					isModification,
				});

				return true;
			} catch (error) {
				console.error("[OrchestratorStream] Follow-up error:", error);
				// Remove the optimistic message on failure
				setMessages((prev) =>
					prev.filter((m) => m.id !== followUpMessage.id),
				);
				return false;
			}
		},
		[state.executionId, state.status],
	);

	/**
	 * Stop the current orchestrator turn.
	 * Per spec section 8.3 / decisions 11+12+19+20: synchronous
	 * optimistic flip — the active assistant message is marked
	 * `streamStatus: "cancelled"`, `isLoading` clears, and the input
	 * regains focus immediately. There is no `Stopping…` interstitial.
	 * This works while `pendingApproval` is set (/ decision 20):
	 * cancelling the workflow implicitly rejects the pending step.
	 * @param triggeredBy - whether this stop came from the morph button
	 * click or the Esc keybinding. Threaded into telemetry so we can
	 * distinguish input sources in the funnel.
	 */
	const stop = useCallback((triggeredBy: "button" | "esc" = "button") => {
		const targetId = activeAssistantIdRef.current;
		if (targetId) {
			if (cancelledMessageIdsRef.current.has(targetId)) {
				// Idempotent — clicking twice does nothing the second
				// time.
				return;
			}
			cancelledMessageIdsRef.current.add(targetId);
		}

		// 1. Synchronous flip — abort, mark cancelled, persist.
		abortControllerRef.current?.abort();

		const cancelledAt = new Date().toISOString();
		if (targetId) {
			setMessages((prev) =>
				prev.map((m) =>
					m.id === targetId
						? {
								...m,
								isStreaming: false,
								streamStatus: "cancelled",
								cancelledAt,
							}
						: m,
				),
			);
		}
		setIsLoading(false);
		setState((prev) => ({
			...prev,
			status: "cancelled",
			pendingApproval: null,
		}));

		// 2. Telemetry — capture latency and partial body length at
		// click-time. Uses the `messagesRef` mirror so we read the
		// most recent content even though `setMessages` above is
		// asynchronous.
		const startedAt = streamStartedAtRef.current;
		const latencyMs =
			startedAt !== null ? Math.max(0, Date.now() - startedAt) : 0;
		const partialBody = targetId
			? (messagesRef.current.find((m) => m.id === targetId)?.content ??
				"")
			: "";
		const partialTokenCount = Math.ceil(partialBody.length / 4);

		emitCancelEvent({
			surface: telemetrySurfaceRef.current,
			agentId: null,
			executionId: executionIdRef.current,
			partial_token_count: partialTokenCount,
			latency_to_cancel_ms: latencyMs,
			triggered_by: triggeredBy,
		});

		// 3. Fire-and-forget cancel POST against the existing
		// orchestrator-temporal cancel route. We only await the
		// response to detect failure for the toast — the UI does
		// NOT depend on it (decision 11 /). Before `started` there is
		// no executionId yet: the message's key identifies the turn
		// (or, if the server has not created it, leaves a tombstone so
		// it never starts).
		// Only the CURRENT turn's identity: `state.executionId` can still
		// hold the previous message's run until this one's `started`
		// arrives, and cancelling that would leave this one running.
		const executionId = executionIdRef.current;
		const clientRequestKey = clientRequestKeyRef.current;
		if (executionId || clientRequestKey) {
			void fetch("/api/agents/fabric-ai/orchestrator-temporal/cancel", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...(executionId ? { executionId } : {}),
					...(clientRequestKey ? { clientRequestKey } : {}),
					...(turnConversationIdRef.current
						? {
								conversationId: turnConversationIdRef.current,
							}
						: {}),
					...(organizationIdRef.current
						? { organizationId: organizationIdRef.current }
						: {}),
				}),
			})
				.then((response) => {
					if (!response.ok) {
						onStopFailedRef.current?.();
					}
				})
				.catch(() => {
					onStopFailedRef.current?.();
				});
		}
	}, []);

	/**
	 * Backward-compat alias — `cancel` now routes through `stop`.
	 * Existing destructurers continue to compile while consumers migrate
	 * to the new name.
	 */
	const cancel = useCallback(() => {
		stop("button");
	}, [stop]);

	/**
	 * Reset all state and mark for fresh start on next message.
	 * NOTE: `reset` deliberately bypasses `stop` so it does NOT emit
	 * a cancel telemetry event or fire the cancel POST. `reset` is a
	 * client-side teardown (e.g. switching conversations) — there is no
	 * user-initiated stop to record.
	 */
	const reset = useCallback(() => {
		abortControllerRef.current?.abort();
		setMessages([]);
		setStepResults([]);
		setStreamingToolCalls([]);
		setCurrentPhase("idle");
		setProgressMessage("");
		setCurrentStep(null);
		setCompletedSteps(0);
		setTotalSteps(0);
		setIsLoading(false);
		setState({
			executionId: null,
			status: "idle",
			plan: null,
			variables: {},
			result: null,
			pendingApproval: null,
			pendingClarification: null,
			answeredClarifications: [],
			planningAudit: null,
			artifacts: [],
			limitSignals: [],
			contextCompactions: [],
		});
		// Reset approval transition flag
		isTransitioningFromApprovalRef.current = false;
		// Reset tool calls comparison ref
		prevToolCallsRef.current = "";
		// Reset deferred clear flag
		shouldClearOnNextDeltaRef.current = false;
		needsTextSeparatorRef.current = false;
		// Reset cancel-related refs.
		cancelledMessageIdsRef.current = new Set();
		streamStartedAtRef.current = null;
		activeAssistantIdRef.current = null;
		// Reset resume-related refs so a torn-down turn can't be reconnected
		// to and the step counter starts clean.
		executionIdRef.current = null;
		completedStepIdsRef.current = new Set();
		hasTurnOutputRef.current = false;
		clientRequestKeyRef.current = null;
		turnConversationIdRef.current = null;
		// Mark that next sendMessage should start fresh
		// This handles race conditions where reset is called but
		// sendMessage is invoked before React re-renders with empty messages
		startFreshRef.current = true;
		// Reset PartyKit state
		resetPartykit();
	}, [resetPartykit]);

	return {
		// State
		messages,
		isLoading,
		state,

		// Actions
		sendMessage,
		attach,
		sendApproval,
		sendClarification, // Answer/dismiss a pending up-front clarifying question
		sendFollowUp, // Send follow-up message for mid-execution modifications
		/**
		 * Stop the in-flight orchestrator turn. Canonical name from
		 * `specs/2026-05-09-stop-ai-generation/`. Use in new code.
		 */
		stop,
		/**
		 * Backward-compat alias for `stop("button")`. Kept while
		 * existing callers migrate.
		 */
		cancel,
		reset,

		// Computed
		isRunning: state.status === "running",
		isAwaitingApproval: state.status === "awaiting_approval",
		isComplete:
			state.status === "completed" ||
			state.status === "failed" ||
			state.status === "cancelled",
		isFollowUpEnabled:
			!!state.executionId &&
			(state.status === "running" ||
				state.status === "awaiting_approval"),
		currentPhase,
		progressMessage,
		currentStep,
		completedSteps,
		totalSteps,
		stepResults,
		streamingToolCalls: effectiveStreamingToolCalls, // Tool calls with real-time PartyKit updates
		planningAudit: state.planningAudit, // Planning transparency data
		artifacts: state.artifacts, // Artifacts produced during execution

		// PartyKit real-time status
		isPartykitConnected,
		partykitStepProgress, // Real-time step progress from PartyKit
	};
}
