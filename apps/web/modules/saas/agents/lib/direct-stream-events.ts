import type { LimitSignal } from "@repo/ai/limits";
import {
	type AiUsageLimitExceededPayload,
	isAiUsageLimitExceededPayload,
} from "@saas/payments/lib/ai-usage-limit-toast";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type {
	ContextInfo,
	DirectStreamMessage,
	DirectStreamState,
	DirectStreamToolCall,
	StreamModelInfo,
	TokenUsage,
} from "../hooks/useDirectStream";
import {
	type ChatConfirmationRequest,
	readConfirmationRequest,
} from "./chat-confirmation";
import { parseTurnTruncation } from "./chat-turn-truncation";
import { parseChatGptPlanApiBilling } from "./chatgpt-plan-api-billing";
import {
	findToolCallIndex,
	settleUnfinishedToolCalls,
} from "./direct-chat-turns";
import {
	type DirectStreamEvent,
	parseWorkflowConfirmation,
	type WorkflowConfirmation,
} from "./direct-stream-protocol";

/**
 * How one Direct chat event changes the chat: the reducer both Direct
 * transports apply, the stream route's SSE (`useDirectStream`) and the agent
 * runtime's AG-UI events translated into the same events
 * (`useDirectRuntimeStream`), so the two render a turn identically.
 */

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
		const targetIndex = findToolCallIndex(m.toolCalls || [], {
			toolCallId: event.toolCallId,
			toolName: resultToolName,
		});
		const updatedToolCalls = (m.toolCalls || []).map((tc, index) =>
			index === targetIndex
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

		const pendingConf =
			event.status === "error" || event.error
				? m.pendingConfirmation
				: (readConfirmationRequest(event.result) ??
					parseWorkflowConfirmation(
						resultToolName ?? m.toolCalls?.[targetIndex]?.name,
						event.result,
					) ??
					m.pendingConfirmation);

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

/** The hook state and refs an event reads and writes. */
export interface DirectStreamEventContext {
	setMessages: Dispatch<SetStateAction<DirectStreamMessage[]>>;
	setState: Dispatch<SetStateAction<DirectStreamState>>;
	setContextInfo: Dispatch<SetStateAction<ContextInfo>>;
	/**
	 * Freeze gate (decision 12 /). Once a message id is in this set, all
	 * subsequent deltas for it are dropped on the floor.
	 */
	cancelledMessageIdsRef: RefObject<Set<string>>;
	/** Assistant message id → the error its turn ended with. */
	erroredMessagesRef: RefObject<Map<string, string>>;
	/** Set after a tool event interrupts the text, so the next text starts a paragraph. */
	needsTextSeparatorRef: RefObject<boolean>;
	/** Temporal workflow id of the in-flight turn, for `stop`. */
	executionIdRef: RefObject<string | null>;
	onAnalyticsEventRef: RefObject<
		| ((eventName: string, payload: Record<string, unknown>) => void)
		| undefined
	>;
	showAiUsageLimitToastRef: RefObject<
		(payload: AiUsageLimitExceededPayload) => void
	>;
}

/**
 * Apply one Direct chat event to the assistant message it belongs to.
 */
export function applyDirectStreamEvent(
	data: DirectStreamEvent,
	assistantMessageId: string,
	context: DirectStreamEventContext,
): void {
	const {
		setMessages,
		setState,
		setContextInfo,
		cancelledMessageIdsRef,
		erroredMessagesRef,
		needsTextSeparatorRef,
		executionIdRef,
		onAnalyticsEventRef,
		showAiUsageLimitToastRef,
	} = context;
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
				applyReasoningDuration(prev, assistantMessageId, durationMs),
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
							toolCalls: existingToolCalls.map((tc, index) =>
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
					const existingIndex = findToolCallIndex(existingToolCalls, {
						toolCallId: data.toolCallId,
						toolName: inputToolName,
					});
					if (existingIndex < 0) {
						return {
							...m,
							toolCalls: [
								...existingToolCalls,
								{
									id: data.toolCallId || `tool-${Date.now()}`,
									name: inputToolName,
									args: data.args,
									serverName: data.serverName,
									status: data.status || "pending",
									mcpAppResourceUri: data.mcpAppResourceUri,
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
												: (data.status ?? tc.status),
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
			//
			// A `partial` refusal stopped a later step after part of
			// the answer had streamed: the toast still fires, and the
			// answer stays, marked as cut off like any partial error.
			if (data.code === "AI_USAGE_LIMIT_EXCEEDED") {
				const payload = isAiUsageLimitExceededPayload(data?.data)
					? data.data
					: isAiUsageLimitExceededPayload(data)
						? data
						: null;
				if (payload) {
					showAiUsageLimitToastRef.current(payload);
				}
				if (data.partial !== true) {
					setMessages((prev) =>
						prev.filter((m) => m.id !== assistantMessageId),
					);
					setState({ status: "idle" });
					break;
				}
			}
			// The cause goes in its own field so a partial answer that
			// streamed first keeps both: the text, and why it stopped.
			const errorMessage: string = data.message || "Unknown error";
			const limit: LimitSignal | undefined =
				data.limit && typeof data.limit.kind === "string"
					? data.limit
					: undefined;
			erroredMessagesRef.current.set(assistantMessageId, errorMessage);
			setMessages((prev) =>
				prev.map((m) =>
					m.id === assistantMessageId
						? {
								...m,
								errorMessage,
								...(limit ? { limit } : {}),
								isError: true,
								streamStatus: "error",
								toolCalls: settleUnfinishedToolCalls(
									m.toolCalls,
								),
							}
						: m,
				),
			);
			setState({ status: "error", error: errorMessage });
			break;
		}

		case "confirmation_required": {
			const pendingConfirmation:
				| ChatConfirmationRequest
				| WorkflowConfirmation
				| undefined =
				data.workflowId && data.workflowName
					? {
							workflowId: data.workflowId,
							workflowName: data.workflowName,
							description: data.description,
							message: data.message,
						}
					: (readConfirmationRequest(data) ?? undefined);
			if (!pendingConfirmation) {
				break;
			}
			setMessages((prev) =>
				prev.map((m) =>
					m.id === assistantMessageId
						? {
								...m,
								pendingConfirmation,
							}
						: m,
				),
			);
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
			if (handler && data.payload && typeof data.payload === "object") {
				handler(data.type, data.payload as Record<string, unknown>);
			}
			break;
		}

		case "done": {
			// Stream completed. The turn's usage IS the current context:
			// its input count covers everything the model was shown.
			// Replace rather than accumulate, size the window from the
			// model that answered, and pin both to the assistant
			// message so they persist with it.
			const turnUsage: TokenUsage | undefined = data.usage
				? {
						inputTokens: data.usage.inputTokens || 0,
						outputTokens: data.usage.outputTokens || 0,
						totalTokens:
							data.usage.totalTokens ||
							(data.usage.inputTokens || 0) +
								(data.usage.outputTokens || 0),
						reasoningTokens: data.usage.reasoningTokens,
						cachedInputTokens: data.usage.cachedInputTokens,
					}
				: undefined;
			const toolsFailed: DirectStreamMessage["toolsFailed"] =
				data.toolsFailed && typeof data.toolsFailed === "object"
					? {
							summary:
								typeof data.toolsFailed.summary === "string"
									? data.toolsFailed.summary
									: undefined,
						}
					: undefined;
			const turnModel: StreamModelInfo | undefined =
				data.model && typeof data.model.id === "string"
					? {
							id: data.model.id,
							// Absent from a worker older than this field;
							// keep it absent so the label stays hidden.
							viaPlan:
								typeof data.model.viaPlan === "boolean"
									? data.model.viaPlan
									: undefined,
							canonicalName: data.model.canonicalName,
							provider: data.model.provider,
							contextWindow:
								typeof data.model.contextWindow === "number"
									? data.model.contextWindow
									: undefined,
						}
					: undefined;
			const truncated = parseTurnTruncation(data.truncated);
			// The turn moved to API billing mid-way (Fizzy #3048).
			const apiBilling = data.apiBilling
				? parseChatGptPlanApiBilling(data.apiBilling)
				: undefined;
			setMessages((prev) =>
				prev.map((m) =>
					m.id === assistantMessageId
						? {
								...m,
								...(toolsFailed ? { toolsFailed } : {}),
								...(truncated ? { truncated } : {}),
								...(apiBilling ? { apiBilling } : {}),
								toolCalls: settleUnfinishedToolCalls(
									m.toolCalls,
								),
							}
						: m,
				),
			);
			if (turnUsage || turnModel) {
				setContextInfo((prev) => ({
					...prev,
					usage: turnUsage ?? prev.usage,
					maxTokens: turnModel?.contextWindow ?? prev.maxTokens,
					modelId: turnModel?.id ?? prev.modelId,
					modelLabel:
						turnModel?.canonicalName ??
						turnModel?.id ??
						prev.modelLabel,
				}));
				setMessages((prev) =>
					prev.map((m) =>
						m.id === assistantMessageId
							? {
									...m,
									usage: turnUsage ?? m.usage,
									model: turnModel ?? m.model,
								}
							: m,
					),
				);
			}
			// A partial-answer failure sends `error` then `done`; the
			// turn stays failed.
			if (!erroredMessagesRef.current.has(assistantMessageId)) {
				setState({ status: "completed" });
			}
			break;
		}
	}
}
