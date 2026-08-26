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
	RequiredConnection,
	TaskPlan,
	TaskStep,
} from "@repo/temporal";
import {
	isAiUsageLimitExceededPayload,
	useShowAiUsageLimitToast,
} from "@saas/payments/lib/ai-usage-limit-toast";
import { useCallback, useEffect, useRef, useState } from "react";
import { emitCancelEvent } from "../lib/cancel-telemetry";
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
	 * Surface that mounts this hook — used for the
	 * `ai_generation_cancelled` telemetry event. The orchestrator hook
	 * is mounted by the standalone Loom Orchestrator page; surfaces
	 * routing through here from another context can override.
	 */
	surface?: "loom-orchestrator";
	/**
	 * Invoked when the fire-and-forget cancel POST receives a non-2xx
	 * response. The consumer typically surfaces a non-blocking toast —
	 * the visual state of the message does NOT revert (/
	 * decision 11).
	 */
	onStopFailed?: () => void;
}

export interface OrchestratorStreamMessage {
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
		| "provider_overloaded";
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
}

export interface OrchestratorStreamState {
	executionId: string | null;
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
 * Resume budgets (issue #2269 option 2).
 *
 * Every `stream_timeout` follows a full 600s server window, so five of them
 * puts a ~1h ceiling on a single turn — long enough for the runs that
 * motivated this, bounded enough that a stuck workflow can't reconnect
 * forever. Unclean closes (platform kill, transport hiccup) get their own,
 * much smaller budget because they can recur in tight succession; it resets
 * on delivered progress, so a long healthy run that flaps once mid-window
 * doesn't spend the allowance a genuinely broken connection needs to hit.
 */
const MAX_TIMEOUT_RESUMES = 5;
const MAX_UNCLEAN_RESUMES = 3;
const UNCLEAN_RESUME_DELAY_MS = 2000;
/**
 * Hard backstop across BOTH budgets that nothing resets. The per-budget
 * counters are the normal bound; this one exists because the unclean counter
 * resets on delivered progress, and a replayed stream can deliver the same
 * progress every window forever. Five timeout resumes plus a healthy margin
 * of genuine flap recoveries stays well under 12 — only a pathological
 * handshake-then-drop or replay-only loop ever reaches it.
 */
const MAX_TOTAL_RESUMES = 12;
/**
 * Events the server re-sends on every window, so receiving one proves
 * nothing about the connection's health and must not refill the
 * unclean-close budget. `started` is a per-window handshake, not progress,
 * and `stream_timeout` is the server closing the window on purpose.
 */
const REPLAY_HANDSHAKE_EVENT_TYPES = new Set(["started", "stream_timeout"]);

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
		surface = "loom-orchestrator",
		onStopFailed,
	} = options;

	// Latest-value refs so `stop` does not need to memoize on these.
	const surfaceRef = useRef(surface);
	surfaceRef.current = surface;
	const onStopFailedRef = useRef(onStopFailed);
	onStopFailedRef.current = onStopFailed;

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
		pendingApproval: null,
		pendingClarification: null,
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
	/**
	 * Step ids already counted into `completedSteps`. A resumed stream
	 * replays every `step_complete` from the beginning of the run, so the
	 * counter has to be idempotent per step rather than a bare increment.
	 */
	const completedStepIdsRef = useRef<Set<string>>(new Set());

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
		) => {
			if (!content.trim() || isLoading) {
				return null;
			}

			// Cancel any existing request
			abortControllerRef.current?.abort();
			abortControllerRef.current = new AbortController();

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
			executionIdRef.current = null;
			completedStepIdsRef.current = new Set();

			setState((prev) => ({
				...prev,
				status: "running",
				plan: null,
				result: null,
				pendingApproval: null,
				planningAudit: null,
				artifacts: [],
				limitSignals: [],
				tokenBudget: undefined,
				handoffRecommended: undefined,
				contextCompactions: [],
			}));

			// Non-destructive failure for a stream we could not get back
			// (issue #2269). Deliberately NOT routed through the `error` event
			// handler: that one overwrites the assistant body with
			// `Error: <msg>`, discarding everything the run streamed before
			// the window closed — up to an hour of work on a long turn.
			// Mirrors `stop()`'s shape instead: freeze the message where it
			// is, keep stepResults / artifacts, and record the reason in
			// `state.result.error` for the failure notice.
			const failWithoutDiscardingContent = (reason: string) => {
				setMessages((prev) =>
					prev.map((m) =>
						m.id === assistantMessage.id
							? {
									...m,
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

			try {
				// Debug: Log workspace IDs being sent
				console.log(
					"[useOrchestratorStream] Sending request with workspaceIds:",
					workspaceIds,
					"conversationId:",
					conversationId,
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
					conversationId,
					attachedImageUrls,
					// UI surface that started this run. Read by the
					// orchestrator workflow to scope the up-front clarifying
					// question to the standalone Loom chat
					// ("loom-orchestrator"). Without it the workflow sees
					// surface: undefined and never asks.
					surface: surfaceRef.current,
				});

				// A reconnect is the executionId and nothing else: the
				// workflow already holds the message, history, tool selection
				// and context from the window that started it. `organizationId`
				// still has to travel for the route's membership check, and
				// `surface` keeps parity with the initial POST.
				const buildResumeRequestBody = () =>
					JSON.stringify({
						executionId: executionIdRef.current,
						organizationId,
						conversationId,
						instanceId,
						surface: surfaceRef.current,
					});

				let timeoutResumes = 0;
				let consecutiveUncleanResumes = 0;
				// Counts reconnects of BOTH kinds and is never reset — see
				// MAX_TOTAL_RESUMES.
				let totalResumes = 0;
				let isResume = false;

				// One iteration per streaming window — the initial POST, then
				// one per reconnect. `isLoading` and `state.status` are left
				// untouched across the gap: the PartyKit socket is gated on
				// `isLoading && status === "running"`, so any intermediate
				// value would tear it down and back up for nothing.
				while (true) {
					let sawTerminal = false;
					let sawStreamTimeout = false;
					let streamStarted = false;
					let streamError: unknown = null;

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

						if (!response.ok) {
							const error = await response.json();
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
								return;
							}
							throw new Error(
								error.error || "Failed to start orchestrator",
							);
						}

						// Process SSE stream
						const reader = response.body?.getReader();
						if (!reader) {
							throw new Error("No response body");
						}
						// From here on a failure is mid-stream, which is what a
						// reconnect can recover. Anything before it (non-ok
						// HTTP, a fetch that never produced a body) is not
						// resumable and belongs to the outer catch.
						streamStarted = true;

						const decoder = new TextDecoder();
						let buffer = "";

						while (true) {
							const { done, value } = await reader.read();
							if (done) {
								break;
							}

							buffer += decoder.decode(value, { stream: true });
							const lines = buffer.split("\n");
							buffer = lines.pop() || "";

							for (const line of lines) {
								if (line.startsWith("data: ")) {
									try {
										const data = JSON.parse(line.slice(6));
										if (data.type === "stream_timeout") {
											sawStreamTimeout = true;
										} else if (
											data.type === "completed" ||
											data.type === "error"
										) {
											sawTerminal = true;
										}
										// Delivered progress proves the
										// connection works, so a flap earlier
										// in the turn stops counting against
										// the reconnect budget a genuinely
										// broken stream needs. Control events
										// are excluded: the server re-emits
										// `started` on every resume before it
										// polls, so a transport that opens
										// long enough for the handshake and
										// then drops would refill the budget
										// every cycle and reconnect forever.
										if (
											!REPLAY_HANDSHAKE_EVENT_TYPES.has(
												data.type,
											)
										) {
											consecutiveUncleanResumes = 0;
										}
										handleStreamEvent(
											data,
											assistantMessage.id,
										);
									} catch (_parseError) {
										// Skip malformed JSON
										if (line.slice(6).trim()) {
											console.warn(
												"[OrchestratorStream] Failed to parse:",
												line,
											);
										}
									}
								}
							}
						}
					} catch (error) {
						// A first-window failure is not resumable — there is no
						// run to get back to, so the outer catch owns it. A
						// resume attempt that never opened its stream IS
						// resumable: it takes the unclean-close budget, so a
						// transient 502 on the reconnect POST (the likeliest
						// real failure, arriving right after a 660s function
						// kill) can't discard everything the earlier windows
						// streamed.
						if (!streamStarted && !isResume) {
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
					// always read the ref.
					const resumableExecutionId = executionIdRef.current;

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

				setMessages((prev) =>
					prev.map((m) =>
						m.id === assistantMessage.id
							? {
									...m,
									content: `Error: ${errorMessage}`,
									isError: true,
									isStreaming: false,
								}
							: m,
					),
				);

				setState((prev) => ({
					...prev,
					status: "failed",
				}));

				setIsLoading(false);
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
			resetPartykit,
		],
	);

	/**
	 * Handle incoming SSE events
	 */
	const handleStreamEvent = useCallback(
		(data: any, assistantMessageId: string) => {
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
					}));
					// The resume loop in `sendMessage` can't read
					// `state.executionId` — see `executionIdRef`.
					executionIdRef.current = data.executionId;
					if (data.resumed) {
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
						const plan: TaskPlan = {
							id: data.plan.id,
							description: data.plan.description,
							riskLevel: data.plan.riskLevel,
							strategy: data.plan.strategy || "agent",
							createdAt:
								data.plan.createdAt || new Date().toISOString(),
							steps: data.plan.steps.map((s: any) => ({
								id: s.id,
								description: s.description,
								type: s.type || "agent",
								order: s.order,
								status: s.status || "pending",
								riskLevel: s.riskLevel,
								requiresApproval: s.requiresApproval,
							})),
						};
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
						toolCalls: (data.toolCalls || []).map(
							(tc: any, idx: number) => ({
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
							}),
						),
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

				case "completed":
					setCurrentPhase("complete");
					setState((prev) => ({
						...prev,
						status: "completed",
						result: {
							...prev.result,
							response: data.response,
							status: data.status,
						},
						plan: data.plan || prev.plan,
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
						// a CTA above the input box when set.
						handoffRecommended:
							(data.handoffRecommended as typeof prev.handoffRecommended) ??
							prev.handoffRecommended,
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
										isStreaming: false,
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
								(sr: any): StreamingStepResult => ({
									stepId: sr.stepId,
									stepDescription: sr.stepDescription,
									status: (sr.status || "complete") as
										| "complete"
										| "error"
										| "skipped",
									response: sr.response,
									toolCalls: (sr.toolCalls || []).map(
										(tc: any, idx: number) => ({
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
										(tc: any, idx: number) => ({
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

				case "error": {
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
						setMessages((prev) =>
							prev.filter((m) => m.id !== assistantMessageId),
						);
						setIsLoading(false);
						setState((prev) => ({ ...prev, status: "idle" }));
						break;
					}
					setCurrentPhase("error");
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
					}));

					setMessages((prev) =>
						prev.map((m) =>
							m.id === assistantMessageId
								? {
										...m,
										content: `Error: ${errorMessage}`,
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
	 * Send approval/rejection for a pending step
	 */
	const sendApproval = useCallback(
		async (approved: boolean, feedback?: string) => {
			if (!state.executionId) {
				return false;
			}

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
						}),
					},
				);

				if (!response.ok) {
					const error = await response.json();
					throw new Error(error.error || "Failed to send approval");
				}

				// Set transition flag BEFORE updating state to prevent race condition
				// where progress events reset us back to awaiting_approval
				if (approved) {
					isTransitioningFromApprovalRef.current = true;
				}

				// Clear pending approval state
				setState((prev) => ({
					...prev,
					status: "running",
					pendingApproval: null,
				}));
				setCurrentPhase("executing");

				return true;
			} catch (error) {
				console.error("[OrchestratorStream] Approval error:", error);
				return false;
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
				setState((prev) => ({
					...prev,
					status: "running",
					pendingClarification: null,
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
		[state.executionId],
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
	const stop = useCallback(
		(triggeredBy: "button" | "esc" = "button") => {
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
				? (messagesRef.current.find((m) => m.id === targetId)
						?.content ?? "")
				: "";
			const partialTokenCount = Math.ceil(partialBody.length / 4);

			emitCancelEvent({
				surface: surfaceRef.current,
				agentId: null,
				executionId: state.executionId ?? null,
				partial_token_count: partialTokenCount,
				latency_to_cancel_ms: latencyMs,
				triggered_by: triggeredBy,
			});

			// 3. Fire-and-forget cancel POST against the existing
			// orchestrator-temporal cancel route. We only await the
			// response to detect failure for the toast — the UI does
			// NOT depend on it (decision 11 /).
			const executionId = state.executionId;
			if (executionId) {
				void fetch(
					"/api/agents/fabric-ai/orchestrator-temporal/cancel",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ executionId }),
					},
				)
					.then((response) => {
						if (!response.ok) {
							onStopFailedRef.current?.();
						}
					})
					.catch(() => {
						onStopFailedRef.current?.();
					});
			}
		},
		[state.executionId],
	);

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
