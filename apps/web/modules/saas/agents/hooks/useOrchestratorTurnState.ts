"use client";

/**
 * The Orchestrator chat's turn state, shared by both transports: the stream
 * route's (`useOrchestratorStream`) and the agent runtime's
 * (`useOrchestratorRuntimeStream`). It holds the messages, the turn's state,
 * steps and tool calls, the PartyKit side channel, and the state changes a
 * turn goes through (start, stream events, refusal, failure, stop, reset);
 * the transports only decide how a turn's events reach it.
 */

import type { TaskStep } from "@repo/temporal";
import { useShowAiUsageLimitToast } from "@saas/payments/lib/ai-usage-limit-toast";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalSendResult } from "../lib/approval-response";
import { emitCancelEvent } from "../lib/cancel-telemetry";
import { formatClarificationTurn } from "../lib/clarification-turns";
import { settleUnfinishedToolCalls } from "../lib/direct-chat-turns";
import { applyOrchestratorStreamEvent } from "../lib/orchestrator-stream-events";
import type { OrchestratorStreamEvent } from "../lib/orchestrator-stream-protocol";
import {
	idleOrchestratorStreamState,
	type OrchestratorStreamMessage,
	type OrchestratorStreamState,
	type StreamingStepResult,
	safeToolField,
	type ToolCallState,
	TURN_IN_PROGRESS_NOTICE,
	type UseOrchestratorStreamOptions,
} from "../lib/orchestrator-stream-types";
import { useOrchestratorPartyKit } from "./useOrchestratorPartyKit";

/** A PartyKit tool call, which may carry MCP App fields the hook's type omits. */
interface PartykitToolCall {
	id: string;
	name: string;
	args?: unknown;
	result?: unknown;
	status: ToolCallState["status"];
	durationMs?: number;
}

function mcpAppFields(toolCall: PartykitToolCall): {
	mcpAppResourceUri?: string;
	mcpAppConfigId?: string;
} {
	const fields: Record<string, unknown> = { ...toolCall };
	return {
		mcpAppResourceUri:
			typeof fields.mcpAppResourceUri === "string"
				? fields.mcpAppResourceUri
				: undefined,
		mcpAppConfigId:
			typeof fields.mcpAppConfigId === "string"
				? fields.mcpAppConfigId
				: undefined,
	};
}

function toToolCallState(tc: PartykitToolCall): ToolCallState {
	return {
		id: tc.id,
		name: tc.name,
		// Reject the truncation sentinel here — see `safeToolField`.
		args: safeToolField(tc.args),
		result: safeToolField(tc.result),
		status: tc.status,
		durationMs: tc.durationMs,
		...mcpAppFields(tc),
	};
}

/** A turn `beginTurn` put on screen: its two messages and its controller. */
export interface StartedTurn {
	userMessage: OrchestratorStreamMessage;
	assistantMessage: OrchestratorStreamMessage;
	controller: AbortController;
}

export function useOrchestratorTurnState(
	options: Pick<
		UseOrchestratorStreamOptions,
		"organizationId" | "surface" | "telemetrySurface" | "onTurnRefused"
	>,
) {
	const { organizationId, surface = "loom-orchestrator" } = options;
	const telemetrySurfaceRef = useRef(options.telemetrySurface ?? surface);
	telemetrySurfaceRef.current = options.telemetrySurface ?? surface;
	const onTurnRefusedRef = useRef(options.onTurnRefused);
	onTurnRefusedRef.current = options.onTurnRefused;

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
	const [state, setState] = useState<OrchestratorStreamState>(
		idleOrchestratorStreamState,
	);

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
			).map(toToolCallState);

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
			? partykitToolCalls.map(toToolCallState)
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

	/** Handle one incoming stream event for the turn's assistant message. */
	const handleStreamEvent = useCallback(
		(data: OrchestratorStreamEvent, assistantMessageId: string) =>
			applyOrchestratorStreamEvent(data, assistantMessageId, {
				setState,
				setMessages,
				setIsLoading,
				setStepResults,
				setCurrentPhase,
				setProgressMessage,
				setCurrentStep,
				setCompletedSteps,
				setTotalSteps,
				setStreamingToolCalls,
				cancelledMessageIdsRef,
				executionIdRef,
				shouldClearOnNextDeltaRef,
				needsTextSeparatorRef,
				prevToolCallsRef,
				completedStepIdsRef,
				hasTurnOutputRef,
				isTransitioningFromApprovalRef,
				latestApprovalIdRef,
				showAiUsageLimitToastRef,
				notifyPartykitStepStart,
			}),
		[notifyPartykitStepStart],
	);

	/**
	 * Put a new turn on screen: the question and an empty streaming answer,
	 * a fresh controller (aborting the previous one) and a clean turn state.
	 * `attachExecutionId` is a turn already running that this one shows.
	 */
	const beginTurn = useCallback(
		({
			content,
			displayImageUrls,
			forceNewChat,
			attachExecutionId,
			clientRequestKey,
			conversationId,
		}: {
			content: string;
			displayImageUrls: string[] | undefined;
			forceNewChat: boolean;
			attachExecutionId: string | null;
			clientRequestKey: string | null;
			conversationId: string | null;
		}): StartedTurn => {
			// Cancel any existing request
			abortControllerRef.current?.abort();
			const controller = new AbortController();
			abortControllerRef.current = controller;

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
			completedStepIdsRef.current = new Set();
			hasTurnOutputRef.current = false;
			clientRequestKeyRef.current = clientRequestKey;
			turnConversationIdRef.current = conversationId;

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
			return { userMessage, assistantMessage, controller };
		},
		[resetPartykit],
	);

	// Preserve partial output and settle active tool cards on transport failure.
	const failWithoutDiscardingContent = useCallback(
		(
			assistantMessageId: string,
			reason: string,
			includeErrorInEmptyContent = false,
		) => {
			setStreamingToolCalls(
				(prev) => settleUnfinishedToolCalls(prev) ?? prev,
			);
			setMessages((prev) =>
				prev.map((m) =>
					m.id === assistantMessageId
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
		},
		[],
	);

	// The server refused this message: a different message is already
	// being answered in this conversation (another tab, or a turn this
	// tab lost track of). It never ran, so it must not look sent or
	// answered, and must not reach the conversation's saved history.
	// Attaching to the other turn instead would show that turn's answer
	// under this question, and the chat's save would then persist the
	// pair. So: drop the question and its placeholder, leave
	// `state.executionId` null (the chat saves a turn only once it has
	// one), and put the notice where the chat renders a failed turn.
	const refuseBecauseAnotherTurnIsLive = useCallback(
		(turn: StartedTurn, clientRequestKey: string | null) => {
			const { userMessage, assistantMessage } = turn;
			// By identity, not id: ids come from `Date.now()`, so a
			// message sent in the same millisecond as the previous one
			// shares its ids, and an id filter would drop that one too.
			// Nothing has replaced these two objects yet: the refusal
			// arrives before any stream event for them.
			setMessages((prev) =>
				prev.filter((m) => m !== userMessage && m !== assistantMessage),
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
			const addition = onTurnRefusedRef.current?.(userMessage.content);
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
		},
		[],
	);

	/** This message was stopped before it started. */
	const settleCancelledBeforeStart = useCallback(
		(assistantMessageId: string) => {
			setMessages((prev) =>
				prev.map((m) =>
					m.id === assistantMessageId
						? {
								...m,
								isStreaming: false,
								streamStatus: "cancelled" as const,
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
		},
		[],
	);

	/** The turn was refused on a usage limit: the toast says so, the chat goes idle. */
	const settleUsageLimitRefusal = useCallback(() => {
		setIsLoading(false);
		setState((prev) => ({
			...prev,
			status: "idle",
		}));
		setCurrentPhase("idle");
	}, []);

	/**
	 * An approval answer reached the run. Clears the card unless the run has
	 * already asked again; a stale card is cleared too, since the run no
	 * longer waits on it.
	 */
	const settleAnsweredApproval = useCallback(
		(
			decidedApprovalId: string | null,
			approved: boolean,
			result: ApprovalSendResult,
		) => {
			// The run may already have asked again (the stream delivered
			// the next request before this answer came back): that card
			// stays.
			if (latestApprovalIdRef.current !== decidedApprovalId) {
				return;
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
		},
		[],
	);

	/**
	 * A clarifying question was answered (or dismissed) and the run took it.
	 * `question` is the one on screen when the answer was sent.
	 */
	const settleAnsweredClarification = useCallback(
		(question: string | undefined, answer: string, dismissed: boolean) => {
			// Add the answered question to the live transcript. This is the
			// path that fixes the reported case: the next message in the
			// same session builds its history from `messages` plus a
			// `completedExecutions` that React has not re-rendered yet, so
			// an answer recorded only on the execution record would not
			// reach the following turn (Fizzy #2406). It also leaves the
			// exchange visible after the card is dismissed, instead of the
			// question and answer vanishing from the thread.
			if (!dismissed && answer.trim() && question) {
				setMessages((prev) => [
					...prev,
					{
						id: `msg-${Date.now()}-clarification`,
						metadata: {
							clarification: {
								question,
								answer: answer.trim(),
							},
						},
						role: "user",
						content: formatClarificationTurn({
							question,
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
					dismissed || !answer.trim() || !prev.pendingClarification
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
		},
		[],
	);

	/** Show a follow-up as the user's message at once; returns it for removal on failure. */
	const showFollowUp = useCallback((message: string) => {
		const followUpMessage: OrchestratorStreamMessage = {
			id: `msg-${Date.now()}-followup`,
			role: "user",
			content: message,
			timestamp: new Date(),
		};
		setMessages((prev) => [...prev, followUpMessage]);
		return followUpMessage;
	}, []);

	const removeMessage = useCallback((messageId: string) => {
		setMessages((prev) => prev.filter((m) => m.id !== messageId));
	}, []);

	/**
	 * The synchronous half of Stop: abort the turn's request, mark its answer
	 * cancelled, clear loading and the pending approval, and send the cancel
	 * telemetry. Returns the turn's identity for the transport's cancel, or
	 * null when this turn was already stopped.
	 */
	const flipToStopped = useCallback((triggeredBy: "button" | "esc") => {
		const targetId = activeAssistantIdRef.current;
		if (targetId) {
			if (cancelledMessageIdsRef.current.has(targetId)) {
				// Idempotent — clicking twice does nothing the second
				// time.
				return null;
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

		// Only the CURRENT turn's identity: `state.executionId` can still
		// hold the previous message's run until this one's `started`
		// arrives, and cancelling that would leave this one running.
		return {
			executionId: executionIdRef.current,
			clientRequestKey: clientRequestKeyRef.current,
			conversationId: turnConversationIdRef.current,
			organizationId: organizationIdRef.current,
		};
	}, []);

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
		setState(idleOrchestratorStreamState());
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
		messages,
		isLoading,
		state,
		setState,
		setProgressMessage,
		abortControllerRef,
		cancelledMessageIdsRef,
		executionIdRef,
		latestApprovalIdRef,
		showAiUsageLimitToastRef,
		handleStreamEvent,
		beginTurn,
		failWithoutDiscardingContent,
		refuseBecauseAnotherTurnIsLive,
		settleCancelledBeforeStart,
		settleUsageLimitRefusal,
		settleAnsweredApproval,
		settleAnsweredClarification,
		showFollowUp,
		removeMessage,
		flipToStopped,
		reset,
		/** The fields every transport returns as they are. */
		view: {
			// State
			messages,
			isLoading,
			state,

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
		},
	};
}
