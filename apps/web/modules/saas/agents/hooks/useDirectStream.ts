"use client";

/**
 * useDirectStream
 * React hook for streaming Direct mode chat responses via SSE.
 * Provides real-time text streaming and tool call visualization.
 * Uses the direct-chat Temporal workflow through the versioned SSE transport.
 */

import type { LimitSignal } from "@repo/ai/limits";
import {
	isAiUsageLimitExceededPayload,
	useShowAiUsageLimitToast,
} from "@saas/payments/lib/ai-usage-limit-toast";
import {
	describeAiError,
	isChatGptPlanSpentCode,
} from "@saas/shared/lib/ai-error-message";
import { useCallback, useEffect, useRef, useState } from "react";
import { emitCancelEvent } from "../lib/cancel-telemetry";
import type { ChatConfirmationRequest } from "../lib/chat-confirmation";
import type { ChatTurnTruncation } from "../lib/chat-turn-truncation";
import {
	type ChatGptPlanApiBilling,
	readChatGptPlanApiBilling,
} from "../lib/chatgpt-plan-api-billing";
import {
	settleUnfinishedToolCalls,
	trimHistoryForRequest,
} from "../lib/direct-chat-turns";
import { applyDirectStreamEvent } from "../lib/direct-stream-events";
import type {
	DirectStreamEvent,
	WorkflowConfirmation,
} from "../lib/direct-stream-protocol";
import { loadInstanceAgentConfig } from "../lib/load-instance-agent-config";
import { readDirectStream } from "../lib/read-direct-stream";

/**
 * Stream-level status surfaced on assistant messages so the renderer can
 * caption cancelled turns inline (`Stopped`) and so persistence knows
 * which entries were halted by the user. Stored alongside the message
 * body in the existing `AiChat.messages` JSON blob — no migration.
 * See `specs/2026-05-09-stop-ai-generation/spec.md` § 5.1.
 */
export type StreamStatus = "streaming" | "completed" | "error" | "cancelled";

export interface UseDirectStreamOptions {
	organizationId?: string;
	reasoningMode?: "lite" | "balanced" | "deep" | "planner";
	/**
	 * Canonical model name to run this turn on, overriding the organization's
	 * configured default. Set when the user picks a raw model in the agent
	 * picker; left null for a registered agent, which resolves its own model.
	 * The stream route has always accepted this field — only the Loom client
	 * never sent it.
	 */
	modelOverride?: string | null;
	enabledMcpConfigIds?: string[] | null;
	/** Picker-selected instances restrict MCP access even when they have no bindings. */
	restrictInstanceMcpScope?: boolean;
	enabledFabricToolIds?: string[] | null;
	/** Agent template instance ID (for tracking/persistence) */
	instanceId?: string;
	/** Chat ID for RAG context retrieval */
	chatId?: string;
	/** Initial messages to seed the conversation (e.g., from history) */
	initialMessages?: DirectStreamMessage[];
	/** Workspace IDs for workspace document RAG retrieval */
	workspaceIds?: string[];
	/** Optional document IDs to scope workspace retrieval to */
	workspaceDocumentIds?: string[];
	/** Explicit project context; undefined uses the instance default, null clears it. */
	projectId?: string | null;
	/**
	 * Repository the chat was launched from; the default scope of the
	 * project's `code_search` when it is one of the project's repositories.
	 */
	repositoryUrl?: string | null;
	/**
	 * Focused entity the user is currently viewing (the page the agent was
	 * opened on). Forwarded to the backend so it grounds the agent on this
	 * item's FULL content (untruncated description / acceptance criteria / body).
	 */
	storyId?: string | null;
	documentId?: string | null;
	taskId?: string | null;
	/**
	 * Where the agent was opened, for tools that place what they create: the
	 * organization Workspace (a frame id), and whether the page is an artifact
	 * or workspace surface. A default, never a grant.
	 */
	launchWorkspaceId?: string | null;
	launchFrameId?: string | null;
	launchSurface?: "artifact" | "workspace" | null;
	/** Conversation ID - backend will fetch attached workspaces if workspaceIds not provided */
	conversationId?: string | null;
	/** Custom system prompt to pass to the workflow */
	systemPrompt?: string;
	/**
	 * Surface that mounts this hook — used purely for telemetry and to
	 * distinguish the launcher from the standalone Loom Direct page in
	 * the `ai_generation_cancelled` event payload.
	 */
	surface?: "fabric-agent-launcher" | "loom-direct";
	/**
	 * Invoked when the fire-and-forget cancel POST receives a non-2xx
	 * response. The consumer typically surfaces a non-blocking toast —
	 * the visual state of the message does NOT revert (decision 11 /
	 *).
	 */
	onStopFailed?: () => void;
	/**
	 * Generic analytics hook fired when the SSE stream surfaces a
	 * tracking-only event whose only job is to call
	 * `useAnalytics.trackEvent`. Today this is the two managed-default
	 * MCP analytics events:
	 * - `"mcp_default_tool_invoked"`
	 * - `"mcp_default_tool_failed"`
	 * Payload shape is opaque to the hook — it forwards whatever the
	 * server sent. The consumer (`CopilotPage.tsx`) maps the event name
	 * + payload to `trackEvent(name, payload)`. This indirection keeps
	 * the analytics provider out of the hook (the hook stays usable in
	 * tests without mocking `useAnalytics`) and avoids a circular
	 * dependency between the AI module and the analytics module.
	 */
	onAnalyticsEvent?: (
		eventName: string,
		payload: Record<string, unknown>,
	) => void;
}

/** Source information for RAG citations */
interface DirectStreamSource {
	id: string;
	title: string;
	type: "document" | "web" | "other";
	excerpt?: string;
	similarity?: number;
	metadata?: Record<string, unknown>;
}

export interface DirectStreamMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: Date;
	toolCalls?: Array<DirectStreamToolCall>;
	isStreaming?: boolean;
	isError?: boolean;
	/**
	 * Why the turn failed, kept apart from `content`: when part of the answer
	 * had already streamed, writing the error into `content` either lost the
	 * cause (content was kept) or the answer (content was replaced).
	 */
	errorMessage?: string;
	/** Provider limit behind the failure — renders the shared limit banner. */
	limit?: LimitSignal;
	/**
	 * Set when the tools failed and the answer came from the tools-off retry.
	 * `summary` is the first attempt's error, when the workflow passed one.
	 */
	toolsFailed?: { summary?: string };
	/**
	 * The answer stopped on a limit rather than finishing: the output-token
	 * ceiling (`output_limit`) or the step cap (`step_limit`). The chat says
	 * so under the answer and offers to continue (review F25).
	 */
	truncated?: ChatTurnTruncation;
	/**
	 * The turn ran on the organization's API billing because every ChatGPT
	 * plan was spent (Fizzy #3048); the chat says so under the answer.
	 */
	apiBilling?: ChatGptPlanApiBilling;
	/** The approval a tool in this message asked for, if any */
	pendingConfirmation?: ChatConfirmationRequest | WorkflowConfirmation;
	/** RAG sources used to generate the response */
	sources?: DirectStreamSource[];
	/**
	 * Token usage and model of the turn that produced this assistant
	 * message. Persisted in the message's metadata so the context meter
	 * can be restored when the conversation is reopened.
	 */
	usage?: TokenUsage;
	model?: StreamModelInfo;
	/**
	 * Filenames of documents/images attached when the user sent this
	 * message. Rendered as a discreet caption beneath the user bubble
	 * (paperclip + filename, no border, no background) — same visual
	 * pattern as `CopilotUserMessage` on the AI Feature Assistant /
	 * DocumentEditor surfaces. Optional and absent on messages loaded
	 * from older persisted history; the renderer skips gracefully.
	 */
	attachmentNames?: string[];
	/**
	 * Stream lifecycle status carried alongside the message body for
	 * persistence and inline rendering. Defaults to undefined for older
	 * persisted entries; renderers should treat undefined as
	 * `"completed"` for assistant messages and as no-op for user
	 * messages. See `specs/2026-05-09-stop-ai-generation/spec.md` § 5.1.
	 */
	streamStatus?: StreamStatus;
	/** ISO timestamp stamped when the user halted this assistant turn. */
	cancelledAt?: string;
	/**
	 * Temporal workflow id of the underlying `directChatWorkflow`. Stored
	 * on the assistant message so `stop` can fire the cancel POST
	 * against the correct workflow even after the SSE reader has been
	 * torn down by the abort.
	 */
	executionId?: string;
	/**
	 * Natural-language reasoning text the model emitted before answering.
	 * Populated for models that support extended_thinking (Claude 3.7+) or
	 * native reasoning (o-series, Gemini 2.5, DeepSeek R1). Undefined for
	 * older messages and for models without reasoning capability.
	 */
	reasoningText?: string;
	/**
	 * Duration of the reasoning phase in milliseconds. Set when the server
	 * emits a reasoningDuration event. Used to render "Thought for X.Ys".
	 */
	reasoningDurationMs?: number;
	/**
	 * Transient phase caption for the in-flight assistant turn (e.g.
	 * "Gathering context…", "Executing AI…"), set from `progress` SSE events.
	 * Rendered in place of the static "AI is thinking…" spinner while the
	 * message has no content yet, so a long run shows live feedback. Not
	 * persisted — only meaningful while `isStreaming` is true.
	 */
	statusLabel?: string;
}

export interface DirectStreamToolCall {
	id: string;
	name: string;
	args: unknown;
	result?: unknown;
	serverName?: string;
	status: "pending" | "running" | "complete" | "error";
	/**
	 * Why this is separate from `result`: a tool that never ran has no
	 * result to explain itself with, so the card needs somewhere else to
	 * read its message from or it renders an empty red box.
	 */
	error?: string;
	/** MCP App: ui:// resource URI for the interactive HTML UI */
	mcpAppResourceUri?: string;
	/** MCP App: config ID for proxying tool calls back to the MCP server */
	mcpAppConfigId?: string;
}

/** What one send adds to the message and the conversation it continues. */
export interface DirectSendOptions {
	/** Start a fresh chat rather than continuing the transcript on screen. */
	forceNewChat?: boolean;
	/** IDs of documents attached to this message. */
	attachedDocumentIds?: string[];
	/** Chat ID for RAG context (from a document upload). */
	messageChatId?: string;
	/**
	 * Messages to prepend when the stream is empty but a saved conversation was
	 * loaded.
	 */
	existingMessages?: DirectStreamMessage[];
	/**
	 * Filenames of documents/images attached, surfaced as a caption beneath the
	 * user bubble (telemetry-only on the wire: the agent reads attachments via
	 * `attachedDocumentIds` and RAG, not this list).
	 */
	attachmentNames?: string[];
	/**
	 * Finished envelope entries for files attached this turn, from
	 * `buildAiChatAttachmentEntry`. Delivered alongside `attachedDocumentIds`
	 * rather than instead of them: retrieval still runs and still covers what a
	 * bound cut.
	 */
	inlineAttachmentContexts?: string[];
	/**
	 * A call the person approved in a chat card: the tool and the exact
	 * arguments the card showed. The turn runs it first and goes on from its
	 * result.
	 */
	approvedToolCall?: {
		toolName: string;
		args: Record<string, unknown>;
	};
}

export interface DirectStreamState {
	status: "idle" | "streaming" | "completed" | "error" | "cancelled";
	error?: string;
}

export interface TokenUsage {
	/** Input/prompt tokens */
	inputTokens?: number;
	/** Output/completion tokens */
	outputTokens?: number;
	/** Total tokens (input + output) */
	totalTokens?: number;
	/** Reasoning tokens (for reasoning models like o1) */
	reasoningTokens?: number;
	/** Cached input tokens */
	cachedInputTokens?: number;
}

/** The model that answered the last turn, as reported by the stream. */
export interface StreamModelInfo {
	viaPlan?: boolean;
	id: string;
	canonicalName?: string;
	provider?: string;
	contextWindow?: number;
}

export interface ContextInfo {
	/** Estimated token count of the context (history + system prompt) */
	estimatedTokens: number;
	/** Number of messages in history */
	messageCount: number;
	/** Whether context was compacted/truncated */
	wasCompacted: boolean;
	/**
	 * The model's context window. The catalog value for the model that
	 * answered the last turn when the stream reports one, else a default.
	 */
	maxTokens: number;
	/**
	 * Token usage of the LAST turn. Its input count is the whole prompt the
	 * model saw (history, system prompt, tools), so this is the size of the
	 * current context, not a running sum of every turn.
	 */
	usage?: TokenUsage;
	/** Provider model string of the model that answered the last turn. */
	modelId?: string;
	/** Display name for that model. */
	modelLabel?: string;
}

export {
	applyReasoningDelta,
	applyReasoningDuration,
	applyToolResult,
} from "../lib/direct-stream-events";

export function useDirectStream(options: UseDirectStreamOptions = {}) {
	const {
		organizationId,
		reasoningMode = "balanced",
		modelOverride,
		enabledMcpConfigIds = null,
		restrictInstanceMcpScope = false,
		enabledFabricToolIds = null,
		instanceId,
		chatId,
		initialMessages,
		workspaceIds,
		workspaceDocumentIds,
		projectId,
		repositoryUrl,
		storyId,
		documentId,
		taskId,
		launchWorkspaceId,
		launchFrameId,
		launchSurface,
		conversationId,
		systemPrompt,
		surface = "loom-direct",
		onStopFailed,
		onAnalyticsEvent,
	} = options;

	// Keep refs to the latest option values used inside `stop` so that
	// changing them between renders does not require recreating the
	// callback (and so consumers can pass non-memoized lambdas).
	const surfaceRef = useRef(surface);
	surfaceRef.current = surface;
	const onStopFailedRef = useRef(onStopFailed);
	onStopFailedRef.current = onStopFailed;
	// Kept as a ref so the SSE-event switch (which closes over a stable
	// callback memoized by `useCallback([])`) always reads the latest
	// consumer-provided handler without resubscribing.
	const onAnalyticsEventRef = useRef(onAnalyticsEvent);
	onAnalyticsEventRef.current = onAnalyticsEvent;

	// Shared destructive toast for the AI_USAGE_LIMIT_EXCEEDED error
	// code. Captured in a ref so the
	// `sendMessage` callback (memoised below) does not have to recreate
	// when the translator identity changes.
	const showAiUsageLimitToast = useShowAiUsageLimitToast();
	const showAiUsageLimitToastRef = useRef(showAiUsageLimitToast);
	showAiUsageLimitToastRef.current = showAiUsageLimitToast;

	// Context token limits by model (conservative estimates)
	const MAX_CONTEXT_TOKENS = 100_000; // Conservative limit for most models

	// State - initialize with provided messages if any
	const [messages, setMessages] = useState<DirectStreamMessage[]>(
		initialMessages ?? [],
	);
	const [isLoading, setIsLoading] = useState(false);
	const [state, setState] = useState<DirectStreamState>({
		status: "idle",
	});
	const [contextInfo, setContextInfo] = useState<ContextInfo>({
		estimatedTokens: 0,
		messageCount: 0,
		wasCompacted: false,
		maxTokens: MAX_CONTEXT_TOKENS,
	});

	// Refs
	const abortControllerRef = useRef<AbortController | null>(null);
	const startFreshRef = useRef(false);
	// Track if we've initialized with initial messages
	const initializedRef = useRef(false);
	/**
	 * Becomes `true` after a tool event interrupts the assistant's text
	 * stream. The next `text` chunk prepends a paragraph break so
	 * pre-tool and post-tool text don't visibly merge (e.g.
	 * "pattern.Onion architecture.." with no separator). Cleared
	 * after the separator is applied. Lives in a ref because it's a
	 * transient stream-event boundary, not React state.
	 */
	const needsTextSeparatorRef = useRef(false);
	/**
	 * Freeze gate (decision 12 /). Once a message id is in this
	 * set, all subsequent SSE deltas for it are dropped on the floor —
	 * the user has clicked Stop and we honour that immediately even if
	 * the server keeps streaming for a moment.
	 */
	const cancelledMessageIdsRef = useRef<Set<string>>(new Set());
	/** Assistant message id → the error its turn ended with. */
	const erroredMessagesRef = useRef<Map<string, string>>(new Map());
	/**
	 * Wall-clock instant the most recent stream started, used to compute
	 * `latency_to_cancel_ms` for the telemetry event (spec section 10.1).
	 */
	const streamStartedAtRef = useRef<number | null>(null);
	/**
	 * Temporal workflow id of the in-flight stream (set on the `started`
	 * SSE event). Captured so `stop` can fire the cancel POST without
	 * re-deriving it from message state.
	 */
	const executionIdRef = useRef<string | null>(null);
	/**
	 * Id of the assistant message currently receiving deltas. `stop`
	 * uses this to flip the right entry to `cancelled` synchronously.
	 */
	const activeAssistantIdRef = useRef<string | null>(null);
	/**
	 * Mirror of `messages` so `stop` can read the latest content for
	 * `partial_token_count` telemetry without depending on stale closure
	 * state.
	 */
	const messagesRef = useRef<DirectStreamMessage[]>(initialMessages ?? []);

	/**
	 * Estimate token count for text (rough approximation: 4 chars ≈ 1 token)
	 */
	const estimateTokens = useCallback((text: string): number => {
		return Math.ceil(text.length / 4);
	}, []);

	/**
	 * Calculate context info from messages
	 */
	const calculateContextInfo = useCallback(
		(msgs: DirectStreamMessage[]): ContextInfo => {
			const estimatedTokens = Math.ceil(
				msgs.reduce((sum, m) => sum + estimateTokens(m.content), 0),
			);
			const wasCompacted = estimatedTokens > MAX_CONTEXT_TOKENS * 0.8; // Warn at 80%

			return {
				estimatedTokens: Math.ceil(
					msgs.reduce((sum, m) => sum + estimateTokens(m.content), 0),
				),
				messageCount: msgs.length,
				wasCompacted,
				maxTokens: MAX_CONTEXT_TOKENS,
			};
		},
		[estimateTokens],
	);

	/**
	 * Send a message and stream the response
	 * @param content - The message content
	 * @param history - Conversation history
	 * @param options - What this send adds: attachments, a chat to start fresh,
	 * the saved thread to show, or a call the person approved
	 */
	const sendMessage = useCallback(
		async (
			content: string,
			history: Array<{
				role: "user" | "assistant";
				content: string;
			}> = [],
			{
				forceNewChat = false,
				attachedDocumentIds,
				messageChatId,
				existingMessages,
				attachmentNames,
				inlineAttachmentContexts,
				approvedToolCall,
			}: DirectSendOptions = {},
		) => {
			if (!content.trim() || isLoading) {
				return null;
			}

			// Cancel any existing request
			abortControllerRef.current?.abort();
			abortControllerRef.current = new AbortController();
			const requestSignal = abortControllerRef.current.signal;

			// Check if we should start fresh
			const shouldStartFresh = forceNewChat || startFreshRef.current;
			startFreshRef.current = false;

			setIsLoading(true);
			setState({ status: "streaming" });
			// Reset per-stream refs used by `stop` and the cancel
			// telemetry payload — see spec section 5.3 + 10.1.
			executionIdRef.current = null;
			streamStartedAtRef.current = Date.now();

			// Create user message
			const userMessage: DirectStreamMessage = {
				id: `msg-${crypto.randomUUID()}`,
				role: "user",
				content: content.trim(),
				timestamp: new Date(),
				...(attachmentNames && attachmentNames.length > 0
					? { attachmentNames }
					: {}),
			};

			// Create placeholder assistant message
			const assistantMessage: DirectStreamMessage = {
				id: `msg-${crypto.randomUUID()}`,
				role: "assistant",
				content: "",
				timestamp: new Date(),
				isStreaming: true,
				toolCalls: [],
				streamStatus: "streaming",
			};
			activeAssistantIdRef.current = assistantMessage.id;

			// Add messages
			// CRITICAL: If existingMessages is provided, use it instead of prev
			// This fixes the React batching issue where seedMessages + setMessages
			// in the same render cycle causes the functional update to use stale state.
			// They win over a pending fresh start: opening a saved conversation
			// resets the stream (arming the fresh start) and then hands its thread
			// in here on the first send. Starting fresh dropped that thread from
			// the screen while the history still carried it to the model.
			if (existingMessages && existingMessages.length > 0) {
				setMessages([
					...existingMessages,
					userMessage,
					assistantMessage,
				]);
			} else if (shouldStartFresh) {
				setMessages([userMessage, assistantMessage]);
			} else {
				setMessages((prev) => [...prev, userMessage, assistantMessage]);
			}

			try {
				// Use messageChatId if provided (from document upload), otherwise use default chatId
				const effectiveChatId = messageChatId || chatId;
				const agentConfig = instanceId
					? await loadInstanceAgentConfig(instanceId, organizationId)
					: null;
				requestSignal.throwIfAborted();

				const response = await fetch("/api/agents/fabric-ai/stream", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						message: content.trim(),
						history: trimHistoryForRequest(
							history.map((m) => ({
								role: m.role,
								content: m.content,
							})),
						),
						organizationId,
						reasoningMode,
						modelOverride,
						enabledMcpConfigIds:
							agentConfig &&
							(restrictInstanceMcpScope ||
								agentConfig.hasMcpConfiguration)
								? agentConfig.enabledMcpConfigIds
								: enabledMcpConfigIds,
						enabledFabricToolIds:
							agentConfig?.enabledFabricToolIds ??
							enabledFabricToolIds,
						instanceId,
						chatId: effectiveChatId,
						attachedDocumentIds,
						inlineAttachmentContexts,
						workspaceIds,
						workspaceDocumentIds,
						projectId:
							projectId !== undefined
								? projectId
								: agentConfig?.boundProjectId,
						repositoryUrl,
						storyId,
						documentId,
						taskId,
						workspaceId: launchWorkspaceId ?? undefined,
						launchFrameId: launchFrameId ?? undefined,
						surface: launchSurface ?? undefined,
						approvedToolCall,
						// Pass conversation ID so backend can fetch attached workspaces if needed
						conversationId,
						systemPrompt:
							systemPrompt ??
							agentConfig?.instructions ??
							undefined,
					}),
					signal: requestSignal,
				});

				if (!response.ok) {
					const error = await response.json();
					// AI usage-limit short-circuit. The stream route emits a
					// 429 with `code: "AI_USAGE_LIMIT_EXCEEDED"` and a
					// structured `data` payload when the chokepoint blocks
					// before the SSE stream starts. Surface the shared
					// destructive toast and drop the placeholder assistant
					// message — the toast is the single source of truth for
					// the block; nothing should appear in the chat transcript.
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
						setMessages((prev) =>
							prev.filter((m) => m.id !== assistantMessage.id),
						);
						setIsLoading(false);
						setState({ status: "idle" });
						return;
					}
					// Every ChatGPT plan serving the member is spent (Fizzy
					// #2770): the turn says until when; the app's fetch
					// interceptor raises the toast and any billing switch.
					if (isChatGptPlanSpentCode(error?.code)) {
						throw new Error(
							describeAiError(response.status, error).description,
						);
					}
					// `message` carries the specifics (the rate limiter's
					// "try again in N seconds"); `error` is only the category.
					throw new Error(
						error?.message ||
							error?.error ||
							"Failed to stream response",
					);
				}

				const apiBilling = readChatGptPlanApiBilling(response);
				if (apiBilling) {
					setMessages((prev) =>
						prev.map((m) =>
							m.id === assistantMessage.id
								? { ...m, apiBilling }
								: m,
						),
					);
				}

				if (!response.body) {
					throw new Error("No response body");
				}
				let usageLimitReached = false;
				await readDirectStream(response.body, (event) => {
					if (
						event.type === "error" &&
						event.code === "AI_USAGE_LIMIT_EXCEEDED"
					) {
						usageLimitReached = true;
					}
					handleStreamEvent(event, assistantMessage.id);
				});

				// Mark streaming complete — but never overwrite a message
				// the user has already cancelled (decision 12 /), and never
				// turn a failed turn back into a completed one: the route
				// closes the stream right after its `error` event.
				if (
					!usageLimitReached &&
					!cancelledMessageIdsRef.current.has(assistantMessage.id)
				) {
					const failure = erroredMessagesRef.current.get(
						assistantMessage.id,
					);
					setMessages((prev) =>
						prev.map((m) =>
							m.id === assistantMessage.id
								? {
										...m,
										isStreaming: false,
										streamStatus: failure
											? "error"
											: "completed",
										toolCalls: settleUnfinishedToolCalls(
											m.toolCalls,
										),
									}
								: m,
						),
					);
					setState(
						failure
							? { status: "error", error: failure }
							: { status: "completed" },
					);
				}
			} catch (error) {
				if ((error as Error).name === "AbortError") {
					// `stop` aborted the request. The synchronous flip
					// already set the message to `cancelled` and the state
					// to `cancelled` — do not overwrite it here.
					if (
						!cancelledMessageIdsRef.current.has(assistantMessage.id)
					) {
						setState({ status: "idle" });
					}
				} else {
					const errorMessage =
						error instanceof Error
							? error.message
							: "Stream failed";
					// Update assistant message with error — but only if the
					// user has not already cancelled it (the freeze gate).
					if (
						!cancelledMessageIdsRef.current.has(assistantMessage.id)
					) {
						erroredMessagesRef.current.set(
							assistantMessage.id,
							errorMessage,
						);
						setMessages((prev) =>
							prev.map((m) =>
								m.id === assistantMessage.id
									? {
											...m,
											errorMessage,
											isStreaming: false,
											isError: true,
											streamStatus: "error",
											toolCalls:
												settleUnfinishedToolCalls(
													m.toolCalls,
												),
										}
									: m,
							),
						);
						setState({ status: "error", error: errorMessage });
					}
				}
			} finally {
				if (!cancelledMessageIdsRef.current.has(assistantMessage.id)) {
					setIsLoading(false);
				}
			}

			return assistantMessage.id;
		},
		[
			isLoading,
			organizationId,
			reasoningMode,
			modelOverride,
			enabledMcpConfigIds,
			restrictInstanceMcpScope,
			enabledFabricToolIds,
			instanceId,
			chatId,
			workspaceIds,
			projectId,
			repositoryUrl,
			launchWorkspaceId,
			launchFrameId,
			launchSurface,
			conversationId,
			systemPrompt,
		],
	);

	/**
	 * Handle incoming SSE events
	 */
	const handleStreamEvent = useCallback(
		(data: DirectStreamEvent, assistantMessageId: string) => {
			applyDirectStreamEvent(data, assistantMessageId, {
				setMessages,
				setState,
				setContextInfo,
				cancelledMessageIdsRef,
				erroredMessagesRef,
				needsTextSeparatorRef,
				executionIdRef,
				onAnalyticsEventRef,
				showAiUsageLimitToastRef,
			});
		},
		[],
	);

	/**
	 * Stop the current generation.
	 * Per spec section 8.2 / decisions 11+12+19:
	 * 1. Synchronous, optimistic UI flip — the message is marked
	 * `cancelled`, `isLoading` clears, the input is immediately
	 * ready for a new prompt. There is no `Stopping…` interstitial.
	 * 2. The message id is added to a freeze gate so subsequent SSE
	 * deltas for it are dropped client-side.
	 * 3. The cancel POST to the new direct-chat cancel route is
	 * fire-and-forget — the UI does not depend on its outcome.
	 * 4. On non-2xx, the optionally-supplied `onStopFailed` callback
	 * fires so the consumer can show a non-blocking toast. The
	 * visual state does NOT revert (/ decision 11).
	 * @param triggeredBy - whether this stop came from the morph button
	 * click or the Esc keybinding. Threaded into telemetry.
	 * @param messageId - target message id (defaults to the active
	 * assistant message captured during `sendMessage`).
	 */
	const stop = useCallback(
		(triggeredBy: "button" | "esc" = "button", messageId?: string) => {
			const targetId = messageId ?? activeAssistantIdRef.current;
			if (!targetId) {
				// No active assistant message — `stop` is a no-op.
				return;
			}
			if (cancelledMessageIdsRef.current.has(targetId)) {
				// Idempotent: clicking Stop twice does nothing the second
				// time. Telemetry only fires for the first click.
				return;
			}

			// 1. Synchronous flip (zero-latency).
			cancelledMessageIdsRef.current.add(targetId);
			abortControllerRef.current?.abort();

			const cancelledAt = new Date().toISOString();
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
			setIsLoading(false);
			setState({ status: "cancelled" });

			// 2. Snapshot telemetry inputs BEFORE we call into network so
			// we capture latency and partial body length at click-time.
			const startedAt = streamStartedAtRef.current;
			const latencyMs =
				startedAt !== null ? Math.max(0, Date.now() - startedAt) : 0;
			const executionId = executionIdRef.current;
			// Length of the partial body — the assistant message content
			// at click-time. Read from state via a microtask to keep this
			// callback synchronous; safe because we already captured the
			// id.
			const partialBody =
				messagesRef.current.find((m) => m.id === targetId)?.content ??
				"";
			const partialTokenCount = Math.ceil(partialBody.length / 4);

			// 3. Telemetry (pure side effect, never throws).
			emitCancelEvent({
				surface: surfaceRef.current,
				agentId: null,
				executionId: executionId ?? null,
				partial_token_count: partialTokenCount,
				latency_to_cancel_ms: latencyMs,
				triggered_by: triggeredBy,
			});

			// 4. Fire-and-forget cancel POST. We only inspect the result
			// to detect failure for the toast — the UI does not wait.
			if (executionId) {
				void fetch("/api/agents/fabric-ai/stream/cancel", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ executionId }),
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
		},
		[],
	);

	/**
	 * Backward-compat alias — `cancel` now routes through `stop`.
	 * Existing callers that destructure `cancel` from this hook continue
	 * to work; new code should use `stop`.
	 */
	const cancel = useCallback(() => {
		stop("button");
	}, [stop]);

	/**
	 * Reset for new chat
	 */
	const reset = useCallback(() => {
		abortControllerRef.current?.abort();
		setMessages([]);
		setIsLoading(false);
		setState({ status: "idle" });
		startFreshRef.current = true;
		cancelledMessageIdsRef.current = new Set();
		erroredMessagesRef.current = new Map();
		streamStartedAtRef.current = null;
		executionIdRef.current = null;
		activeAssistantIdRef.current = null;
	}, []);

	/**
	 * Seed messages with existing history
	 * Used when loading a conversation from history or when messages
	 * exist in the parent component that need to be synced to the hook
	 */
	const seedMessages = useCallback(
		(existingMessages: DirectStreamMessage[]) => {
			setMessages(existingMessages);
			setContextInfo(calculateContextInfo(existingMessages));
			messagesRef.current = existingMessages;
			initializedRef.current = true;
		},
		[calculateContextInfo],
	);

	// Update context info when messages change
	useEffect(() => {
		// Estimates follow the messages; the reported usage, window and
		// model come from the stream and must survive this recalculation.
		setContextInfo((prev) => ({
			...calculateContextInfo(messages),
			usage: prev.usage,
			maxTokens: prev.usage ? prev.maxTokens : MAX_CONTEXT_TOKENS,
			modelId: prev.modelId,
			modelLabel: prev.modelLabel,
		}));
		messagesRef.current = messages;
	}, [messages, calculateContextInfo]);

	/**
	 * Seed the context meter from persisted history: the usage and model
	 * stored with the last assistant message of a reopened conversation.
	 */
	const restoreContextUsage = useCallback(
		(usage?: TokenUsage, model?: StreamModelInfo) => {
			setContextInfo((prev) => ({
				...prev,
				usage,
				maxTokens: model?.contextWindow ?? MAX_CONTEXT_TOKENS,
				modelId: model?.id,
				modelLabel: model?.canonicalName ?? model?.id,
			}));
		},
		[],
	);

	return {
		// State
		messages,
		isLoading,
		state,
		contextInfo,

		// Actions
		sendMessage,
		/**
		 * Stop the in-flight generation. Canonical name from
		 * `specs/2026-05-09-stop-ai-generation/`. Use this in new code.
		 */
		stop,
		/**
		 * Backward-compat alias — equivalent to `stop("button")`. Kept so
		 * existing destructurers continue to compile while the UI groups
		 * migrate to the morph button + Esc binding.
		 */
		cancel,
		reset,
		seedMessages,
		restoreContextUsage,

		// Computed
		isStreaming: state.status === "streaming",
		isComplete: state.status === "completed" || state.status === "error",
	};
}
