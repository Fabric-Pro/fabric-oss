"use client";

/**
 * useOrchestratorStream
 * React hook for streaming Temporal orchestrator execution via SSE.
 * Replaces the earlier polling-based orchestrator hook with real-time streaming.
 * Now enhanced with PartyKit WebSocket for instant tool execution updates.
 * SSE provides workflow-level events, PartyKit provides real-time tool calls.
 *
 * The turn state and its event handling are shared with the agent runtime's
 * transport (`useOrchestratorTurnState`); this hook is the stream route's
 * transport: the request, its reconnect loop, and the control routes.
 */

import { isAiUsageLimitExceededPayload } from "@saas/payments/lib/ai-usage-limit-toast";
import {
	describeAiError,
	isChatGptPlanSpentCode,
} from "@saas/shared/lib/ai-error-message";
import { useCallback, useRef } from "react";
import {
	type ApprovalSendResult,
	approvalSendResult,
} from "../lib/approval-response";
import { ChatStreamProtocolError } from "../lib/chat-stream-protocol";
import { readChatGptPlanApiBilling } from "../lib/chatgpt-plan-api-billing";
import { orchestratorRequestFields } from "../lib/orchestrator-request";
import { parseOrchestratorStreamEvent } from "../lib/orchestrator-stream-protocol";
import {
	newClientRequestKey,
	type SendMessageOverrides,
	type UseOrchestratorStreamOptions,
	waitBeforeResume,
} from "../lib/orchestrator-stream-types";
import { executionModeUsesTurns } from "../lib/orchestrator-turn-modes";
import { readChatEventStream } from "../lib/read-chat-event-stream";
import { useOrchestratorTurnState } from "./useOrchestratorTurnState";

export type {
	ContextCompactionEvent,
	OrchestratorStreamMessage,
	UseOrchestratorStreamOptions,
} from "../lib/orchestrator-stream-types";

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

export function useOrchestratorStream(
	options: UseOrchestratorStreamOptions = {},
) {
	const {
		organizationId,
		executionMode = "balanced",
		instanceId,
		conversationId,
		workspaceIds,
		surface = "loom-orchestrator",
		onStopFailed,
	} = options;

	// Latest-value refs so `stop` does not need to memoize on these.
	const surfaceRef = useRef(surface);
	surfaceRef.current = surface;
	const onStopFailedRef = useRef(onStopFailed);
	onStopFailedRef.current = onStopFailed;
	// Read at send time, so a send carries the options of the render it
	// was made in.
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const turn = useOrchestratorTurnState(options);
	const {
		state,
		isLoading,
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
		setProgressMessage,
		showFollowUp,
		removeMessage,
		flipToStopped,
	} = turn;

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

			// One key per user message; retries of this message reuse it. An
			// attached turn's key stayed with the tab that sent it, and its
			// executionId already identifies it everywhere a key would.
			const clientRequestKey = attachExecutionId
				? null
				: newClientRequestKey();
			const started = beginTurn({
				content,
				displayImageUrls,
				forceNewChat,
				attachExecutionId,
				clientRequestKey,
				conversationId: effectiveConversationId ?? null,
			});
			const { assistantMessage, controller: sendController } = started;

			try {
				// Debug: Log workspace IDs being sent
				console.log(
					"[useOrchestratorStream] Sending request with workspaceIds:",
					workspaceIds,
					"conversationId:",
					effectiveConversationId,
				);

				// Start the streaming workflow
				// Pass conversationId so backend can fetch attached workspaces if workspaceIds is empty
				const initialRequestBody = JSON.stringify({
					message: content.trim(),
					history: history.map((m) => ({
						role: m.role,
						content: m.content,
					})),
					...orchestratorRequestFields(
						{ ...optionsRef.current, surface: surfaceRef.current },
						{
							templateInstructions,
							templateIntegrationIds,
							templateMcpConfigIds,
							templateFabricToolIds,
							sessionDocumentIds,
						},
					),
					inlineAttachmentContexts,
					conversationId: effectiveConversationId,
					continueFromTurnId: overrides?.continueFromTurnId,
					attachedImageUrls,
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
								signal: abortControllerRef.current?.signal,
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
									refuseBecauseAnotherTurnIsLive(
										started,
										clientRequestKey,
									);
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
								settleCancelledBeforeStart(assistantMessage.id);
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
								settleUsageLimitRefusal();
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
							turn.setState((prev) => ({ ...prev, apiBilling }));
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
						assistantMessage.id,
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
					assistantMessage.id,
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
			workspaceIds,
			conversationId,
			instanceId,
			beginTurn,
			handleStreamEvent,
			refuseBecauseAnotherTurnIsLive,
			settleCancelledBeforeStart,
			settleUsageLimitRefusal,
			failWithoutDiscardingContent,
			setProgressMessage,
			turn.setState,
			abortControllerRef,
			cancelledMessageIdsRef,
			executionIdRef,
			showAiUsageLimitToastRef,
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

				settleAnsweredApproval(decidedApprovalId, approved, result);
				return result;
			} catch (error) {
				console.error("[OrchestratorStream] Approval error:", error);
				return "failed";
			}
		},
		[state.executionId, latestApprovalIdRef, settleAnsweredApproval],
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
				settleAnsweredClarification(
					state.pendingClarification?.question,
					answer,
					dismissed,
				);
				return true;
			} catch (error) {
				console.error(
					"[OrchestratorStream] Clarification error:",
					error,
				);
				return false;
			}
		},
		[
			state.executionId,
			state.pendingClarification,
			settleAnsweredClarification,
		],
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
			const followUpMessage = showFollowUp(message);

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
				removeMessage(followUpMessage.id);
				return false;
			}
		},
		[state.executionId, state.status, showFollowUp, removeMessage],
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
			const stopped = flipToStopped(triggeredBy);
			if (!stopped) {
				return;
			}

			// 3. Fire-and-forget cancel POST against the existing
			// orchestrator-temporal cancel route. We only await the
			// response to detect failure for the toast — the UI does
			// NOT depend on it (decision 11 /). Before `started` there is
			// no executionId yet: the message's key identifies the turn
			// (or, if the server has not created it, leaves a tombstone so
			// it never starts).
			const { executionId, clientRequestKey } = stopped;
			if (executionId || clientRequestKey) {
				void fetch(
					"/api/agents/fabric-ai/orchestrator-temporal/cancel",
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							...(executionId ? { executionId } : {}),
							...(clientRequestKey ? { clientRequestKey } : {}),
							...(stopped.conversationId
								? {
										conversationId: stopped.conversationId,
									}
								: {}),
							...(stopped.organizationId
								? { organizationId: stopped.organizationId }
								: {}),
						}),
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
		[flipToStopped],
	);

	/**
	 * Backward-compat alias — `cancel` now routes through `stop`.
	 * Existing destructurers continue to compile while consumers migrate
	 * to the new name.
	 */
	const cancel = useCallback(() => {
		stop("button");
	}, [stop]);

	return {
		...turn.view,

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
		reset: turn.reset,
	};
}
