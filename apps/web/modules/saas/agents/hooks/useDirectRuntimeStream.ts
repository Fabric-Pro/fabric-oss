"use client";

/**
 * useDirectRuntimeStream
 *
 * The Fabric AI Direct chat over the agent runtime (`/api/agents/runtime`,
 * agent `fabric-direct`): the same options and the same return shape as
 * `useDirectStream`, so the chat only picks which one runs.
 *
 * What differs from the stream route is the runtime's, not the chat's:
 * - Thread = conversation. The thread id is the conversation's id when the
 *   chat has one, else a UUID minted for the new chat; the runtime creates the
 *   conversation under it on the first run and saves every turn into it, so
 *   the chat does not save turns itself (`onConversationStarted` says when the
 *   conversation exists).
 * - A response ends inside its window while the turn goes on; the hook then
 *   reconnects to the thread and keeps following the same turn.
 * - Opening a conversation whose turn is still running reattaches to it.
 * - Stop goes to the runtime's stop for the thread; approving a tool answers
 *   the run's interrupt instead of sending the call back.
 */

import type { Message, RunAgentInput } from "@ag-ui/client";
import { useShowAiUsageLimitToast } from "@saas/payments/lib/ai-usage-limit-toast";
import { useCallback, useEffect, useRef, useState } from "react";
import { emitCancelEvent } from "../lib/cancel-telemetry";
import { settleUnfinishedToolCalls } from "../lib/direct-chat-turns";
import {
	type RuntimeSignal,
	type RuntimeToolCall,
	readRuntimeEvent,
	savedMessagesToAdopt,
	snapshotDirectMessages,
} from "../lib/direct-runtime-events";
import {
	connectInput,
	DIRECT_RUNTIME_PATHS,
	directTurnInput,
	errorMessageOf,
	isAbortError,
	runtimeHeaders,
	streamRuntime,
} from "../lib/direct-runtime-transport";
import {
	applyDirectStreamEvent,
	type DirectStreamEventContext,
} from "../lib/direct-stream-events";
import type { DirectStreamEvent } from "../lib/direct-stream-protocol";
import { loadInstanceAgentConfig } from "../lib/load-instance-agent-config";
import type {
	ContextInfo,
	DirectSendOptions,
	DirectStreamMessage,
	DirectStreamState,
	StreamModelInfo,
	TokenUsage,
	UseDirectStreamOptions,
	useDirectStream,
} from "./useDirectStream";

/** Context token limit by model (conservative estimate), as the stream route's chat. */
const MAX_CONTEXT_TOKENS = 100_000;

/**
 * How many reconnects in a row may find the turn neither running nor saved
 * before the chat stops waiting for it.
 */
const MAX_SILENT_RECONNECTS = 3;
const SILENT_RECONNECT_DELAY_MS = 1_000;

/**
 * How long a send waits for a stopped turn's response to end: the runtime
 * refuses a second turn while the first is still running.
 */
const STOP_DRAIN_MS = 5_000;

const LOST_TURN_MESSAGE =
	"The connection to this reply was lost. Reopen the conversation to see how it ended.";

export interface UseDirectRuntimeStreamOptions extends UseDirectStreamOptions {
	/**
	 * The runtime created the conversation for a new chat: its first run
	 * started, under this id (the thread id).
	 */
	onConversationStarted?: (conversationId: string) => void;
	/**
	 * The conversation the chat shows while the hook has no messages of its
	 * own (the one it loaded when it was opened). A reattach that finds turns
	 * saved since, and no running turn, shows them in its place; without it
	 * the hook never replaces what the chat loaded.
	 */
	shownMessages?: readonly DirectStreamMessage[];
}

/** One turn the hook is following. */
interface ActiveTurn {
	threadId: string;
	/** The AG-UI run id the turn was sent with (the stop names it). */
	runId: string;
	/** The turn's key on the runtime: the run id, or `<interruptId>:resume`. */
	turnKey: string;
	assistantId: string;
	/** The chat minted this thread: say when its conversation exists. */
	newThread: boolean;
	controller: AbortController;
	tools: Map<string, RuntimeToolCall>;
	/** A terminal event (finished, error, cancelled) arrived. */
	ended: boolean;
	usageLimitReached: boolean;
	/** The latest response showed the turn running. */
	live: boolean;
	/** The latest connect found the turn already saved. */
	saved: boolean;
	/**
	 * The chat let go of the turn (a reset, an unmount): it shows nothing
	 * more and changes no state. A stopped turn's response still runs to its
	 * end, so the runtime saves the answer as far as it had streamed.
	 */
	detached: boolean;
	done?: Promise<void>;
}

/**
 * Let go of the followed turn and of a reattach in flight: a stopped turn
 * drains its response (a reattached one shares the reattach's controller),
 * anything else is aborted.
 */
function releaseTurn(
	turn: ActiveTurn | null,
	stopped: ReadonlySet<string>,
	attachController: AbortController | null,
) {
	if (attachController && attachController !== turn?.controller) {
		attachController.abort();
	}
	if (!turn) {
		return;
	}
	turn.detached = true;
	if (!stopped.has(turn.assistantId)) {
		turn.controller.abort();
	}
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export function useDirectRuntimeStream(
	options: UseDirectRuntimeStreamOptions = {},
): ReturnType<typeof useDirectStream> {
	const {
		organizationId,
		initialMessages,
		conversationId,
		surface = "loom-direct",
		onStopFailed,
		onAnalyticsEvent,
		onConversationStarted,
	} = options;

	// The latest options a send reads, so a turn carries what the chat
	// showed when it was sent without recreating the callbacks.
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const surfaceRef = useRef(surface);
	surfaceRef.current = surface;
	const onStopFailedRef = useRef(onStopFailed);
	onStopFailedRef.current = onStopFailed;
	const onAnalyticsEventRef = useRef(onAnalyticsEvent);
	onAnalyticsEventRef.current = onAnalyticsEvent;
	const onConversationStartedRef = useRef(onConversationStarted);
	onConversationStartedRef.current = onConversationStarted;
	const organizationIdRef = useRef(organizationId);
	organizationIdRef.current = organizationId;
	const conversationIdRef = useRef(conversationId);
	conversationIdRef.current = conversationId;
	const showAiUsageLimitToast = useShowAiUsageLimitToast();
	const showAiUsageLimitToastRef = useRef(showAiUsageLimitToast);
	showAiUsageLimitToastRef.current = showAiUsageLimitToast;

	const [messages, setMessages] = useState<DirectStreamMessage[]>(
		initialMessages ?? [],
	);
	const [isLoading, setIsLoading] = useState(false);
	const [state, setState] = useState<DirectStreamState>({ status: "idle" });
	const [contextInfo, setContextInfo] = useState<ContextInfo>({
		estimatedTokens: 0,
		messageCount: 0,
		wasCompacted: false,
		maxTokens: MAX_CONTEXT_TOKENS,
	});
	/** Bumped by `reset`, so the chat's conversation is attached again. */
	const [resetCount, setResetCount] = useState(0);

	const startFreshRef = useRef(false);
	const needsTextSeparatorRef = useRef(false);
	const cancelledMessageIdsRef = useRef<Set<string>>(new Set());
	const erroredMessagesRef = useRef<Map<string, string>>(new Map());
	const streamStartedAtRef = useRef<number | null>(null);
	const executionIdRef = useRef<string | null>(null);
	const activeAssistantIdRef = useRef<string | null>(null);
	const messagesRef = useRef<DirectStreamMessage[]>(initialMessages ?? []);
	/** The thread this chat runs on: adopted from the conversation, or minted. */
	const threadIdRef = useRef<string | null>(null);
	const activeTurnRef = useRef<ActiveTurn | null>(null);
	const attachControllerRef = useRef<AbortController | null>(null);
	/** The approval the thread's last turn stopped on, answered by a resume. */
	const pendingInterruptRef = useRef<{
		threadId: string;
		interruptId: string;
	} | null>(null);

	const eventContext: DirectStreamEventContext = {
		setMessages,
		setState,
		setContextInfo,
		cancelledMessageIdsRef,
		erroredMessagesRef,
		needsTextSeparatorRef,
		executionIdRef,
		onAnalyticsEventRef,
		showAiUsageLimitToastRef,
	};
	const eventContextRef = useRef(eventContext);
	eventContextRef.current = eventContext;

	const calculateContextInfo = useCallback(
		(msgs: DirectStreamMessage[]): ContextInfo => {
			const estimatedTokens = Math.ceil(
				msgs.reduce(
					(sum, m) => sum + Math.ceil(m.content.length / 4),
					0,
				),
			);
			return {
				estimatedTokens,
				messageCount: msgs.length,
				wasCompacted: estimatedTokens > MAX_CONTEXT_TOKENS * 0.8,
				maxTokens: MAX_CONTEXT_TOKENS,
			};
		},
		[],
	);

	const updateAssistant = useCallback(
		(
			assistantId: string,
			update: (message: DirectStreamMessage) => DirectStreamMessage,
		) => {
			setMessages((prev) =>
				prev.map((m) => (m.id === assistantId ? update(m) : m)),
			);
		},
		[],
	);

	const applyEvent = useCallback(
		(turn: ActiveTurn, event: DirectStreamEvent) => {
			if (
				event.type === "error" &&
				event.code === "AI_USAGE_LIMIT_EXCEEDED" &&
				event.partial !== true
			) {
				turn.usageLimitReached = true;
			}
			applyDirectStreamEvent(
				event,
				turn.assistantId,
				eventContextRef.current,
			);
		},
		[],
	);

	/** The turn's answer as the runtime saved it, in place of what streamed. */
	const settleFromSnapshot = useCallback(
		(turn: ActiveTurn, saved: DirectStreamMessage) => {
			updateAssistant(turn.assistantId, (m) => ({
				...saved,
				id: m.id,
				timestamp: m.timestamp,
				executionId: m.executionId,
				apiBilling: saved.apiBilling ?? m.apiBilling,
				isStreaming: false,
			}));
			if (saved.isError && saved.errorMessage) {
				erroredMessagesRef.current.set(
					turn.assistantId,
					saved.errorMessage,
				);
			}
			if (saved.usage || saved.model) {
				setContextInfo((prev) => ({
					...prev,
					usage: saved.usage ?? prev.usage,
					maxTokens: saved.model?.contextWindow ?? prev.maxTokens,
					modelId: saved.model?.id ?? prev.modelId,
					modelLabel:
						saved.model?.canonicalName ??
						saved.model?.id ??
						prev.modelLabel,
				}));
			}
		},
		[updateAssistant],
	);

	/**
	 * One signal of a response that follows `turn`. `replaying` is a response
	 * other than the run's own (a reconnect or a reattach): its turn starts
	 * over from the beginning, because the runtime replays it cumulatively.
	 */
	const applySignal = useCallback(
		(turn: ActiveTurn, signal: RuntimeSignal, replaying: boolean) => {
			// A stopped or released turn shows nothing more; its response only ends.
			if (
				turn.detached ||
				cancelledMessageIdsRef.current.has(turn.assistantId)
			) {
				if (
					signal.kind === "finished" ||
					signal.kind === "failed" ||
					signal.kind === "cancelled"
				) {
					turn.ended = true;
				}
				return;
			}
			switch (signal.kind) {
				case "event":
					if (!turn.saved) {
						applyEvent(turn, signal.event);
					}
					return;
				case "run-started":
					// A run is announced under the client's run id; a connect
					// names the turn by its key (they differ for an approval).
					if (
						(signal.runId !== turn.turnKey &&
							signal.runId !== turn.runId) ||
						turn.saved
					) {
						return;
					}
					turn.live = true;
					if (replaying) {
						turn.tools.clear();
						needsTextSeparatorRef.current = false;
						updateAssistant(turn.assistantId, (m) => ({
							...m,
							content: "",
							reasoningText: undefined,
							reasoningDurationMs: undefined,
							toolCalls: [],
							sources: undefined,
							statusLabel: undefined,
						}));
					}
					if (turn.newThread) {
						turn.newThread = false;
						onConversationStartedRef.current?.(turn.threadId);
					}
					return;
				case "snapshot": {
					if (!replaying) {
						return;
					}
					const saved = snapshotDirectMessages(signal.messages).find(
						(m) => m.id === `${turn.turnKey}:assistant`,
					);
					if (saved) {
						turn.saved = true;
						turn.ended = true;
						settleFromSnapshot(turn, saved);
					}
					return;
				}
				case "billing":
					updateAssistant(turn.assistantId, (m) => ({
						...m,
						apiBilling: signal.apiBilling,
					}));
					return;
				case "interrupt":
					pendingInterruptRef.current = {
						threadId: turn.threadId,
						interruptId: signal.interruptId,
					};
					return;
				case "finished":
				case "failed":
					turn.ended = true;
					return;
				case "cancelled": {
					// Stopped elsewhere (another tab, or before it started).
					turn.ended = true;
					cancelledMessageIdsRef.current.add(turn.assistantId);
					const cancelledAt = new Date().toISOString();
					updateAssistant(turn.assistantId, (m) => ({
						...m,
						isStreaming: false,
						streamStatus: "cancelled",
						cancelledAt,
						toolCalls: settleUnfinishedToolCalls(m.toolCalls),
					}));
					setIsLoading(false);
					setState({ status: "cancelled" });
					return;
				}
				case "reconnect":
					return;
				default: {
					const unhandled: never = signal;
					console.warn("[DirectRuntime] Unhandled signal", unhandled);
				}
			}
		},
		[applyEvent, settleFromSnapshot, updateAssistant],
	);

	/** Follow one response of the turn to its end. */
	const followResponse = useCallback(
		(
			turn: ActiveTurn,
			url: string,
			input: RunAgentInput,
			replaying: boolean,
		) =>
			streamRuntime({
				url,
				input,
				organizationId: organizationIdRef.current,
				signal: turn.controller.signal,
				onEvent: (event) => {
					for (const signal of readRuntimeEvent(event, turn.tools)) {
						applySignal(turn, signal, replaying);
					}
				},
			}),
		[applySignal],
	);

	/**
	 * Reconnect until the turn ends: a response ends inside its window, or
	 * drops, while the turn goes on.
	 */
	const followUntilEnded = useCallback(
		async (turn: ActiveTurn) => {
			let silent = 0;
			while (
				!turn.ended &&
				!turn.detached &&
				!turn.controller.signal.aborted &&
				!cancelledMessageIdsRef.current.has(turn.assistantId)
			) {
				turn.live = false;
				await followResponse(
					turn,
					DIRECT_RUNTIME_PATHS.connect,
					connectInput(turn.threadId),
					true,
				);
				if (turn.ended || turn.live) {
					silent = 0;
					continue;
				}
				silent += 1;
				if (silent >= MAX_SILENT_RECONNECTS) {
					applyEvent(turn, {
						type: "error",
						message: LOST_TURN_MESSAGE,
					});
					return;
				}
				await sleep(SILENT_RECONNECT_DELAY_MS);
			}
		},
		[applyEvent, followResponse],
	);

	/** What the stream route's chat does once a turn's stream is over. */
	const finishTurn = useCallback(
		(turn: ActiveTurn) => {
			if (
				turn.detached ||
				turn.usageLimitReached ||
				cancelledMessageIdsRef.current.has(turn.assistantId)
			) {
				return;
			}
			const failure = erroredMessagesRef.current.get(turn.assistantId);
			updateAssistant(turn.assistantId, (m) => ({
				...m,
				isStreaming: false,
				streamStatus: failure ? "error" : "completed",
				toolCalls: settleUnfinishedToolCalls(m.toolCalls),
			}));
			setState(
				failure
					? { status: "error", error: failure }
					: { status: "completed" },
			);
		},
		[updateAssistant],
	);

	const failTurn = useCallback(
		(turn: ActiveTurn, error: unknown) => {
			if (turn.detached) {
				return;
			}
			if (isAbortError(error)) {
				if (!cancelledMessageIdsRef.current.has(turn.assistantId)) {
					setState({ status: "idle" });
				}
				return;
			}
			if (cancelledMessageIdsRef.current.has(turn.assistantId)) {
				return;
			}
			const errorMessage = errorMessageOf(error);
			erroredMessagesRef.current.set(turn.assistantId, errorMessage);
			updateAssistant(turn.assistantId, (m) => ({
				...m,
				errorMessage,
				isStreaming: false,
				isError: true,
				streamStatus: "error",
				toolCalls: settleUnfinishedToolCalls(m.toolCalls),
			}));
			setState({ status: "error", error: errorMessage });
		},
		[updateAssistant],
	);

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
			const previous = activeTurnRef.current;
			const shouldStartFresh = forceNewChat || startFreshRef.current;
			startFreshRef.current = false;

			const knownThread = forceNewChat
				? (conversationIdRef.current ?? null)
				: (threadIdRef.current ?? conversationIdRef.current ?? null);
			const threadId = knownThread ?? crypto.randomUUID();
			threadIdRef.current = threadId;
			const interrupt =
				approvedToolCall &&
				pendingInterruptRef.current?.threadId === threadId
					? pendingInterruptRef.current
					: null;
			pendingInterruptRef.current = null;

			setIsLoading(true);
			setState({ status: "streaming" });
			executionIdRef.current = null;
			streamStartedAtRef.current = Date.now();

			const userMessage: DirectStreamMessage = {
				id: `msg-${crypto.randomUUID()}`,
				role: "user",
				content: content.trim(),
				timestamp: new Date(),
				...(attachmentNames && attachmentNames.length > 0
					? { attachmentNames }
					: {}),
			};
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

			const runId = crypto.randomUUID();
			const turn: ActiveTurn = {
				threadId,
				runId,
				turnKey: interrupt ? `${interrupt.interruptId}:resume` : runId,
				assistantId: assistantMessage.id,
				newThread: knownThread === null,
				controller: new AbortController(),
				tools: new Map(),
				ended: false,
				usageLimitReached: false,
				live: false,
				saved: false,
				detached: false,
			};
			activeTurnRef.current = turn;

			const follow = async () => {
				// A stopped turn is still settling: the runtime takes one turn
				// per thread at a time, so let its response end first.
				if (previous?.done) {
					await Promise.race([previous.done, sleep(STOP_DRAIN_MS)]);
				}
				previous?.controller.abort();
				const { instanceId, organizationId } = optionsRef.current;
				const agentConfig = instanceId
					? await loadInstanceAgentConfig(instanceId, organizationId)
					: null;
				turn.controller.signal.throwIfAborted();
				const input = directTurnInput({
					threadId,
					runId,
					question: {
						id: userMessage.id,
						content: userMessage.content,
					},
					history,
					interruptId: interrupt?.interruptId ?? null,
					options: optionsRef.current,
					send: {
						attachedDocumentIds,
						messageChatId,
						inlineAttachmentContexts,
					},
					agentConfig,
				});
				await followResponse(
					turn,
					DIRECT_RUNTIME_PATHS.run,
					input,
					false,
				);
				await followUntilEnded(turn);
			};

			const done = follow().then(
				() => finishTurn(turn),
				(error: unknown) => failTurn(turn, error),
			);
			turn.done = done;
			await done;
			if (
				!turn.detached &&
				!cancelledMessageIdsRef.current.has(turn.assistantId)
			) {
				setIsLoading(false);
			}
			return assistantMessage.id;
		},
		[isLoading, followResponse, followUntilEnded, finishTurn, failTurn],
	);

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

	/**
	 * A reattach with no running turn shows the turns saved since the chat
	 * loaded the conversation, with the context meter read from the latest
	 * answer as a reopened chat does. Nothing changes when there are none.
	 */
	const adoptSavedTurns = useCallback(
		(history: readonly Message[]) => {
			const shown =
				messagesRef.current.length > 0
					? messagesRef.current
					: optionsRef.current.shownMessages;
			const saved = shown ? savedMessagesToAdopt(history, shown) : null;
			if (!saved) {
				return;
			}
			setMessages(saved);
			const lastAnswered = [...saved]
				.reverse()
				.find((m) => m.role === "assistant" && m.usage);
			if (lastAnswered) {
				restoreContextUsage(lastAnswered.usage, lastAnswered.model);
			}
		},
		[restoreContextUsage],
	);

	/**
	 * Reattach to the thread's running turn, if it has one: the saved
	 * messages, then the turn as it runs. A thread with no running turn
	 * shows the turns saved since the chat loaded it, if any.
	 */
	const attach = useCallback(
		async (threadId: string) => {
			attachControllerRef.current?.abort();
			const controller = new AbortController();
			attachControllerRef.current = controller;
			// Written by the response's events: the saved messages, then the
			// running turn when there is one.
			const found: { history: Message[]; turn: ActiveTurn | null } = {
				history: [],
				turn: null,
			};
			const startTurn = (runId: string, question: string | null) => {
				const savedIds = new Set(found.history.map((m) => m.id));
				if (savedIds.has(`${runId}:assistant`)) {
					// A finished turn's approval raised again: the chat opened
					// on a saved conversation does not offer it again.
					return null;
				}
				const assistantId = `${runId}:assistant`;
				const attached: ActiveTurn = {
					threadId,
					runId,
					turnKey: runId,
					assistantId,
					newThread: false,
					controller,
					tools: new Map(),
					ended: false,
					usageLimitReached: false,
					live: true,
					saved: false,
					detached: false,
				};
				activeTurnRef.current = attached;
				activeAssistantIdRef.current = assistantId;
				executionIdRef.current = null;
				streamStartedAtRef.current = Date.now();
				const history = snapshotDirectMessages(found.history);
				const questionId = `${runId}:user`;
				// The runtime saves the question when it admits the turn.
				const asked = history.some((m) => m.id === questionId)
					? []
					: [
							{
								id: questionId,
								role: "user" as const,
								content: question ?? "",
								timestamp: new Date(),
							},
						];
				setMessages([
					...history,
					...asked,
					{
						id: assistantId,
						role: "assistant",
						content: "",
						timestamp: new Date(),
						isStreaming: true,
						toolCalls: [],
						streamStatus: "streaming",
					},
				]);
				setIsLoading(true);
				setState({ status: "streaming" });
				return attached;
			};
			try {
				await streamRuntime({
					url: DIRECT_RUNTIME_PATHS.connect,
					input: connectInput(threadId),
					organizationId: organizationIdRef.current,
					signal: controller.signal,
					onEvent: (event) => {
						const tools =
							found.turn?.tools ??
							new Map<string, RuntimeToolCall>();
						for (const signal of readRuntimeEvent(event, tools)) {
							if (found.turn) {
								applySignal(found.turn, signal, false);
							} else if (signal.kind === "snapshot") {
								found.history = signal.messages;
							} else if (signal.kind === "run-started") {
								found.turn = startTurn(
									signal.runId,
									signal.question,
								);
							}
						}
					},
				});
				const attached = found.turn;
				if (!attached) {
					if (!controller.signal.aborted) {
						adoptSavedTurns(found.history);
					}
					return;
				}
				const done = followUntilEnded(attached).then(
					() => finishTurn(attached),
					(error: unknown) => failTurn(attached, error),
				);
				attached.done = done;
				await done;
				if (
					!attached.detached &&
					!cancelledMessageIdsRef.current.has(attached.assistantId)
				) {
					setIsLoading(false);
				}
			} catch (error) {
				if (!isAbortError(error)) {
					console.warn(
						"[DirectRuntime] Could not reattach to the conversation",
						error,
					);
				}
			}
		},
		[applySignal, followUntilEnded, finishTurn, failTurn, adoptSavedTurns],
	);

	// Opening a conversation reattaches to its running turn. The chat's own
	// new thread is already this one, so writing its id back changes nothing.
	useEffect(() => {
		if (!conversationId || conversationId === threadIdRef.current) {
			return;
		}
		threadIdRef.current = conversationId;
		void attach(conversationId);
	}, [conversationId, resetCount, attach]);

	useEffect(
		() => () => {
			releaseTurn(
				activeTurnRef.current,
				cancelledMessageIdsRef.current,
				attachControllerRef.current,
			);
		},
		[],
	);

	/**
	 * Stop the current generation: the same synchronous flip, freeze gate,
	 * telemetry and failure callback as the stream route's chat. The stop
	 * goes to the runtime for the thread; the response stays open so the
	 * runtime saves the answer as far as it had streamed.
	 */
	const stop = useCallback(
		(triggeredBy: "button" | "esc" = "button", messageId?: string) => {
			const targetId = messageId ?? activeAssistantIdRef.current;
			if (!targetId || cancelledMessageIdsRef.current.has(targetId)) {
				return;
			}
			cancelledMessageIdsRef.current.add(targetId);

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

			const startedAt = streamStartedAtRef.current;
			const partialBody =
				messagesRef.current.find((m) => m.id === targetId)?.content ??
				"";
			emitCancelEvent({
				surface: surfaceRef.current,
				agentId: null,
				executionId: executionIdRef.current ?? null,
				partial_token_count: Math.ceil(partialBody.length / 4),
				latency_to_cancel_ms:
					startedAt !== null
						? Math.max(0, Date.now() - startedAt)
						: 0,
				triggered_by: triggeredBy,
			});

			const turn = activeTurnRef.current;
			if (!turn || turn.assistantId !== targetId || turn.ended) {
				return;
			}
			void fetch(DIRECT_RUNTIME_PATHS.stop(turn.threadId), {
				method: "POST",
				headers: runtimeHeaders(organizationIdRef.current),
				body: JSON.stringify({ runId: turn.runId }),
			})
				.then((response) => {
					if (!response.ok) {
						onStopFailedRef.current?.();
					}
				})
				.catch(() => {
					onStopFailedRef.current?.();
				});
		},
		[],
	);

	const cancel = useCallback(() => {
		stop("button");
	}, [stop]);

	const reset = useCallback(() => {
		releaseTurn(
			activeTurnRef.current,
			cancelledMessageIdsRef.current,
			attachControllerRef.current,
		);
		attachControllerRef.current = null;
		activeTurnRef.current = null;
		threadIdRef.current = null;
		pendingInterruptRef.current = null;
		setMessages([]);
		setIsLoading(false);
		setState({ status: "idle" });
		startFreshRef.current = true;
		cancelledMessageIdsRef.current = new Set();
		erroredMessagesRef.current = new Map();
		streamStartedAtRef.current = null;
		executionIdRef.current = null;
		activeAssistantIdRef.current = null;
		setResetCount((count) => count + 1);
	}, []);

	const seedMessages = useCallback(
		(existingMessages: DirectStreamMessage[]) => {
			setMessages(existingMessages);
			setContextInfo(calculateContextInfo(existingMessages));
			messagesRef.current = existingMessages;
		},
		[calculateContextInfo],
	);

	useEffect(() => {
		setContextInfo((prev) => ({
			...calculateContextInfo(messages),
			usage: prev.usage,
			maxTokens: prev.usage ? prev.maxTokens : MAX_CONTEXT_TOKENS,
			modelId: prev.modelId,
			modelLabel: prev.modelLabel,
		}));
		messagesRef.current = messages;
	}, [messages, calculateContextInfo]);

	return {
		messages,
		isLoading,
		state,
		contextInfo,
		sendMessage,
		stop,
		cancel,
		reset,
		seedMessages,
		restoreContextUsage,
		isStreaming: state.status === "streaming",
		isComplete: state.status === "completed" || state.status === "error",
	};
}
