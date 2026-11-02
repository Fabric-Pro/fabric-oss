"use client";

/**
 * useResearchRuntimeStream
 *
 * Deep Research over the agent runtime (`/api/agents/runtime`, agent
 * `deep-researcher`): the same options and the same return shape as
 * `useWorkflowTemplateStream`, plus `resultRestored`, so the page only picks
 * which one runs (`useResearchRunStream`).
 *
 * What differs from the stream route is the runtime's:
 * - Each research run is a new thread, which the runtime saves as a Fabric
 *   AI conversation in Research mode (`onConversationStarted` says when it
 *   exists). Opening such a conversation (`conversationId`) shows its saved
 *   result, or reattaches to the run while it still goes.
 * - A response ends inside its window while the run goes on; the hook then
 *   reconnects to the thread and keeps following the same run. So it does,
 *   a bounded number of times, after an error that could not confirm the
 *   run's start or state.
 * - The clarifying question ends a response as an interrupt; the answer is
 *   a run that resumes it.
 * - Stop goes to the runtime's stop for the thread. A stop the runtime did
 *   not take shows the run again as it goes on (`onStopFailed`).
 */

import { type AGUIEvent, EventType, type RunAgentInput } from "@ag-ui/client";
import type { ReasoningMode } from "@saas/agents/components/ReasoningModeSelector";
import { useShowAiUsageLimitToast } from "@saas/payments/lib/ai-usage-limit-toast";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import {
	connectInput,
	errorMessageOf,
	isAbortError,
	isRuntimeHttpError,
	runtimeHeaders,
	runtimePaths,
	streamRuntime,
} from "../lib/direct-runtime-transport";
import { applyResearchRuntimeEvent } from "../lib/research-runtime-events";
import {
	RESEARCH_AGENT_ID,
	researchTurnMessageIds,
} from "../lib/research-runtime-protocol";
import {
	INITIAL_WORKFLOW_TEMPLATE_STATE,
	workflowTemplateStreamView,
} from "../lib/workflow-template-state";
import type {
	UseWorkflowTemplateStreamOptions,
	WorkflowTemplateState,
} from "./useWorkflowTemplateStream";

const RESEARCH_RUNTIME_PATHS = runtimePaths(RESEARCH_AGENT_ID);

/**
 * How many reconnects in a row may find the run neither running nor ended
 * before the chat stops waiting for it.
 */
const MAX_SILENT_RECONNECTS = 3;
const SILENT_RECONNECT_DELAY_MS = 1_000;

/**
 * Refusals that say the runtime could not confirm the run's start or state,
 * not that it ended: the run likely goes on, so the chat connects again,
 * this often in all, this far apart.
 */
const WAIT_REFUSALS: ReadonlySet<string> = new Set([
	"TURN_START_UNCONFIRMED",
	"TURN_STATE_UNAVAILABLE",
]);
const MAX_WAIT_RETRIES = 15;
const WAIT_RETRY_DELAY_MS = 2_000;

/** How long a stopped run's response may stay open to settle the stop. */
const STOP_DRAIN_MS = 5_000;

/** After a clarifying question's window, look again (the run goes on without the answer). */
const INTERRUPT_GRACE_MS = 2_000;
const MAX_INTERRUPT_REARMS = 3;

const LOST_TURN_MESSAGE =
	"The connection to this reply was lost. Reopen the conversation to see how it ended.";

/** The runtime's answer to a stop it took (anything else stopped nothing). */
const stopTakenSchema = z.object({ stopped: z.literal(true) });

export interface UseResearchRunStreamOptions
	extends UseWorkflowTemplateStreamOptions {
	/**
	 * The conversation the page has open. Another one than the hook's own
	 * run is shown: its saved result, or its run while it still goes.
	 */
	conversationId?: string | null;
	/** The page's reasoning mode, saved with the conversation. */
	executionMode?: ReasoningMode;
	/** The runtime created the conversation for a new run, under this id. */
	onConversationStarted?: (threadId: string) => void;
	/** The runtime did not take a stop: the run is shown again as it goes on. */
	onStopFailed?: () => void;
}

/** One request of a session to the runtime: a run, or a connect to the thread. */
interface RuntimeRequest {
	url: string;
	input: RunAgentInput;
	/** Its RUN_STARTED names the run's key, and a silent one counts. */
	isConnect: boolean;
}

/** One request-and-follow of the thread: a send, an answer or a reattach. */
interface Session {
	threadId: string;
	controller: AbortController;
	/** The hook minted this thread: say when its conversation exists. */
	newThread: boolean;
	/**
	 * Until its first response ends: a saved result adopted now is a
	 * reopened one, not a run that just ended.
	 */
	restoring: boolean;
	/** The person stopped the run: its responses change nothing shown. */
	stopped: boolean;
	/** Its follow ended: no response of it is open. */
	done: boolean;
	/** A clarification answer waits for its run's verdict. */
	answer?: (accepted: boolean) => void;
}

/** What one response of a session showed. */
interface ResponseOutcome {
	isConnect: boolean;
	/** The run ended, or asked its question: nothing more to follow. */
	ended: boolean;
	/** The response showed the run going. */
	live: boolean;
	/** A resume's refusal: the answer was not taken. */
	answerRefused: boolean;
	/**
	 * The runtime lost sight of the run rather than saw it end: the error's
	 * message, shown only once the chat stops looking again.
	 */
	dropped: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A run error that leaves the run going on: a "not yet" refusal, or an error
 * with no code (the runtime's own failure) after the response showed the run.
 */
function isDroppedResponse(
	event: Extract<AGUIEvent, { type: EventType.RUN_ERROR }>,
	live: boolean,
): boolean {
	return event.code ? WAIT_REFUSALS.has(event.code) : live;
}

function connectRequest(threadId: string): RuntimeRequest {
	return {
		url: RESEARCH_RUNTIME_PATHS.connect,
		input: connectInput(threadId),
		isConnect: true,
	};
}

export function useResearchRuntimeStream(options: UseResearchRunStreamOptions) {
	const [state, setState] = useState<WorkflowTemplateState>(
		INITIAL_WORKFLOW_TEMPLATE_STATE,
	);
	const [query, setQuery] = useState("");
	const [resultRestored, setResultRestored] = useState(false);

	const optionsRef = useRef(options);
	optionsRef.current = options;
	const stateRef = useRef(state);
	const sessionRef = useRef<Session | null>(null);
	const threadIdRef = useRef<string | null>(null);
	/** The run's key: the run id it was sent with, which a stop names. */
	const startRunIdRef = useRef<string | null>(null);
	const executionIdRef = useRef<string | null>(null);
	const interruptRef = useRef<{
		interruptId: string;
		expiresAt: string | null;
	} | null>(null);
	const interruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const interruptRearmsRef = useRef(0);
	const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const showAiUsageLimitToast = useShowAiUsageLimitToast();
	const showAiUsageLimitToastRef = useRef(showAiUsageLimitToast);
	showAiUsageLimitToastRef.current = showAiUsageLimitToast;

	const commit = useCallback((next: WorkflowTemplateState) => {
		stateRef.current = next;
		setState(next);
	}, []);

	const clearInterruptTimer = useCallback(() => {
		if (interruptTimerRef.current) {
			clearTimeout(interruptTimerRef.current);
			interruptTimerRef.current = null;
		}
	}, []);

	const clearTimers = useCallback(() => {
		clearInterruptTimer();
		if (stopTimerRef.current) {
			clearTimeout(stopTimerRef.current);
			stopTimerRef.current = null;
		}
	}, [clearInterruptTimer]);

	/** End the current session: its responses are aborted and change nothing more. */
	const abortSession = useCallback(() => {
		sessionRef.current?.controller.abort();
		sessionRef.current?.answer?.(false);
		sessionRef.current = null;
	}, []);

	const fail = useCallback(
		(message: string) => {
			commit({
				...stateRef.current,
				status: "failed",
				phase: "failed",
				error: message,
			});
		},
		[commit],
	);

	// Declared below; the interrupt timer and an answer's refusal reconnect.
	const reconnectRef = useRef<(threadId: string) => void>(() => undefined);

	const applyEvent = useCallback(
		(session: Session, outcome: ResponseOutcome, event: AGUIEvent) => {
			if (session.stopped) {
				return;
			}
			if (
				session.answer &&
				!outcome.live &&
				event.type === EventType.RUN_ERROR
			) {
				// The answer was refused before its run resumed (no longer
				// pending, an empty answer): the research itself goes on.
				outcome.answerRefused = true;
				outcome.ended = true;
				return;
			}
			if (
				event.type === EventType.RUN_ERROR &&
				isDroppedResponse(event, outcome.live)
			) {
				outcome.dropped = event.message;
				// The run was admitted on its thread, whose conversation now
				// exists: the page opens it, so a reload follows the run too.
				if (
					event.code === "TURN_START_UNCONFIRMED" &&
					session.newThread
				) {
					session.newThread = false;
					optionsRef.current.onConversationStarted?.(
						session.threadId,
					);
				}
				return;
			}
			const update = applyResearchRuntimeEvent(stateRef.current, event);
			commit(update.state);
			if (update.query !== undefined) {
				setQuery(update.query);
			}
			const effect = update.effect;
			if (!effect) {
				return;
			}
			switch (effect.kind) {
				case "started":
					outcome.live = true;
					outcome.ended = false;
					interruptRef.current = null;
					clearInterruptTimer();
					// A connect's run id is the run's key; a resume's is its own.
					if (outcome.isConnect) {
						startRunIdRef.current = effect.runId;
					}
					if (session.newThread) {
						session.newThread = false;
						optionsRef.current.onConversationStarted?.(
							session.threadId,
						);
					}
					return;
				case "execution":
					executionIdRef.current = effect.executionId;
					return;
				case "interrupt": {
					outcome.ended = true;
					interruptRef.current = {
						interruptId: effect.interruptId,
						expiresAt: effect.expiresAt,
					};
					clearInterruptTimer();
					// One look after the question's window, and again (at
					// most MAX_INTERRUPT_REARMS times) while it is still asked.
					if (
						effect.expiresAt &&
						interruptRearmsRef.current <= MAX_INTERRUPT_REARMS
					) {
						interruptRearmsRef.current += 1;
						const threadId = session.threadId;
						interruptTimerRef.current = setTimeout(
							() => reconnectRef.current(threadId),
							Math.max(
								0,
								Date.parse(effect.expiresAt) - Date.now(),
							) + INTERRUPT_GRACE_MS,
						);
					}
					return;
				}
				case "clarificationAccepted":
					session.answer?.(true);
					session.answer = undefined;
					return;
				case "reconnect":
					outcome.live = true;
					return;
				case "finished":
				case "error":
				case "restored":
					outcome.ended = true;
					if (effect.kind === "restored" && session.restoring) {
						setResultRestored(true);
					}
					return;
				case "usageLimit":
					outcome.ended = true;
					if (effect.payload) {
						showAiUsageLimitToastRef.current(effect.payload);
					}
					return;
				default: {
					const unhandled: never = effect;
					console.warn(
						"[ResearchRuntime] Unhandled effect",
						unhandled,
					);
				}
			}
		},
		[commit, clearInterruptTimer],
	);

	/**
	 * Follow the session's first request, then reconnect until the run
	 * ends, asks its question, or the session is let go.
	 */
	const follow = useCallback(
		async (session: Session, first: RuntimeRequest): Promise<void> => {
			let request = first;
			let silent = 0;
			let waits = 0;
			while (!session.controller.signal.aborted) {
				const outcome: ResponseOutcome = {
					isConnect: request.isConnect,
					ended: false,
					live: false,
					answerRefused: false,
					dropped: null,
				};
				try {
					await streamRuntime({
						url: request.url,
						input: request.input,
						organizationId:
							optionsRef.current.organizationId ?? undefined,
						signal: session.controller.signal,
						onEvent: (event) => {
							if (!session.controller.signal.aborted) {
								applyEvent(session, outcome, event);
							}
						},
					});
				} catch (error) {
					if (
						isAbortError(error) ||
						session.controller.signal.aborted
					) {
						return;
					}
					if (isRuntimeHttpError(error)) {
						// A definite refusal (401, 403, 404): nothing to reconnect to.
						if (session.answer) {
							session.answer(false);
							session.answer = undefined;
						} else if (!session.stopped) {
							fail(errorMessageOf(error));
						}
						return;
					}
					// A dropped connection: the run goes on; reconnect.
				}
				session.restoring = false;
				if (session.stopped) {
					return;
				}
				if (outcome.answerRefused) {
					interruptRef.current = null;
					session.answer?.(false);
					session.answer = undefined;
					// The question may still be pending (or the run went on):
					// look once more.
					reconnectRef.current(session.threadId);
					return;
				}
				if (outcome.dropped !== null) {
					if (waits >= MAX_WAIT_RETRIES) {
						fail(outcome.dropped);
						return;
					}
					waits += 1;
					await sleep(WAIT_RETRY_DELAY_MS);
					request = connectRequest(session.threadId);
					continue;
				}
				if (outcome.ended) {
					return;
				}
				if (request.isConnect) {
					silent = outcome.live ? 0 : silent + 1;
					if (silent >= MAX_SILENT_RECONNECTS) {
						fail(LOST_TURN_MESSAGE);
						return;
					}
					if (!outcome.live) {
						await sleep(SILENT_RECONNECT_DELAY_MS);
					}
				}
				request = connectRequest(session.threadId);
			}
		},
		[applyEvent, fail],
	);

	/** Start a session on the thread, letting the current one go. */
	const startSession = useCallback(
		(
			threadId: string,
			first: RuntimeRequest,
			flags: Pick<Session, "newThread" | "restoring" | "stopped"> & {
				answer?: Session["answer"];
			},
		) => {
			abortSession();
			const session: Session = {
				threadId,
				controller: new AbortController(),
				done: false,
				...flags,
			};
			sessionRef.current = session;
			const done = follow(session, first).finally(() => {
				session.done = true;
			});
			return { session, done };
		},
		[abortSession, follow],
	);

	const connect = useCallback(
		(threadId: string, restoring = false) =>
			startSession(threadId, connectRequest(threadId), {
				newThread: false,
				restoring,
				stopped: false,
			}).done,
		[startSession],
	);

	reconnectRef.current = (threadId: string) => {
		if (threadIdRef.current === threadId) {
			void connect(threadId);
		}
	};

	const sendQuery = useCallback(
		async (queryText: string, context?: string) => {
			const text = queryText.trim();
			if (!text || stateRef.current.status === "running") {
				return null;
			}
			abortSession();
			clearTimers();
			const threadId = crypto.randomUUID();
			const runId = crypto.randomUUID();
			threadIdRef.current = threadId;
			startRunIdRef.current = runId;
			executionIdRef.current = null;
			interruptRef.current = null;
			interruptRearmsRef.current = 0;
			setResultRestored(false);
			setQuery(queryText);
			commit({
				...INITIAL_WORKFLOW_TEMPLATE_STATE,
				status: "running",
				phase: "initializing",
				message: "Starting workflow...",
			});
			const {
				reasoningEffort,
				executionMode,
				maxSubAgents,
				maxIterations,
				successCriteria,
			} = optionsRef.current;
			await startSession(
				threadId,
				{
					url: RESEARCH_RUNTIME_PATHS.run,
					// No organization, template or instance: the runtime
					// owns the first two and takes no instance.
					input: {
						threadId,
						runId,
						messages: [
							{
								id: researchTurnMessageIds(runId).user,
								role: "user",
								content: text,
							},
						],
						tools: [],
						context: [],
						state: {},
						forwardedProps: {
							reasoningEffort,
							executionMode,
							...(context ? { context } : {}),
							maxSubAgents,
							maxIterations,
							successCriteria,
						},
					},
					isConnect: false,
				},
				{ newThread: true, restoring: false, stopped: false },
			).done;
			return executionIdRef.current;
		},
		[abortSession, clearTimers, commit, startSession],
	);

	const sendClarificationResponse = useCallback(
		(response: string): Promise<boolean> => {
			const pending = interruptRef.current;
			const threadId = threadIdRef.current;
			const answer = response.trim();
			if (!pending || !threadId || !answer) {
				return Promise.resolve(false);
			}
			clearInterruptTimer();
			return new Promise<boolean>((resolve) => {
				startSession(
					threadId,
					{
						url: RESEARCH_RUNTIME_PATHS.run,
						input: {
							threadId,
							runId: crypto.randomUUID(),
							messages: [],
							tools: [],
							context: [],
							state: {},
							resume: [
								{
									interruptId: pending.interruptId,
									status: "resolved",
									payload: { response: answer },
								},
							],
						},
						isConnect: false,
					},
					{
						newThread: false,
						restoring: false,
						stopped: false,
						answer: resolve,
					},
				).done.then(() => resolve(false));
			});
		},
		[clearInterruptTimer, startSession],
	);

	const cancel = useCallback(async () => {
		const threadId = threadIdRef.current;
		const shown = stateRef.current;
		commit({ ...shown, status: "cancelled", phase: "cancelled" });
		clearInterruptTimer();
		interruptRef.current = null;
		if (!threadId) {
			abortSession();
			return;
		}
		// The open response settles the stop on the server, so it is kept
		// (showing nothing more) until it ends or the drain window does.
		const open = sessionRef.current;
		if (open) {
			open.stopped = true;
		}
		// Until a response named the run's key, the runtime stops the
		// thread's live research run.
		const runId = startRunIdRef.current;
		const taken = await fetch(RESEARCH_RUNTIME_PATHS.stop(threadId), {
			method: "POST",
			headers: runtimeHeaders(
				optionsRef.current.organizationId ?? undefined,
			),
			body: JSON.stringify(runId ? { runId } : {}),
		})
			.then(
				async (response) =>
					response.ok &&
					stopTakenSchema.safeParse(await response.json()).success,
			)
			.catch(() => false);
		if (sessionRef.current !== open) {
			// Another run or conversation took over meanwhile.
			return;
		}
		if (!taken) {
			// Nothing was stopped: a fresh connect shows the run as it goes
			// on, or how it ended.
			commit(shown);
			void connect(threadId);
			optionsRef.current.onStopFailed?.();
			return;
		}
		// With no response open, one connect settles and saves the stop.
		const settling =
			open && !open.done
				? open
				: startSession(threadId, connectRequest(threadId), {
						newThread: false,
						restoring: false,
						stopped: true,
					}).session;
		if (stopTimerRef.current) {
			clearTimeout(stopTimerRef.current);
		}
		stopTimerRef.current = setTimeout(
			() => settling.controller.abort(),
			STOP_DRAIN_MS,
		);
	}, [abortSession, clearInterruptTimer, commit, connect, startSession]);

	const reset = useCallback(() => {
		abortSession();
		clearTimers();
		threadIdRef.current = null;
		startRunIdRef.current = null;
		executionIdRef.current = null;
		interruptRef.current = null;
		interruptRearmsRef.current = 0;
		commit(INITIAL_WORKFLOW_TEMPLATE_STATE);
		setQuery("");
		setResultRestored(false);
	}, [abortSession, clearTimers, commit]);

	const pollStatus = useCallback(async () => {
		const threadId = threadIdRef.current;
		if (threadId) {
			void connect(threadId);
		}
		return null;
	}, [connect]);

	// Opening a conversation shows its run. The hook's own thread, written
	// back by the page, changes nothing.
	const conversationId = options.conversationId ?? null;
	useEffect(() => {
		if (!conversationId || conversationId === threadIdRef.current) {
			return;
		}
		clearTimers();
		threadIdRef.current = conversationId;
		startRunIdRef.current = null;
		executionIdRef.current = null;
		interruptRef.current = null;
		interruptRearmsRef.current = 0;
		commit(INITIAL_WORKFLOW_TEMPLATE_STATE);
		setQuery("");
		setResultRestored(false);
		void connect(conversationId, true);
	}, [conversationId, clearTimers, commit, connect]);

	useEffect(
		() => () => {
			abortSession();
			clearTimers();
		},
		[abortSession, clearTimers],
	);

	return {
		// State
		state,
		query,
		isLoading: state.status === "running",
		resultRestored,

		// Actions
		sendQuery,
		cancel,
		reset,
		pollStatus,
		sendClarificationResponse,

		// Computed
		...workflowTemplateStreamView(state),
	};
}
