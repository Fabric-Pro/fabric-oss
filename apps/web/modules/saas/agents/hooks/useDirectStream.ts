"use client";

/**
 * useDirectStream
 * React hook for streaming Direct mode chat responses via SSE.
 * Provides real-time text streaming and tool call visualization.
 * This is a simpler alternative to useOrchestratorStream for direct
 * MCP tool execution without Temporal workflow orchestration.
 */

import {
	isAiUsageLimitExceededPayload,
	useShowAiUsageLimitToast,
} from "@saas/payments/lib/ai-usage-limit-toast";
import { useCallback, useEffect, useRef, useState } from "react";
import { emitCancelEvent } from "../lib/cancel-telemetry";

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
	/** Attached project ID for project-aware context retrieval */
	projectId?: string | null;
	/**
	 * Focused entity the user is currently viewing (the page the agent was
	 * opened on). Forwarded to the backend so it grounds the agent on this
	 * item's FULL content (untruncated description / acceptance criteria / body).
	 */
	storyId?: string | null;
	documentId?: string | null;
	taskId?: string | null;
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
	/** Pending confirmation for workflow execution */
	pendingConfirmation?: {
		workflowId: string;
		workflowName: string;
		description?: string;
		message: string;
	};
	/** RAG sources used to generate the response */
	sources?: DirectStreamSource[];
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

export interface DirectStreamState {
	status: "idle" | "streaming" | "completed" | "error" | "cancelled";
	error?: string;
}

interface TokenUsage {
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

export interface ContextInfo {
	/** Estimated token count of the context (history + system prompt) */
	estimatedTokens: number;
	/** Number of messages in history */
	messageCount: number;
	/** Whether context was compacted/truncated */
	wasCompacted: boolean;
	/** Maximum context tokens before compaction */
	maxTokens: number;
	/** Actual token usage from API (accumulated across messages) */
	usage?: TokenUsage;
}

/**
 * Pure reducer: appends `delta` to the active assistant message's
 * reasoningText. The "active" assistant message is identified by id —
 * matching the same approach as the existing `case "text":` branch.
 */
export function applyReasoningDelta(
	messages: DirectStreamMessage[],
	assistantMessageId: string,
	delta: string,
): DirectStreamMessage[] {
	return messages.map((m) => {
		if (m.id !== assistantMessageId) {
			return m;
		}
		return {
			...m,
			reasoningText: (m.reasoningText ?? "") + delta,
		};
	});
}

/**
 * Pure reducer: settles a tool call when its `tool_result` event arrives.
 *
 * `error` is carried separately from `result` on purpose. A tool that never
 * ran has no output to explain itself with — the direct-chat activity settles
 * such a call with an error string and no result (Fizzy #2040) — and the card
 * renders `error` first, falling back to `result`. Dropping `error` anywhere
 * along the path leaves the user with a red "Error" heading over an empty
 * box, which is what a real staging run produced.
 */
export function applyToolResult(
	messages: DirectStreamMessage[],
	assistantMessageId: string,
	event: {
		toolCallId?: string;
		name?: string;
		toolName?: string;
		result?: unknown;
		status?: string;
		error?: string;
		mcpAppResourceUri?: string;
		mcpAppConfigId?: string;
	},
): DirectStreamMessage[] {
	const resultToolName = event.name || event.toolName;
	return messages.map((m) => {
		if (m.id !== assistantMessageId) {
			return m;
		}
		const updatedToolCalls = (m.toolCalls || []).map((tc) =>
			tc.id === event.toolCallId || tc.name === resultToolName
				? {
						...tc,
						result: event.result,
						status:
							event.status === "error"
								? ("error" as const)
								: ("complete" as const),
						error: event.error ?? tc.error,
						mcpAppResourceUri: event.mcpAppResourceUri,
						mcpAppConfigId: event.mcpAppConfigId,
					}
				: tc,
		);

		let pendingConf = m.pendingConfirmation;
		if (
			event.result &&
			typeof event.result === "object" &&
			"requiresConfirmation" in event.result &&
			(event.result as { requiresConfirmation?: boolean })
				.requiresConfirmation
		) {
			const conf = event.result as unknown as {
				workflowId: string;
				workflowName: string;
				description?: string;
				message: string;
			};
			pendingConf = {
				workflowId: conf.workflowId,
				workflowName: conf.workflowName,
				description: conf.description,
				message: conf.message,
			};
		}

		return {
			...m,
			toolCalls: updatedToolCalls,
			pendingConfirmation: pendingConf,
		};
	});
}

/**
 * Pure reducer: sets reasoningDurationMs on the identified message.
 */
export function applyReasoningDuration(
	messages: DirectStreamMessage[],
	assistantMessageId: string,
	durationMs: number,
): DirectStreamMessage[] {
	return messages.map((m) => {
		if (m.id !== assistantMessageId) {
			return m;
		}
		return { ...m, reasoningDurationMs: durationMs };
	});
}

export function useDirectStream(options: UseDirectStreamOptions = {}) {
	const {
		organizationId,
		reasoningMode = "balanced",
		modelOverride,
		enabledMcpConfigIds = null,
		enabledFabricToolIds = null,
		instanceId,
		chatId,
		initialMessages,
		workspaceIds,
		workspaceDocumentIds,
		projectId,
		storyId,
		documentId,
		taskId,
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
	 * @param forceNewChat - Whether to start a fresh chat
	 * @param attachedDocumentIds - IDs of documents attached to this message
	 * @param messageChatId - Chat ID for RAG context (from document upload)
	 * @param existingMessages - Existing messages to prepend (for when streamMessages is empty but we have loaded history)
	 * @param attachmentNames - Filenames of documents/images attached, surfaced as a caption beneath the user bubble (telemetry-only on the wire — the agent reads attachments via `attachedDocumentIds` + RAG, not this list)
	 */
	const sendMessage = useCallback(
		async (
			content: string,
			history: Array<{
				role: "user" | "assistant";
				content: string;
			}> = [],
			forceNewChat = false,
			attachedDocumentIds?: string[],
			messageChatId?: string,
			existingMessages?: DirectStreamMessage[],
			attachmentNames?: string[],
			/**
			 * Finished envelope entries for files attached this turn, from
			 * `buildAiChatAttachmentEntry`. Delivered alongside
			 * `attachedDocumentIds` rather than instead of them: retrieval still
			 * runs and still covers what a bound cut.
			 */
			inlineAttachmentContexts?: string[],
		) => {
			if (!content.trim() || isLoading) {
				return null;
			}

			// Cancel any existing request
			abortControllerRef.current?.abort();
			abortControllerRef.current = new AbortController();

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
				id: `msg-${Date.now()}`,
				role: "user",
				content: content.trim(),
				timestamp: new Date(),
				...(attachmentNames && attachmentNames.length > 0
					? { attachmentNames }
					: {}),
			};

			// Create placeholder assistant message
			const assistantMessage: DirectStreamMessage = {
				id: `msg-${Date.now() + 1}`,
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
			// in the same render cycle causes the functional update to use stale state
			if (shouldStartFresh) {
				setMessages([userMessage, assistantMessage]);
			} else if (existingMessages && existingMessages.length > 0) {
				// Use explicit existing messages (avoids React batching issues)
				setMessages([
					...existingMessages,
					userMessage,
					assistantMessage,
				]);
			} else {
				setMessages((prev) => [...prev, userMessage, assistantMessage]);
			}

			try {
				// Use messageChatId if provided (from document upload), otherwise use default chatId
				const effectiveChatId = messageChatId || chatId;

				const response = await fetch("/api/agents/fabric-ai/stream", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						message: content.trim(),
						history: history.map((m) => ({
							role: m.role,
							content: m.content,
						})),
						organizationId,
						reasoningMode,
						modelOverride,
						enabledMcpConfigIds,
						enabledFabricToolIds,
						instanceId,
						chatId: effectiveChatId,
						attachedDocumentIds,
						inlineAttachmentContexts,
						workspaceIds,
						workspaceDocumentIds,
						projectId,
						storyId,
						documentId,
						taskId,
						// Pass conversation ID so backend can fetch attached workspaces if needed
						conversationId,
						systemPrompt,
					}),
					signal: abortControllerRef.current.signal,
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
					throw new Error(error.error || "Failed to stream response");
				}

				// Process SSE stream
				const reader = response.body?.getReader();
				if (!reader) {
					throw new Error("No response body");
				}

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
								handleStreamEvent(data, assistantMessage.id);
							} catch {
								// Skip malformed JSON
							}
						}
					}
				}

				// Mark streaming complete — but never overwrite a message
				// the user has already cancelled (decision 12 /).
				if (!cancelledMessageIdsRef.current.has(assistantMessage.id)) {
					setMessages((prev) =>
						prev.map((m) =>
							m.id === assistantMessage.id
								? {
										...m,
										isStreaming: false,
										streamStatus: "completed",
									}
								: m,
						),
					);
					setState({ status: "completed" });
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
						setMessages((prev) =>
							prev.map((m) =>
								m.id === assistantMessage.id
									? {
											...m,
											content:
												m.content ||
												`Error: ${errorMessage}`,
											isStreaming: false,
											isError: true,
											streamStatus: "error",
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
			enabledFabricToolIds,
			instanceId,
			chatId,
			workspaceIds,
			projectId,
			conversationId,
			systemPrompt,
		],
	);

	/**
	 * Handle incoming SSE events
	 */
	const handleStreamEvent = useCallback(
		(data: any, assistantMessageId: string) => {
			// Freeze gate (/ decision 12): once the user has clicked
			// Stop on this message, every subsequent SSE delta — text,
			// tool_input, tool_result, completed — is dropped on the floor
			// so the rendered partial does not advance after the visible
			// "Stopped" caption.
			if (cancelledMessageIdsRef.current.has(assistantMessageId)) {
				return;
			}

			switch (data.type) {
				case "started": {
					// Capture the Temporal workflow id so `stop` can
					// fire-and-forget the cancel POST against it.
					const incomingExecutionId =
						typeof data.executionId === "string"
							? data.executionId
							: undefined;
					if (incomingExecutionId) {
						executionIdRef.current = incomingExecutionId;
						setMessages((prev) =>
							prev.map((m) =>
								m.id === assistantMessageId
									? { ...m, executionId: incomingExecutionId }
									: m,
							),
						);
					}
					break;
				}

				case "text": {
					// Append text to message content. When a tool event
					// interrupted the previous text run, prepend a
					// paragraph break so the post-tool sentence doesn't
					// jam against the pre-tool sentence.
					const needsSeparator = needsTextSeparatorRef.current;
					if (needsSeparator) {
						needsTextSeparatorRef.current = false;
					}
					setMessages((prev) =>
						prev.map((m) => {
							if (m.id !== assistantMessageId) {
								return m;
							}
							const incoming = data.content || "";
							const separator =
								needsSeparator &&
								m.content.length > 0 &&
								!/\s$/.test(m.content) &&
								!/^\s/.test(incoming)
									? "\n\n"
									: "";
							return {
								...m,
								content: m.content + separator + incoming,
							};
						}),
					);
					break;
				}

				case "reasoning": {
					const incoming = data.content || "";
					if (incoming.length === 0) {
						break;
					}
					setMessages((prev) =>
						applyReasoningDelta(prev, assistantMessageId, incoming),
					);
					break;
				}

				case "reasoningDuration": {
					const durationMs = Number.isFinite(data.durationMs)
						? (data.durationMs as number)
						: undefined;
					if (durationMs === undefined) {
						break;
					}
					setMessages((prev) =>
						applyReasoningDuration(
							prev,
							assistantMessageId,
							durationMs,
						),
					);
					break;
				}

				case "tool_start": {
					// Tool call started - add to tool calls array
					// Note: Backend sends `toolName`, frontend uses `name`
					const toolName = data.name || data.toolName;
					// Guard: Skip tool calls without a name
					if (!toolName) {
						console.warn(
							"[DirectStream] Received tool_start without name:",
							data,
						);
						break;
					}
					// Boundary between pre-tool text and post-tool text:
					// arm the separator for the next `text` event.
					needsTextSeparatorRef.current = true;
					setMessages((prev) =>
						prev.map((m) => {
							if (m.id !== assistantMessageId) {
								return m;
							}
							const newToolCall: DirectStreamToolCall = {
								id: data.toolCallId || `tool-${Date.now()}`,
								name: toolName,
								args: data.args,
								serverName: data.serverName,
								status: data.status || "running",
								mcpAppResourceUri: data.mcpAppResourceUri,
								mcpAppConfigId: data.mcpAppConfigId,
							};
							const existingToolCalls = m.toolCalls || [];
							const existingIndex = existingToolCalls.findIndex(
								(tc) => tc.id === newToolCall.id,
							);
							if (existingIndex >= 0) {
								return {
									...m,
									toolCalls: existingToolCalls.map(
										(tc, index) =>
											index === existingIndex
												? {
														...tc,
														...newToolCall,
														status: newToolCall.status,
													}
												: tc,
									),
								};
							}
							return {
								...m,
								toolCalls: [...existingToolCalls, newToolCall],
							};
						}),
					);
					break;
				}

				case "tool_input": {
					const inputToolName = data.name || data.toolName;
					if (!inputToolName) {
						break;
					}
					setMessages((prev) =>
						prev.map((m) => {
							if (m.id !== assistantMessageId) {
								return m;
							}
							const existingToolCalls = m.toolCalls || [];
							const existingIndex = existingToolCalls.findIndex(
								(tc) =>
									tc.id === data.toolCallId ||
									tc.name === inputToolName,
							);
							if (existingIndex < 0) {
								return {
									...m,
									toolCalls: [
										...existingToolCalls,
										{
											id:
												data.toolCallId ||
												`tool-${Date.now()}`,
											name: inputToolName,
											args: data.args,
											serverName: data.serverName,
											status: data.status || "pending",
											mcpAppResourceUri:
												data.mcpAppResourceUri,
											mcpAppConfigId: data.mcpAppConfigId,
										},
									],
								};
							}

							return {
								...m,
								toolCalls: existingToolCalls.map((tc, index) =>
									index === existingIndex
										? {
												...tc,
												args: data.args ?? tc.args,
												status:
													tc.status === "complete" ||
													tc.status === "error"
														? tc.status
														: (data.status ??
															tc.status),
												mcpAppResourceUri:
													data.mcpAppResourceUri ??
													tc.mcpAppResourceUri,
												mcpAppConfigId:
													data.mcpAppConfigId ??
													tc.mcpAppConfigId,
											}
										: tc,
								),
							};
						}),
					);
					break;
				}

				case "tool_result": {
					// Note: backend sends `toolName`, frontend uses `name`.
					setMessages((prev) =>
						applyToolResult(prev, assistantMessageId, data),
					);
					break;
				}

				case "progress": {
					// Surface the workflow/activity phase as a live caption on the
					// streaming assistant message so a long run shows feedback
					// ("Gathering context…", "Executing AI…") instead of a frozen
					// "AI is thinking…" spinner. Only meaningful pre-content; the
					// caption is replaced by the answer as soon as text arrives.
					const phaseLabel = data.message || data.phase;
					if (phaseLabel) {
						setMessages((prev) =>
							prev.map((m) =>
								m.id === assistantMessageId
									? { ...m, statusLabel: String(phaseLabel) }
									: m,
							),
						);
					}
					break;
				}

				case "error": {
					// AI usage-limit short-circuit. When the chokepoint
					// blocks mid-stream (e.g., from a tool-side AI call
					// after the stream has begun), the route emits a
					// structured SSE error event with
					// `code: "AI_USAGE_LIMIT_EXCEEDED"`. Surface the shared
					// destructive toast and drop the streaming placeholder
					// — the toast is the single source of truth; nothing
					// should appear in the chat transcript.
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
						setState({ status: "idle" });
						break;
					}
					// Error occurred
					setMessages((prev) =>
						prev.map((m) =>
							m.id === assistantMessageId
								? {
										...m,
										content:
											m.content ||
											`Error: ${data.message || "Unknown error"}`,
										isError: true,
									}
								: m,
						),
					);
					setState({ status: "error", error: data.message });
					break;
				}

				case "sources":
					// RAG sources received - attach to assistant message
					if (data.sources && Array.isArray(data.sources)) {
						setMessages((prev) =>
							prev.map((m) =>
								m.id === assistantMessageId
									? { ...m, sources: data.sources }
									: m,
							),
						);
					}
					break;

				case "mcp_default_tool_invoked":
				case "mcp_default_tool_failed": {
					// Tracking-only event forwarded straight to the consumer's
					// `useAnalytics.trackEvent`. The payload is opaque to
					// this hook (it never mutates message state), and the
					// consumer is responsible for the analytics provider
					// wire-up. If the consumer didn't supply a handler we
					// silently drop the event so the workflow can emit these
					// without coordinating with every call site.
					const handler = onAnalyticsEventRef.current;
					if (
						handler &&
						data.payload &&
						typeof data.payload === "object"
					) {
						handler(
							data.type,
							data.payload as Record<string, unknown>,
						);
					}
					break;
				}

				case "done":
					// Stream completed - capture token usage
					if (data.usage) {
						setContextInfo((prev) => {
							// Accumulate token usage across messages
							const prevUsage = prev.usage || {};
							const newUsage: TokenUsage = {
								inputTokens:
									(prevUsage.inputTokens || 0) +
									(data.usage.inputTokens || 0),
								outputTokens:
									(prevUsage.outputTokens || 0) +
									(data.usage.outputTokens || 0),
								totalTokens:
									(prevUsage.totalTokens || 0) +
									(data.usage.totalTokens || 0),
								reasoningTokens:
									(prevUsage.reasoningTokens || 0) +
									(data.usage.reasoningTokens || 0),
								cachedInputTokens:
									(prevUsage.cachedInputTokens || 0) +
									(data.usage.cachedInputTokens || 0),
							};
							return { ...prev, usage: newUsage };
						});
					}
					setState({ status: "completed" });
					break;

				default:
					console.log("[DirectStream] Unknown event:", data.type);
			}
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
		setContextInfo(calculateContextInfo(messages));
		messagesRef.current = messages;
	}, [messages, calculateContextInfo]);

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

		// Computed
		isStreaming: state.status === "streaming",
		isComplete: state.status === "completed" || state.status === "error",
	};
}
