"use client";

/**
 * useMultiAgentStream
 * Fires N parallel SSE connections simultaneously — one per selected agent.
 * Equivalent to Dust's runAgentLoopWorkflow which uses concurrentExecutor
 * to launch a separate agent_loop Temporal workflow per @mention.
 * When agents are selected: runs N direct-chat streams in parallel, each
 * attributed to the selected agent (uses agent name/description as system prompt).
 * Returns agentResponses — a Map<agentId, AgentResponse> updated in real-time
 * as each stream progresses independently.
 */

import {
	isAiUsageLimitExceededPayload,
	useShowAiUsageLimitToast,
} from "@saas/payments/lib/ai-usage-limit-toast";
import { useCallback, useEffect, useRef, useState } from "react";
import { emitCancelEvent } from "../lib/cancel-telemetry";

function isMcpDebugEnabled(): boolean {
	if (typeof window === "undefined") {
		return false;
	}

	try {
		return (
			window.localStorage.getItem("fabric:mcp-debug") === "1" ||
			window.sessionStorage.getItem("fabric:mcp-debug") === "1"
		);
	} catch {
		return false;
	}
}

export interface MultiAgentExecutionOptions {
	executionMode?: "lite" | "balanced" | "deep" | "planner";
	enabledAgentIds?: string[] | null;
	enabledMcpConfigIds?: string[] | null;
	enabledFabricToolIds?: string[] | null;
	enabledIntegrationIds?: string[] | null;
	attachedImageUrls?: string[];
	attachedDocumentIds?: string[];
	/**
	 * Finished envelope entries for files attached this turn, from
	 * `buildAiChatAttachmentEntry`. Unlike `attachmentNames` above, this DOES
	 * reach the model — it is the file's text, delivered whole, so the model
	 * does not depend on a chunk happening to rank in retrieval's top five.
	 * Additive to `attachedDocumentIds`, which drives that retrieval.
	 */
	inlineAttachmentContexts?: string[];
	chatId?: string;
	prioritizedToolIds?: string[];
	prioritizedAgentIds?: string[];
	/**
	 * Display-only filenames for the user message bubble caption. The
	 * agent reads attachments via `attachedDocumentIds` (RAG retrieval)
	 * and any future vision wiring; this list never reaches the model.
	 */
	attachmentNames?: string[];
	/**
	 * UI surface that initiated this stream — forwarded as-is to the
	 * orchestrator workflow input so surface-aware routing helpers
	 * (e.g. Nexus Excalidraw eager-load) can gate on it. Omitted from
	 * the wire body when undefined so non-opting callers send the same
	 * shape they always have.
	 */
	surface?:
		| "nexus"
		| "copilot"
		| "document-editor"
		| "agent-template"
		| "weave";
	/**
	 * Organization slug from the surface route — forwarded so the
	 * workflow can construct surface-specific deep links (e.g. the
	 * `/app/{slug}/mcp-servers` CTA emitted by the Nexus routing
	 * helper when Excalidraw isn't connected). Omitted when undefined.
	 */
	organizationSlug?: string;
	/**
	 * Optional `AgentConversation` ID. When the host
	 * surface (e.g. a CopilotPage variant backed by `AgentConversation`)
	 * provides one, EACH per-agent stream forwards it to the orchestrator
	 * workflow so the completion phase's Step 6 can append a persistent
	 * operation-result system message. Today's Nexus CopilotPage runs on
	 * `AiChat` and does NOT have a `conversationId` source — that surface
	 * passes `undefined` and Step 6 quietly no-ops, preserving current
	 * behaviour. Forwarded via the omit-when-undefined pattern below so
	 * non-opting callers send the exact wire shape they always have.
	 *
	 * NOTE on multi-agent dedup: if N agents run in parallel they each
	 * have a distinct `executionId`, so the `${executionId}-result`
	 * `operationKey` differs per agent and N completion messages land in
	 * the shared `AgentConversation` (one per agent). The single-thread
	 * dedup property is preserved: a retry of any one agent's workflow
	 * still hits the same key once.
	 */
	conversationId?: string;
}

export interface MultiAgentToolCall {
	id: string;
	name: string;
	args: unknown;
	result?: unknown;
	serverName?: string;
	status: "pending" | "running" | "complete" | "error" | "success";
	/** MCP App: ui:// resource URI for the interactive HTML UI */
	mcpAppResourceUri?: string;
	/** MCP App: config ID for proxying tool calls back to the MCP server */
	mcpAppConfigId?: string;
}

export interface AgentResponse {
	agentId: string;
	agentName: string;
	/** vendor name for model agents — used to show provider logo */
	vendor?: string;
	executionId?: string;
	content: string;
	toolCalls: MultiAgentToolCall[];
	isLoading: boolean;
	isError: boolean;
	/**
	 * Per-agent stream lifecycle status.
	 * `"cancelled"` is set by `stopAll` only on agents that were
	 * still in-flight at click-time. Already-`"completed"` agents in
	 * the same turn keep their status — they are not retroactively
	 * relabelled (decision 18 /).
	 * `extractResumableExecutions` in `CopilotPage.tsx` filters by
	 * `status === "streaming"` so cancelled agents are implicitly
	 * non-resumable on next page reload (/ decision 14).
	 */
	status: "idle" | "streaming" | "completed" | "error" | "cancelled";
	/** ISO timestamp stamped when this agent was cancelled. */
	cancelledAt?: string;
	/** Set when the orchestrator is waiting for user approval before proceeding */
	pendingApproval?: {
		approvalId: string;
		stepId: string;
		reason: string;
	} | null;
}

/**
 * The orchestrator's `buildWorkflowOutput` truncates oversized tool call
 * args/results to a sentinel string before returning the workflow output.
 * That sentinel can arrive on the `completed`/`step_complete` events
 * AFTER the live `tool_input`/`tool_result` events have already populated
 * the full payload. If we let it overwrite the live data, MCP App
 * iframes (e.g. Excalidraw) re-sync the truncated string to their bridge
 * and the canvas blanks. Reject the sentinel here as defense-in-depth —
 * the cap bump in `completion.ts` is the primary fix.
 */
function isTruncatedSentinel(value: unknown): boolean {
	return typeof value === "string" && value.startsWith("[Object truncated,");
}

function mergeToolCall(
	existingToolCalls: MultiAgentToolCall[],
	incoming: MultiAgentToolCall,
): MultiAgentToolCall[] {
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
						tc.status === "complete" ? tc.status : incoming.status,
					mcpAppResourceUri:
						incoming.mcpAppResourceUri ?? tc.mcpAppResourceUri,
					mcpAppConfigId:
						incoming.mcpAppConfigId ?? tc.mcpAppConfigId,
				}
			: tc,
	);
}

function mergeStreamedText(
	currentContent: string,
	incomingContent: unknown,
): string {
	if (typeof incomingContent !== "string" || incomingContent.length === 0) {
		return currentContent;
	}

	if (!currentContent) {
		return incomingContent;
	}

	if (incomingContent === currentContent) {
		return currentContent;
	}

	if (incomingContent.startsWith(currentContent)) {
		return incomingContent;
	}

	if (currentContent.startsWith(incomingContent)) {
		return currentContent;
	}

	const overlapLimit = Math.min(
		currentContent.length,
		incomingContent.length,
	);
	for (let overlap = overlapLimit; overlap > 0; overlap--) {
		if (
			currentContent.slice(-overlap) === incomingContent.slice(0, overlap)
		) {
			return currentContent + incomingContent.slice(overlap);
		}
	}

	return currentContent.length >= incomingContent.length
		? currentContent
		: incomingContent;
}

export interface ConversationTurn {
	id: string;
	userMessage: string;
	agentResponses: Map<string, AgentResponse>;
	timestamp: Date;
	/**
	 * Filenames of documents/images attached when the user sent this turn.
	 * Rendered as a discreet caption beneath the user bubble (paperclip +
	 * 11px filename, no border, no background) — the same pattern
	 * `CopilotUserMessage` uses on the AI Feature Assistant /
	 * DocumentEditor surfaces and `FabricDirectChat` uses on the floating
	 * Fabric Agent panel. Optional; turns rebuilt from older persisted
	 * history simply omit it.
	 */
	attachmentNames?: string[];
}

type ConversationHistory = Array<{
	role: "user" | "assistant";
	content: string;
}>;

type AgentHistoryResolver = (agent: {
	agentId: string;
	name: string;
	description?: string | null;
	instructions?: string | null;
	enabledMcpConfigIds?: string[] | null;
	modelOverride?: string;
	vendor?: string;
}) => ConversationHistory;

export function useMultiAgentStream({
	organizationId,
	onStopFailed,
	onAnalyticsEvent,
}: {
	organizationId?: string | null;
	/**
	 * Invoked once per agent whose fire-and-forget cancel POST returns
	 * non-2xx. The consumer typically debounces these into a single
	 * non-blocking toast (`Couldn't fully stop the response. Trailing
	 * tokens may still arrive.`). Visual state does NOT revert on
	 * failure (/ decision 11).
	 */
	onStopFailed?: () => void;
	/**
	 * Generic analytics hook — fires when the SSE stream surfaces a
	 * tracking-only event whose only job is to call
	 * `useAnalytics.trackEvent`. Today this is the two managed-default
	 * MCP analytics events:
	 * - `"mcp_default_tool_invoked"`
	 * - `"mcp_default_tool_failed"`
	 * Payload shape is opaque to the hook — it forwards whatever the
	 * server sent. The consumer (`CopilotPage.tsx`) maps the event name
	 * + payload to `trackEvent(name, payload)`. See the matching prop on
	 * `useDirectStream.ts` for rationale (analytics provider out of the
	 * hook, testability, no circular dependency on the analytics
	 * module).
	 */
	onAnalyticsEvent?: (
		eventName: string,
		payload: Record<string, unknown>,
	) => void;
} = {}) {
	const [turns, setTurns] = useState<ConversationTurn[]>([]);
	const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
	const currentTurnIdRef = useRef<string | null>(null);
	const textBufferRef = useRef<Map<string, string>>(new Map());

	// Shared destructive toast for the AI_USAGE_LIMIT_EXCEEDED error
	// code. Captured in a ref so the
	// memoised per-agent stream callbacks below don't have to recreate
	// when the translator identity changes.
	const showAiUsageLimitToast = useShowAiUsageLimitToast();
	const showAiUsageLimitToastRef = useRef(showAiUsageLimitToast);
	showAiUsageLimitToastRef.current = showAiUsageLimitToast;
	const textFlushTimeoutRef = useRef<
		Map<string, ReturnType<typeof setTimeout>>
	>(new Map());
	/**
	 * Per-response-key flag. Becomes `true` after a tool event interrupts
	 * the assistant's text stream; the next text delta on that response
	 * key prepends a paragraph break so the post-tool sentence doesn't
	 * jam against the pre-tool sentence (e.g. "pattern.Onion
	 * architecture.."). Cleared once the separator is applied. Per-key
	 * because we stream multiple agents in parallel and the boundary
	 * tracking has to be independent.
	 */
	const needsTextSeparatorRef = useRef<Map<string, boolean>>(new Map());
	/**
	 * Freeze gate keyed by `agentId` (decision 12 /). Once an
	 * agent is in this set, all subsequent SSE deltas for it are
	 * dropped client-side — the user has clicked Stop on the turn and
	 * we honour the visual state immediately.
	 */
	const cancelledAgentIdsRef = useRef<Set<string>>(new Set());
	/**
	 * Wall-clock instant the most recent turn's first stream started.
	 * Used to compute `latency_to_cancel_ms` for telemetry.
	 */
	const turnStartedAtRef = useRef<number | null>(null);
	/**
	 * Mirror of `turns` so `stopAll` can read the latest agent state
	 * without depending on stale closure state.
	 */
	const turnsRef = useRef<ConversationTurn[]>([]);
	const onStopFailedRef = useRef(onStopFailed);
	onStopFailedRef.current = onStopFailed;
	// Kept as a ref so the SSE-event switch (closed over a stable
	// callback) always sees the latest consumer-provided handler without
	// resubscribing.
	const onAnalyticsEventRef = useRef(onAnalyticsEvent);
	onAnalyticsEventRef.current = onAnalyticsEvent;

	const flushBufferedText = useCallback((responseKey: string) => {
		const pendingContent = textBufferRef.current.get(responseKey);
		if (!pendingContent) {
			textFlushTimeoutRef.current.delete(responseKey);
			return;
		}

		const [turnId, agentId] = responseKey.split("::");
		if (!turnId || !agentId) {
			textBufferRef.current.delete(responseKey);
			textFlushTimeoutRef.current.delete(responseKey);
			return;
		}

		textBufferRef.current.delete(responseKey);
		textFlushTimeoutRef.current.delete(responseKey);

		setTurns((prevTurns) =>
			prevTurns.map((turn) => {
				if (turn.id !== turnId) {
					return turn;
				}

				const current = turn.agentResponses.get(agentId);
				if (!current) {
					return turn;
				}

				const nextResponses = new Map(turn.agentResponses);
				nextResponses.set(agentId, {
					...current,
					content: current.content + pendingContent,
				});
				return { ...turn, agentResponses: nextResponses };
			}),
		);
	}, []);

	const queueTextDelta = useCallback(
		(responseKey: string, delta: string) => {
			if (!delta) {
				return;
			}

			// If a tool event recently interrupted this response's text
			// stream, insert a paragraph break before the first incoming
			// delta of the new text run. We bake the `\n\n` into the
			// buffer itself so the eventual `flushBufferedText` writes
			// it as part of the appended content — no separate plumbing
			// to keep in sync with the flush path.
			const currentBuffered =
				textBufferRef.current.get(responseKey) ?? "";
			let prefixedDelta = delta;
			if (needsTextSeparatorRef.current.get(responseKey)) {
				needsTextSeparatorRef.current.delete(responseKey);
				if (
					currentBuffered.length > 0 &&
					!/\s$/.test(currentBuffered) &&
					!/^\s/.test(delta)
				) {
					prefixedDelta = `\n\n${delta}`;
				} else if (currentBuffered.length === 0 && !/^\s/.test(delta)) {
					// First delta of a new buffered run after a tool —
					// rely on `flushBufferedText` having empty existing
					// content, so the separator must be in the delta.
					prefixedDelta = `\n\n${delta}`;
				}
			}
			textBufferRef.current.set(
				responseKey,
				currentBuffered + prefixedDelta,
			);

			if (textFlushTimeoutRef.current.has(responseKey)) {
				return;
			}

			const timeoutId = setTimeout(() => {
				flushBufferedText(responseKey);
			}, 50);
			textFlushTimeoutRef.current.set(responseKey, timeoutId);
		},
		[flushBufferedText],
	);

	const clearBufferedText = useCallback((responseKey: string) => {
		const timeoutId = textFlushTimeoutRef.current.get(responseKey);
		if (timeoutId) {
			clearTimeout(timeoutId);
			textFlushTimeoutRef.current.delete(responseKey);
		}
		textBufferRef.current.delete(responseKey);
		needsTextSeparatorRef.current.delete(responseKey);
	}, []);

	useEffect(() => {
		return () => {
			for (const timeoutId of textFlushTimeoutRef.current.values()) {
				clearTimeout(timeoutId);
			}
			textFlushTimeoutRef.current.clear();
			textBufferRef.current.clear();
			needsTextSeparatorRef.current.clear();
		};
	}, []);

	// Mirror `turns` into a ref so `stopAll` can read the latest
	// per-agent state synchronously.
	useEffect(() => {
		turnsRef.current = turns;
	}, [turns]);

	/**
	 * Stream from a single agent. Called concurrently for each selected agent.
	 * Fire-and-forget pattern (not awaited from sendToAgents).
	 */
	const streamFromAgent = useCallback(
		async (
			turnId: string,
			agent: {
				agentId: string;
				name: string;
				description?: string | null;
				/** Full instructions for template instances — overrides default system prompt */
				instructions?: string | null;
				/** MCP config IDs for template instances — overrides executionOptions value */
				enabledMcpConfigIds?: string[] | null;
				/** Workspace IDs for RAG scoping — agent's linked knowledge bases */
				workspaceIds?: string[];
				/** canonical model name — set when agent is a model (agentId starts with "model:") */
				modelOverride?: string;
				/** vendor name for model agents */
				vendor?: string;
				/** agent instance ID for memory loading */
				instanceId?: string;
				/** OAuth integration IDs this agent has access to (overrides executionOptions) */
				enabledIntegrationIds?: string[];
			},
			message: string,
			history: ConversationHistory,
			signal: AbortSignal,
			executionOptions?: MultiAgentExecutionOptions,
			resumeExecutionId?: string,
		) => {
			const updateResponse = (
				updater: (prev: AgentResponse) => AgentResponse,
			) => {
				setTurns((prevTurns) =>
					prevTurns.map((turn) => {
						if (turn.id !== turnId) {
							return turn;
						}
						const current = turn.agentResponses.get(agent.agentId);
						if (!current) {
							return turn;
						}
						const next = new Map(turn.agentResponses);
						next.set(agent.agentId, updater(current));
						return { ...turn, agentResponses: next };
					}),
				);
			};
			const debugLog = (
				message: string,
				data?: Record<string, unknown>,
			) => {
				if (!isMcpDebugEnabled()) {
					return;
				}
				console.info("[MultiAgentStream debug]", message, {
					turnId,
					agentId: agent.agentId,
					agentName: agent.name,
					...data,
				});
			};

			// Chatbot-specific formatting policy to keep responses compact and readable.
			const chatFormattingPolicy = `

Respond for a chat interface:
- Be concise by default.
- Avoid decorative emojis unless they are explicitly useful.
- Prefer short headings, or no headings, unless structure materially improves clarity.
- Use tables only when they clearly improve readability.
- Do not write like a blog post, essay, or newsletter unless asked.
`.trim();

			// Build system prompt: use full instructions if available (template instances),
			// otherwise fall back to a default prompt built from name + description
			const systemPrompt = agent.instructions
				? agent.instructions
				: agent.description
					? `You are ${agent.name}. ${agent.description}\n\n${chatFormattingPolicy}`
					: `You are ${agent.name}, an AI assistant.\n\n${chatFormattingPolicy}`;

			// Agent-level MCP configs take precedence over execution options
			const resolvedMcpConfigIds =
				agent.enabledMcpConfigIds !== undefined
					? agent.enabledMcpConfigIds
					: (executionOptions?.enabledMcpConfigIds ?? null);

			// For focused agents (specific MCP servers configured), default Fabric AI tools
			// to [] so only the agent's own MCP tools are available via search_tools.
			// Fabric tools (web search, RAG, file creation, etc.) are only added back when
			// the user explicitly enables a capability (e.g. discover-knowledge, web-search-browse).
			// General agents (null = all servers) keep full Fabric tool access.
			const isFocusedAgent =
				resolvedMcpConfigIds !== null &&
				resolvedMcpConfigIds.length > 0;

			// For focused agents, default to [] (no Fabric tools), but always include
			// workspace RAG tools if the agent has workspaces configured.
			// This ensures agents can query their own knowledge base even in focused mode.
			const RAG_TOOLS = [
				"workspace_rag_query",
				"workspace_rag_summarize",
			] as const;
			const baseFabricToolIds = isFocusedAgent
				? (executionOptions?.enabledFabricToolIds ?? [])
				: (executionOptions?.enabledFabricToolIds ?? null);
			const resolvedFabricToolIds: string[] | null = (() => {
				if (!isFocusedAgent) {
					return baseFabricToolIds as string[] | null;
				}
				// Focused agent: merge base tools with RAG tools if workspaces exist
				const base = Array.isArray(baseFabricToolIds)
					? baseFabricToolIds
					: [];
				const withRag =
					agent.workspaceIds && agent.workspaceIds.length > 0
						? [...new Set([...base, ...RAG_TOOLS])]
						: base;
				return withRag;
			})();

			try {
				const responseKey = `${turnId}::${agent.agentId}`;
				const response = await fetch(
					"/api/agents/fabric-ai/orchestrator-temporal/stream",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							message,
							history,
							executionId: resumeExecutionId,
							organizationId,
							modelOverride: agent.modelOverride,
							executionMode:
								executionOptions?.executionMode ?? "balanced",
							enabledAgentIds:
								executionOptions?.enabledAgentIds ?? [],
							enabledMcpConfigIds: resolvedMcpConfigIds,
							enabledFabricToolIds: resolvedFabricToolIds,
							enabledIntegrationIds:
								// Agent-level integration IDs take precedence over execution options
								agent.enabledIntegrationIds !== undefined
									? agent.enabledIntegrationIds
									: (executionOptions?.enabledIntegrationIds ??
										null),
							attachedImageUrls:
								executionOptions?.attachedImageUrls ?? [],
							attachedDocumentIds:
								executionOptions?.attachedDocumentIds ?? [],
							inlineAttachmentContexts:
								executionOptions?.inlineAttachmentContexts ??
								[],
							chatId: executionOptions?.chatId,
							prioritizedToolIds:
								executionOptions?.prioritizedToolIds,
							prioritizedAgentIds:
								executionOptions?.prioritizedAgentIds,
							workspaceIds: agent.workspaceIds ?? [],
							instanceId: agent.instanceId,
							systemPrompt,
							// Omit-when-undefined so non-opting callers
							// (doc-editor copilot, agent template runner,
							// Weave) send the same wire shape they always
							// have. Tested by the E2E "other-surface guard".
							...(executionOptions?.surface !== undefined
								? { surface: executionOptions.surface }
								: {}),
							...(executionOptions?.organizationSlug !== undefined
								? {
										organizationSlug:
											executionOptions.organizationSlug,
									}
								: {}),
							// See `conversationId` doc on
							// `MultiAgentExecutionOptions`. Same
							// omit-when-undefined contract as `surface` /
							// `organizationSlug` above so the wire shape on
							// today's CopilotPage Nexus surface
							// (`AgentConversation`-less) stays byte-identical
							// to pre-PR2. The orchestrator stream route
							// already accepts this field (PR1) so opt-in is
							// purely additive.
							...(executionOptions?.conversationId !== undefined
								? {
										conversationId:
											executionOptions.conversationId,
									}
								: {}),
						}),
						signal,
					},
				);

				if (!response.ok) {
					const err = await response
						.json()
						.catch(() => ({ error: "Stream failed" }));
					// AI usage-limit short-circuit. The per-agent stream calls Loom Direct
					// or the orchestrator under the hood; both return a
					// structured 429 with `code: "AI_USAGE_LIMIT_EXCEEDED"`
					// when the chokepoint blocks. Render the shared
					// destructive toast and reset to `idle` so the user
					// is not left with a generic error stub on this
					// agent's response card.
					if (err?.code === "AI_USAGE_LIMIT_EXCEEDED") {
						const payload = isAiUsageLimitExceededPayload(err?.data)
							? err.data
							: isAiUsageLimitExceededPayload(err)
								? err
								: null;
						if (payload) {
							showAiUsageLimitToastRef.current(payload);
						}
						updateResponse((prev) => ({
							...prev,
							isLoading: false,
							status: "idle",
						}));
						return;
					}
					updateResponse((prev) => ({
						...prev,
						isLoading: false,
						isError: true,
						status: "error",
						content:
							prev.content ||
							`Error: ${err.error || "Unknown error"}`,
					}));
					return;
				}

				const reader = response.body?.getReader();
				if (!reader) {
					updateResponse((prev) => ({
						...prev,
						isLoading: false,
						isError: true,
						status: "error",
					}));
					return;
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
					buffer = lines.pop() ?? "";

					for (const line of lines) {
						if (!line.startsWith("data: ")) {
							continue;
						}
						// Freeze gate (decision 12 /): once the user
						// has clicked Stop on the turn, every subsequent
						// SSE event for this agent is dropped on the
						// floor. The visible `Stopped` caption stays
						// honest even if the server keeps streaming.
						if (cancelledAgentIdsRef.current.has(agent.agentId)) {
							continue;
						}
						try {
							const data = JSON.parse(line.slice(6));
							switch (data.type) {
								case "started":
									updateResponse((prev) => ({
										...prev,
										executionId:
											typeof data.executionId === "string"
												? data.executionId
												: prev.executionId,
									}));
									break;
								case "text":
								case "text_delta":
									queueTextDelta(
										responseKey,
										typeof data.content === "string"
											? data.content
											: "",
									);
									break;
								case "tool_start": {
									const toolName = data.name ?? data.toolName;
									if (!toolName) {
										break;
									}
									debugLog("tool_start", {
										toolCallId: data.toolCallId,
										toolName,
										status: data.status,
										hasMcpApp:
											Boolean(data.mcpAppResourceUri) &&
											Boolean(data.mcpAppConfigId),
									});
									// Mark a text-segment boundary for this
									// response so the next text delta arriving
									// on the same key prepends a paragraph
									// break (avoids "pattern.Onion" sentence
									// merges across pre-tool / post-tool runs).
									needsTextSeparatorRef.current.set(
										responseKey,
										true,
									);
									updateResponse((prev) => ({
										...prev,
										toolCalls: mergeToolCall(
											prev.toolCalls,
											{
												id:
													data.toolCallId ??
													`tool-${Date.now()}`,
												name: toolName,
												args: data.args,
												serverName: data.serverName,
												status:
													(data.status as
														| "pending"
														| "running"
														| "complete"
														| "error") ?? "running",
												mcpAppResourceUri:
													data.mcpAppResourceUri,
												mcpAppConfigId:
													data.mcpAppConfigId,
											},
										),
									}));
									break;
								}
								case "tool_input": {
									const toolName = data.name ?? data.toolName;
									if (!toolName) {
										break;
									}
									debugLog("tool_input", {
										toolCallId: data.toolCallId,
										toolName,
										status: data.status,
										argKeys:
											data.args &&
											typeof data.args === "object"
												? Object.keys(
														data.args as Record<
															string,
															unknown
														>,
													)
												: [],
										serializedLength: (() => {
											try {
												return JSON.stringify(data.args)
													.length;
											} catch {
												return 0;
											}
										})(),
									});
									updateResponse((prev) => ({
										...prev,
										toolCalls: mergeToolCall(
											prev.toolCalls,
											{
												id:
													data.toolCallId ??
													`tool-${Date.now()}`,
												name: toolName,
												args: data.args,
												serverName: data.serverName,
												status:
													(data.status as
														| "pending"
														| "running"
														| "complete"
														| "error") ?? "pending",
												mcpAppResourceUri:
													data.mcpAppResourceUri,
												mcpAppConfigId:
													data.mcpAppConfigId,
											},
										),
									}));
									break;
								}
								case "tool_result": {
									const resultName =
										data.name ?? data.toolName;
									debugLog("tool_result", {
										toolCallId: data.toolCallId,
										toolName: resultName,
										status: data.status,
										hasMcpApp:
											Boolean(data.mcpAppResourceUri) &&
											Boolean(data.mcpAppConfigId),
									});
									updateResponse((prev) => ({
										...prev,
										toolCalls: resultName
											? mergeToolCall(prev.toolCalls, {
													id:
														data.toolCallId ??
														`tool-${Date.now()}`,
													name: resultName,
													args: data.args,
													result: data.result,
													serverName: data.serverName,
													status:
														data.status === "error"
															? "error"
															: "complete",
													mcpAppResourceUri:
														data.mcpAppResourceUri,
													mcpAppConfigId:
														data.mcpAppConfigId,
												})
											: prev.toolCalls,
									}));
									break;
								}
								case "step_complete": {
									const toolCalls = Array.isArray(
										data.toolCalls,
									)
										? data.toolCalls
										: [];
									if (toolCalls.length === 0) {
										break;
									}
									updateResponse((prev) => {
										const nextToolCalls = [
											...prev.toolCalls,
										];
										for (const tc of toolCalls) {
											const existingIndex =
												nextToolCalls.findIndex(
													(existing) =>
														existing.id === tc.id ||
														existing.name ===
															tc.name,
												);
											const mapped = {
												id:
													tc.id ??
													`tool-${Date.now()}-${tc.name ?? "step"}`,
												name: tc.name,
												args: tc.args,
												result: tc.result,
												status:
													tc.status === "error"
														? ("error" as const)
														: ("complete" as const),
												mcpAppResourceUri:
													tc.mcpAppResourceUri,
												mcpAppConfigId:
													tc.mcpAppConfigId,
											};
											if (existingIndex >= 0) {
												nextToolCalls[existingIndex] =
													mergeToolCall(
														[
															nextToolCalls[
																existingIndex
															],
														],
														mapped,
													)[0];
											} else {
												nextToolCalls.push(mapped);
											}
										}
										return {
											...prev,
											toolCalls: nextToolCalls,
										};
									});
									break;
								}
								case "mcp_default_tool_invoked":
								case "mcp_default_tool_failed": {
									// Tracking-only event forwarded straight
									// to the consumer's
									// `useAnalytics.trackEvent`. No
									// per-agent state mutation; the per-agent
									// freeze gate above already covers
									// cancellation. If the consumer didn't
									// supply a handler we silently drop the
									// event so the workflow can emit these
									// without coordinating with every call
									// site.
									const handler = onAnalyticsEventRef.current;
									if (
										handler &&
										data.payload &&
										typeof data.payload === "object"
									) {
										handler(
											data.type,
											data.payload as Record<
												string,
												unknown
											>,
										);
									}
									break;
								}

								case "approval_required":
									updateResponse((prev) => ({
										...prev,
										pendingApproval: {
											approvalId:
												typeof data.approvalId ===
												"string"
													? data.approvalId
													: "",
											stepId:
												typeof data.stepId === "string"
													? data.stepId
													: "",
											reason:
												typeof data.reason === "string"
													? data.reason
													: "Approval required",
										},
									}));
									break;
								case "approval_resolved":
									updateResponse((prev) => ({
										...prev,
										pendingApproval: null,
									}));
									break;
								case "stream_timeout":
									// The orchestrator route now closes a
									// long run's HTTP window with this instead
									// of `error: "Execution timed out"`, and
									// the workflow keeps running on Temporal
									// (issue #2269). The Loom chat reconnects
									// with the executionId; this surface has no
									// resume loop, so end the agent's turn
									// honestly rather than letting the close
									// read as a clean finish.
									flushBufferedText(responseKey);
									updateResponse((prev) => ({
										...prev,
										isLoading: false,
										status: "error",
										isError: true,
										content:
											prev.content ||
											"The streaming window closed before this agent finished. The workflow may still be running.",
									}));
									clearBufferedText(responseKey);
									break;
								case "done":
								case "completed":
								case "error":
									// AI usage-limit short-circuit. When
									// the chokepoint blocks mid-stream
									// the route emits a structured SSE
									// error event with
									// `code: "AI_USAGE_LIMIT_EXCEEDED"`.
									// Render the shared destructive
									// toast and reset to idle on this
									// agent's response so the user is
									// not left with a generic "Error:"
									// stub.
									if (
										data.type === "error" &&
										data.code === "AI_USAGE_LIMIT_EXCEEDED"
									) {
										const payload =
											isAiUsageLimitExceededPayload(
												data?.data,
											)
												? data.data
												: isAiUsageLimitExceededPayload(
															data,
														)
													? data
													: null;
										if (payload) {
											showAiUsageLimitToastRef.current(
												payload,
											);
										}
										flushBufferedText(responseKey);
										updateResponse((prev) => ({
											...prev,
											isLoading: false,
											isError: false,
											status: "idle",
										}));
										clearBufferedText(responseKey);
										break;
									}
									flushBufferedText(responseKey);
									updateResponse((prev) => {
										// Merge any tool-call results that
										// only arrived in the final
										// `completed` payload (e.g. the
										// orchestrator's synthetic
										// short-circuit branches like
										// `fabric_connect_excalidraw_cta`,
										// where no separate `tool_result`
										// event fires before completion).
										// Without this, `tc.result` stays
										// undefined and downstream
										// renderers (CTA cards, MCP App
										// frames) never mount.
										const completedToolCalls =
											data.type === "completed" &&
											Array.isArray(data.toolCalls)
												? data.toolCalls
												: [];
										let nextToolCalls = prev.toolCalls;
										for (const tc of completedToolCalls) {
											if (!tc?.name) {
												continue;
											}
											nextToolCalls = mergeToolCall(
												nextToolCalls,
												{
													id:
														tc.id ??
														`tool-${Date.now()}-${tc.name}`,
													name: tc.name,
													args: tc.args,
													result: tc.result,
													serverName: tc.serverName,
													status:
														tc.status === "error"
															? "error"
															: "complete",
													mcpAppResourceUri:
														tc.mcpAppResourceUri,
													mcpAppConfigId:
														tc.mcpAppConfigId,
												},
											);
										}
										return {
											...prev,
											isLoading: false,
											status:
												data.type === "error"
													? "error"
													: "completed",
											isError: data.type === "error",
											content:
												data.type === "error" &&
												!prev.content
													? `Error: ${data.message ?? data.error ?? "Unknown error"}`
													: data.type === "completed"
														? mergeStreamedText(
																prev.content,
																data.response,
															)
														: prev.content,
											toolCalls: nextToolCalls,
										};
									});
									clearBufferedText(responseKey);
									break;
								default:
									break;
							}
						} catch {
							// Skip malformed JSON lines
						}
					}
				}

				// Ensure loading is cleared after stream ends — but never
				// overwrite an agent the user has already cancelled
				// (decision 12 / decision 18).
				flushBufferedText(responseKey);
				if (!cancelledAgentIdsRef.current.has(agent.agentId)) {
					updateResponse((prev) =>
						prev.isLoading
							? { ...prev, isLoading: false, status: "completed" }
							: prev,
					);
				}
				clearBufferedText(responseKey);
			} catch (err) {
				const responseKey = `${turnId}::${agent.agentId}`;
				flushBufferedText(responseKey);
				clearBufferedText(responseKey);
				if (cancelledAgentIdsRef.current.has(agent.agentId)) {
					// `stopAll` already flipped this agent to `cancelled`
					// — abort errors are expected and must not reset the
					// status back to `idle` or `error`.
					return;
				}
				if ((err as Error).name === "AbortError") {
					updateResponse((prev) => ({
						...prev,
						isLoading: false,
						status: "idle",
					}));
				} else {
					updateResponse((prev) => ({
						...prev,
						isLoading: false,
						isError: true,
						status: "error",
						content:
							prev.content || `Error: ${(err as Error).message}`,
					}));
				}
			}
		},
		[clearBufferedText, flushBufferedText, organizationId, queueTextDelta],
	);

	/**
	 * Send a message to all selected agents simultaneously.
	 * Each agent gets its own independent SSE stream — like Dust's concurrentExecutor.
	 */
	const sendToAgents = useCallback(
		(
			message: string,
			agents: Array<{
				agentId: string;
				name: string;
				description?: string | null;
				instructions?: string | null;
				enabledMcpConfigIds?: string[] | null;
				workspaceIds?: string[];
				modelOverride?: string;
				vendor?: string;
				instanceId?: string;
				enabledIntegrationIds?: string[];
			}>,
			historyOrResolver: ConversationHistory | AgentHistoryResolver,
			executionOptions?: MultiAgentExecutionOptions,
		) => {
			// Cancel any in-flight streams
			for (const ctrl of abortControllersRef.current.values()) {
				ctrl.abort();
			}
			abortControllersRef.current.clear();
			// New turn — reset cancel telemetry inputs and the freeze
			// gate so the next click on Stop doesn't see leftovers from
			// a previous turn.
			cancelledAgentIdsRef.current = new Set();
			turnStartedAtRef.current = Date.now();

			const turnId = `turn-${Date.now()}`;
			currentTurnIdRef.current = turnId;

			// Build the initial turn with placeholder responses for each agent
			const agentResponses = new Map<string, AgentResponse>();
			for (const agent of agents) {
				agentResponses.set(agent.agentId, {
					agentId: agent.agentId,
					agentName: agent.name,
					vendor: agent.vendor,
					executionId: undefined,
					content: "",
					toolCalls: [],
					isLoading: true,
					isError: false,
					status: "streaming",
				});
			}

			const newTurn: ConversationTurn = {
				id: turnId,
				userMessage: message,
				agentResponses,
				timestamp: new Date(),
				...(executionOptions?.attachmentNames &&
				executionOptions.attachmentNames.length > 0
					? { attachmentNames: executionOptions.attachmentNames }
					: {}),
			};

			setTurns((prev) => [...prev, newTurn]);

			// Fire all streams in parallel (fire-and-forget, like Dust's void launchAgentLoopWorkflow)
			for (const agent of agents) {
				const ctrl = new AbortController();
				abortControllersRef.current.set(agent.agentId, ctrl);

				const resolvedHistory =
					typeof historyOrResolver === "function"
						? historyOrResolver(agent)
						: historyOrResolver;
				const historyForAgent = resolvedHistory.map((m) => ({
					role: m.role,
					content: m.content,
				}));

				// NOT awaited — runs concurrently
				streamFromAgent(
					turnId,
					agent,
					message,
					historyForAgent,
					ctrl.signal,
					executionOptions,
				);
			}
		},
		[streamFromAgent],
	);

	/**
	 * Stop every agent that is still streaming for the current turn.
	 * Per spec section 8.4 and decision 18 (Honest record):
	 * - Agents whose `status === "completed" | "error" | "cancelled"`
	 * are left untouched. Already-finished agents are NOT
	 * retroactively relabelled.
	 * - Agents that are still in-flight (`status === "streaming"` or
	 * `isLoading === true`) flip to `"cancelled"`, abort their
	 * `AbortController`, get a `cancelledAt` ISO stamp, and have
	 * their `agentId` added to the freeze gate so any post-stop SSE
	 * deltas are dropped client-side.
	 * For each cancelled agent that has an `executionId`, a
	 * fire-and-forget cancel POST is sent against the
	 * orchestrator-temporal cancel endpoint (Nexus's parallel-agent SSE
	 * stream is backed by `orchestratorTemporalWorkflow`, so executionIds
	 * are prefixed `orch-` — the new direct-chat cancel route only
	 * accepts `direct-chat-…` ids and would 400 every request). The UI
	 * does not wait — `onStopFailed` fires once per non-2xx response so
	 * the consumer can surface a non-blocking toast (/ decision 11).
	 * `extractResumableExecutions` in `CopilotPage.tsx` already
	 * filters by `status === "streaming"`, so cancelled agents are
	 * implicitly skipped on next page reload (/ decision 14).
	 * @param triggeredBy - whether the stop came from the morph button
	 * click or the Esc keybinding. Threaded into telemetry.
	 */
	const stopAll = useCallback((triggeredBy: "button" | "esc" = "button") => {
		const turnId = currentTurnIdRef.current;
		if (!turnId) {
			return;
		}
		const turn = turnsRef.current.find((t) => t.id === turnId);
		if (!turn) {
			return;
		}

		const cancelledAt = new Date().toISOString();
		const startedAt = turnStartedAtRef.current;
		const latencyMs =
			startedAt !== null ? Math.max(0, Date.now() - startedAt) : 0;

		// Snapshot the agents that are still in-flight RIGHT NOW so
		// the race in decision 18 is honest: an agent that flipped
		// to `completed` between click and iteration stays
		// `completed`.
		const inFlightAgents: AgentResponse[] = [];
		for (const response of turn.agentResponses.values()) {
			if (cancelledAgentIdsRef.current.has(response.agentId)) {
				continue;
			}
			const isInFlight =
				response.status === "streaming" ||
				(response.status === "idle" && response.isLoading);
			if (isInFlight) {
				inFlightAgents.push(response);
			}
		}

		if (inFlightAgents.length === 0) {
			return;
		}

		// 1. Synchronous flip — abort + mark cancelled per agent.
		for (const response of inFlightAgents) {
			cancelledAgentIdsRef.current.add(response.agentId);
			abortControllersRef.current.get(response.agentId)?.abort();
		}

		setTurns((prev) =>
			prev.map((t) => {
				if (t.id !== turnId) {
					return t;
				}
				const next = new Map(t.agentResponses);
				for (const response of inFlightAgents) {
					const current = next.get(response.agentId);
					if (!current) {
						continue;
					}
					next.set(response.agentId, {
						...current,
						isLoading: false,
						status: "cancelled",
						cancelledAt,
					});
				}
				return { ...t, agentResponses: next };
			}),
		);

		// 2. Telemetry — one event per cancelled agent so the funnel
		// can break out which agents were halted.
		for (const response of inFlightAgents) {
			const partialTokenCount = Math.ceil(response.content.length / 4);
			emitCancelEvent({
				surface: "nexus",
				agentId: response.agentId,
				executionId: response.executionId ?? null,
				partial_token_count: partialTokenCount,
				latency_to_cancel_ms: latencyMs,
				triggered_by: triggeredBy,
			});
		}

		// 3. Fire-and-forget cancel POST per agent that has an
		// executionId. Nexus's parallel-agent SSE stream is
		// backed by the orchestrator-temporal workflow
		// (executionId prefix `orch-`), so cancellation must go
		// through the orchestrator-temporal cancel route. The
		// direct-chat cancel route at
		// `/api/agents/fabric-ai/stream/cancel` is reserved for
		// `useDirectStream` (executionId prefix
		// `direct-chat-`); routing Nexus cancels there 400s
		// because its regex rejects `orch-…` ids.
		for (const response of inFlightAgents) {
			if (!response.executionId) {
				continue;
			}
			const executionId = response.executionId;
			void fetch("/api/agents/fabric-ai/orchestrator-temporal/cancel", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ executionId }),
			})
				.then((cancelResponse) => {
					if (!cancelResponse.ok) {
						onStopFailedRef.current?.();
					}
				})
				.catch(() => {
					onStopFailedRef.current?.();
				});
		}
	}, []);

	const reset = useCallback(() => {
		for (const ctrl of abortControllersRef.current.values()) {
			ctrl.abort();
		}
		abortControllersRef.current.clear();
		for (const timeoutId of textFlushTimeoutRef.current.values()) {
			clearTimeout(timeoutId);
		}
		textFlushTimeoutRef.current.clear();
		textBufferRef.current.clear();
		setTurns([]);
		currentTurnIdRef.current = null;
		cancelledAgentIdsRef.current = new Set();
		turnStartedAtRef.current = null;
	}, []);

	const hydrateTurns = useCallback((nextTurns: ConversationTurn[]) => {
		for (const ctrl of abortControllersRef.current.values()) {
			ctrl.abort();
		}
		abortControllersRef.current.clear();
		setTurns(nextTurns);
		turnsRef.current = nextTurns;
		currentTurnIdRef.current =
			nextTurns.length > 0
				? (nextTurns[nextTurns.length - 1]?.id ?? null)
				: null;
		cancelledAgentIdsRef.current = new Set();
	}, []);

	const flushStreamingText = useCallback(() => {
		for (const responseKey of textBufferRef.current.keys()) {
			flushBufferedText(responseKey);
		}
	}, [flushBufferedText]);

	const resumeAgents = useCallback(
		(
			resumptions: Array<{
				turnId: string;
				agent: {
					agentId: string;
					name: string;
					description?: string | null;
					instructions?: string | null;
					enabledMcpConfigIds?: string[] | null;
					workspaceIds?: string[];
					modelOverride?: string;
					vendor?: string;
					instanceId?: string;
					enabledIntegrationIds?: string[];
				};
				executionId: string;
			}>,
		) => {
			for (const resumption of resumptions) {
				const ctrl = new AbortController();
				abortControllersRef.current.set(resumption.agent.agentId, ctrl);
				void streamFromAgent(
					resumption.turnId,
					resumption.agent,
					"",
					[],
					ctrl.signal,
					undefined,
					resumption.executionId,
				);
			}
		},
		[streamFromAgent],
	);

	const isLoading =
		turns.length > 0 &&
		Array.from(turns[turns.length - 1]?.agentResponses.values() ?? []).some(
			(r) => r.isLoading,
		);

	return {
		turns,
		sendToAgents,
		/**
		 * Stop every agent that is still streaming for the current
		 * turn. Already-completed agents are left untouched. See the
		 * doc on `stopAll` for the full semantics (decisions 12 + 18).
		 */
		stopAll,
		reset,
		hydrateTurns,
		resumeAgents,
		flushStreamingText,
		isLoading,
	};
}
