"use client";

/**
 * useOrchestratorRuntimeStream
 *
 * The Orchestrator chat over the agent runtime (`/api/agents/runtime`, agent
 * `fabric-orchestrator`): the same options and the same return shape as
 * `useOrchestratorStream`, and the same turn state
 * (`useOrchestratorTurnState`), so the chat only picks which one runs
 * (`useOrchestratorChatStream`). The wire protocol is in
 * `lib/orchestrator-runtime-protocol.ts`; following one turn across its
 * responses is `lib/orchestrator-runtime-turn.ts`.
 *
 * What differs from the stream route is the runtime's, not the chat's:
 * - Thread = conversation. The thread id is the conversation's id when the
 *   chat has one, else a UUID minted for the new chat; the runtime creates
 *   the conversation and saves every turn into it, so the chat saves nothing
 *   itself (`onConversationStarted` says when the conversation exists).
 * - A response ends inside its window, or drops, while the turn goes on:
 *   the hook connects to the thread again and follows the same turn.
 * - An approval or a clarifying question ends the response; the answer is a
 *   run that resumes the turn and follows it on.
 * - A follow-up is a run on the thread while the turn runs. Once the runtime
 *   acknowledges it, its response replaces the one being read.
 * - Stop goes to the runtime's stop for the thread. The response is read on
 *   (showing nothing more) until the stopped turn ends, so the runtime saves
 *   the turn as far as it had got.
 */

import type { RunAgentInput } from "@ag-ui/client";
import { isAiUsageLimitExceededPayload } from "@saas/payments/lib/ai-usage-limit-toast";
import {
	describeAiError,
	isChatGptPlanSpentCode,
} from "@saas/shared/lib/ai-error-message";
import { useCallback, useRef } from "react";
import type { ApprovalSendResult } from "../lib/approval-response";
import { runtimeHeaders } from "../lib/direct-runtime-transport";
import { orchestratorRequestFields } from "../lib/orchestrator-request";
import { orchestratorTurnMessageIds } from "../lib/orchestrator-runtime-protocol";
import {
	ORCHESTRATOR_RUNTIME_PATHS,
	OrchestratorRuntimeTurn,
	type RuntimeDecision,
	type RuntimeRefusal,
} from "../lib/orchestrator-runtime-turn";
import {
	newClientRequestKey,
	type SendMessageOverrides,
	type UseOrchestratorStreamOptions,
} from "../lib/orchestrator-stream-types";
import type { useOrchestratorStream } from "./useOrchestratorStream";
import {
	type StartedTurn,
	useOrchestratorTurnState,
} from "./useOrchestratorTurnState";

/** How long a send waits for the previous, stopped turn to end. */
const STOP_SETTLE_MS = 5_000;

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The interrupt is no longer pending: nothing the answer could decide. */
function isGone(decision: RuntimeDecision): boolean {
	return (
		decision.kind === "stale" ||
		(decision.kind === "refused" &&
			decision.refusal.code === "INTERRUPT_NOT_PENDING")
	);
}

/** An answer to the turn's interrupt, as the run that resumes it. */
function resumeInput(
	threadId: string,
	interruptId: string,
	status: "resolved" | "cancelled",
	payload: Record<string, unknown>,
): RunAgentInput {
	return {
		threadId,
		runId: newClientRequestKey(),
		messages: [],
		tools: [],
		context: [],
		state: {},
		resume: [{ interruptId, status, payload }],
	};
}

export function useOrchestratorRuntimeStream(
	options: UseOrchestratorStreamOptions = {},
): ReturnType<typeof useOrchestratorStream> {
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const turnState = useOrchestratorTurnState(options);
	const turnStateRef = useRef(turnState);
	turnStateRef.current = turnState;
	const { state, isLoading } = turnState;

	/** The thread this chat runs on: adopted from the conversation, or minted. */
	const threadIdRef = useRef<string | null>(null);
	const activeTurnRef = useRef<OrchestratorRuntimeTurn | null>(null);

	/** A send's refusal, settled as the stream route's chat settles it. */
	const settleRefusal = useCallback(
		(started: StartedTurn, turnKey: string | null) =>
			(refusal: RuntimeRefusal): boolean => {
				const current = turnStateRef.current;
				switch (refusal.code) {
					case "TURN_IN_PROGRESS":
						current.refuseBecauseAnotherTurnIsLive(
							started,
							turnKey,
						);
						return true;
					case "TURN_CANCELLED":
						current.settleCancelledBeforeStart(
							started.assistantMessage.id,
						);
						return true;
					case "AI_USAGE_LIMIT_EXCEEDED": {
						const { body } = refusal;
						const payload = isAiUsageLimitExceededPayload(body.data)
							? body.data
							: isAiUsageLimitExceededPayload(body)
								? body
								: null;
						if (payload) {
							current.showAiUsageLimitToastRef.current(payload);
						}
						current.settleUsageLimitRefusal();
						return true;
					}
					default:
						if (isChatGptPlanSpentCode(refusal.code)) {
							current.failWithoutDiscardingContent(
								started.assistantMessage.id,
								describeAiError(
									refusal.status ?? 429,
									refusal.body,
								).description,
								true,
							);
							return true;
						}
						return false;
				}
			},
		[],
	);

	/** Put a turn on screen and make it the one the hook follows. */
	const beginFollowedTurn = useCallback(
		(args: {
			content: string;
			displayImageUrls: string[] | undefined;
			forceNewChat: boolean;
			attachExecutionId: string | null;
			threadId: string;
			newThread: boolean;
			turnKey: string | null;
		}): OrchestratorRuntimeTurn => {
			const current = turnStateRef.current;
			const started = current.beginTurn({
				content: args.content,
				displayImageUrls: args.displayImageUrls,
				forceNewChat: args.forceNewChat,
				attachExecutionId: args.attachExecutionId,
				clientRequestKey: args.turnKey,
				conversationId: args.threadId,
			});
			const assistantId = started.assistantMessage.id;
			const turn = new OrchestratorRuntimeTurn(
				args.threadId,
				args.turnKey,
				args.newThread,
				{
					organizationId: () => optionsRef.current.organizationId,
					isShown: () => !started.controller.signal.aborted,
					isStopped: () =>
						turnStateRef.current.cancelledMessageIdsRef.current.has(
							assistantId,
						),
					executionId: () =>
						turnStateRef.current.executionIdRef.current,
					applyEvent: (event) =>
						turnStateRef.current.handleStreamEvent(
							event,
							assistantId,
						),
					setBilling: (apiBilling) =>
						turnStateRef.current.setState((prev) => ({
							...prev,
							apiBilling,
						})),
					setProgress: (message) =>
						turnStateRef.current.setProgressMessage(message),
					conversationStarted: (threadId) =>
						optionsRef.current.onConversationStarted?.(threadId),
					fail: (reason) =>
						turnStateRef.current.failWithoutDiscardingContent(
							assistantId,
							reason,
							true,
						),
					settleRefusal: settleRefusal(started, args.turnKey),
				},
			);
			// Stop, reset, unmount and a newer turn abort the turn's controller.
			started.controller.signal.addEventListener(
				"abort",
				() => turn.release(),
				{ once: true },
			);
			activeTurnRef.current = turn;
			threadIdRef.current = args.threadId;
			return turn;
		},
		[settleRefusal],
	);

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
			/** Images to display as thumbnails (only newly attached) */
			displayImageUrls?: string[],
			sessionDocumentIds?: string[],
			inlineAttachmentContexts?: string[],
			overrides?: SendMessageOverrides,
		) => {
			if (!content.trim() || isLoading) {
				return null;
			}
			const previous = activeTurnRef.current;
			const currentOptions = optionsRef.current;
			const attachExecutionId = overrides?.attachExecutionId ?? null;
			const knownThread =
				overrides?.conversationId ??
				(forceNewChat
					? null
					: (currentOptions.conversationId ?? threadIdRef.current));
			if (attachExecutionId && !knownThread) {
				return null;
			}
			const threadId = knownThread ?? crypto.randomUUID();
			const forwardedProps = {
				...orchestratorRequestFields(currentOptions, {
					templateInstructions,
					templateIntegrationIds,
					templateMcpConfigIds,
					templateFabricToolIds,
					sessionDocumentIds,
				}),
				inlineAttachmentContexts,
				attachedImageUrls,
				displayImageUrls,
				continueFromTurnId: overrides?.continueFromTurnId,
				conversationSettings: {
					...currentOptions.conversationSettings,
					...(overrides?.documentChatId
						? { documentChatId: overrides.documentChatId }
						: {}),
				},
			};
			const multiAgentSend = currentOptions.multiAgentSend;
			if (
				multiAgentSend &&
				!attachExecutionId &&
				!overrides?.continueFromTurnId
			) {
				threadIdRef.current = threadId;
				await multiAgentSend({
					threadId,
					content: content.trim(),
					history,
					forwardedProps,
					displayImageUrls,
					onRefused: () =>
						currentOptions.onTurnRefused?.(content.trim()),
				});
				return null;
			}
			const runId = attachExecutionId ? null : newClientRequestKey();
			const turn = beginFollowedTurn({
				content,
				displayImageUrls,
				forceNewChat,
				attachExecutionId,
				threadId,
				newThread: knownThread === null,
				turnKey: runId,
			});

			// The runtime takes one turn per thread: let a stopped one end first.
			if (previous?.loop) {
				await Promise.race([previous.loop, sleep(STOP_SETTLE_MS)]);
			}
			if (turn.released) {
				return null;
			}
			if (!runId) {
				turn.connect();
			} else {
				turn.send({
					threadId,
					runId,
					messages: [
						...history.map((message, index) => ({
							id: `${runId}-history-${index}`,
							role: message.role,
							content: message.content,
						})),
						{
							id: orchestratorTurnMessageIds(runId).user,
							role: "user" as const,
							content: content.trim(),
						},
					],
					tools: [],
					context: [],
					state: {},
					forwardedProps,
				});
			}
			await turn.loop;
			return turnStateRef.current.executionIdRef.current;
		},
		[isLoading, beginFollowedTurn],
	);

	/**
	 * Show a turn that is already running (a reload mid-turn, another tab)
	 * as the live turn, by connecting to its conversation.
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
	 * An answer that found no turn waiting: connect, so the turn shows how it
	 * ended.
	 */
	const followGoneTurn = (
		turn: OrchestratorRuntimeTurn,
		decision: RuntimeDecision,
	) => {
		if (
			decision.kind === "refused" &&
			decision.refusal.code === "INTERRUPT_NOT_PENDING" &&
			!turn.loop
		) {
			turn.connect();
		}
	};

	/**
	 * Answer the pending approval. "stale" means the run no longer waits on
	 * it; its card is cleared like an answered one.
	 */
	const sendApproval = useCallback(
		async (
			approved: boolean,
			feedback?: string,
		): Promise<ApprovalSendResult> => {
			const turn = activeTurnRef.current;
			const decidedApprovalId =
				turnStateRef.current.latestApprovalIdRef.current;
			if (!turn || !state.executionId || !decidedApprovalId) {
				return "failed";
			}
			const decision = await turn.request(
				"answer",
				resumeInput(turn.threadId, decidedApprovalId, "resolved", {
					approved,
					...(feedback ? { feedback } : {}),
				}),
			);
			followGoneTurn(turn, decision);
			const result: ApprovalSendResult =
				decision.kind === "accepted"
					? "sent"
					: isGone(decision)
						? "stale"
						: "failed";
			if (result === "failed") {
				console.error(
					"[OrchestratorRuntime] Approval error:",
					decision,
				);
				return result;
			}
			turnStateRef.current.settleAnsweredApproval(
				decidedApprovalId,
				approved,
				result,
			);
			return result;
		},
		[state.executionId],
	);

	/** Answer (or dismiss) the pending clarifying question. */
	const sendClarification = useCallback(
		async (answer: string, dismissed = false) => {
			const turn = activeTurnRef.current;
			const pending = state.pendingClarification;
			if (!turn || !state.executionId || !pending?.clarificationId) {
				return false;
			}
			const decision = await turn.request(
				"answer",
				resumeInput(
					turn.threadId,
					pending.clarificationId,
					dismissed ? "cancelled" : "resolved",
					dismissed ? { dismissed: true } : { answer },
				),
			);
			followGoneTurn(turn, decision);
			if (decision.kind === "accepted") {
				turnStateRef.current.settleAnsweredClarification(
					pending.question,
					answer,
					dismissed,
				);
				return true;
			}
			if (isGone(decision)) {
				// The run no longer waits on this question: its card goes.
				turnStateRef.current.settleAnsweredClarification(
					pending.question,
					"",
					true,
				);
				return false;
			}
			console.error(
				"[OrchestratorRuntime] Clarification error:",
				decision,
			);
			return false;
		},
		[state.executionId, state.pendingClarification],
	);

	/**
	 * Send a follow-up into the running turn. Only while a turn is in
	 * progress; false when it is not (the chat then sends a new message).
	 */
	const sendFollowUp = useCallback(
		async (message: string, isModification = false) => {
			const turn = activeTurnRef.current;
			if (
				!turn ||
				!state.executionId ||
				(state.status !== "running" &&
					state.status !== "awaiting_approval")
			) {
				console.warn(
					"[OrchestratorRuntime] Cannot send follow-up: execution not active",
				);
				return false;
			}
			// Shown as the user's message at once, as the stream route's chat.
			const followUpMessage = turnStateRef.current.showFollowUp(message);
			const runId = newClientRequestKey();
			const decision = await turn.request("follow-up", {
				threadId: turn.threadId,
				runId,
				messages: [
					{ id: `${runId}:user`, role: "user", content: message },
				],
				tools: [],
				context: [],
				state: {},
				forwardedProps: { followUp: { isModification } },
			});
			if (decision.kind === "accepted") {
				return true;
			}
			console.error("[OrchestratorRuntime] Follow-up error:", decision);
			turnStateRef.current.removeMessage(followUpMessage.id);
			return false;
		},
		[state.executionId, state.status],
	);

	/**
	 * Stop the current turn: the same synchronous flip, freeze gate and
	 * telemetry as the stream route's chat (`flipToStopped`), then the
	 * runtime's stop for the thread, naming the turn by its key (before the
	 * turn exists, the key is tombstoned so the message never starts).
	 */
	const stop = useCallback((triggeredBy: "button" | "esc" = "button") => {
		const stopped = turnStateRef.current.flipToStopped(triggeredBy);
		const turn = activeTurnRef.current;
		if (!stopped || !turn || turn.ended) {
			return;
		}
		void fetch(ORCHESTRATOR_RUNTIME_PATHS.stop(turn.threadId), {
			method: "POST",
			headers: runtimeHeaders(optionsRef.current.organizationId),
			body: JSON.stringify(
				turn.stopRunId ? { runId: turn.stopRunId } : {},
			),
		})
			.then((response) => {
				if (!response.ok) {
					optionsRef.current.onStopFailed?.();
				}
			})
			.catch(() => {
				optionsRef.current.onStopFailed?.();
			});
	}, []);

	const cancel = useCallback(() => {
		stop("button");
	}, [stop]);

	const reset = useCallback(() => {
		turnStateRef.current.reset();
		activeTurnRef.current = null;
		threadIdRef.current = null;
	}, []);

	return {
		...turnState.view,
		sendMessage,
		attach,
		sendApproval,
		sendClarification,
		sendFollowUp,
		stop,
		cancel,
		reset,
	};
}
