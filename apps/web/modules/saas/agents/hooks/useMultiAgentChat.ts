"use client";

import { useAnalytics } from "@analytics";
import {
	isAiUsageLimitExceededPayload,
	useShowAiUsageLimitToast,
} from "@saas/payments/lib/ai-usage-limit-toast";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	type SelectedAgent,
	shouldPersistAgentSelection,
} from "../components/FabricChat/shared/agent-selection";
import type { ApprovalSendResult } from "../lib/approval-response";
import {
	type CancelEventPayload,
	emitCancelEvent,
} from "../lib/cancel-telemetry";
import type { MultiAgentTurnRecord } from "../lib/multi-agent-runtime-protocol";
import {
	MAX_MULTI_AGENTS,
	MULTI_AGENT_KEY_PREFIX,
} from "../lib/multi-agent-runtime-protocol";
import { MultiAgentRuntimeTurn } from "../lib/multi-agent-runtime-turn";
import {
	isMultiAgentTurnOver,
	type MultiAgentTurnView,
	multiAgentPicks,
	multiAgentViewFromRecord,
	pendingMultiAgentTurn,
} from "../lib/multi-agent-turn";
import {
	type MultiAgentSendRun,
	newClientRequestKey,
} from "../lib/orchestrator-stream-types";
import { useRuntimeEligible } from "./useRuntimeEligible";

/**
 * The Orchestrator chat's multi-agent mode (`COPILOTKIT_MULTI_AGENT_CHAT`):
 * agents picked after the first make the next message go to every picked
 * agent at once (two to four), each answering side by side, over the agent
 * runtime. One pick keeps the chat's single-agent turn. Offered only where
 * the surface allows it (the Fabric AI page, not the launcher drawer) and
 * only on the runtime transport.
 */
/**
 * Whether a chat mounted now may offer multi-agent turns: both rollout flags
 * on (the Orchestrator chat on the agent runtime, and multi-agent turns) for
 * a viewer who may save conversations (`useRuntimeEligible`).
 */
export function useMultiAgentOffered(organizationId: string | undefined) {
	const runtime = useRuntimeEligible(
		"COPILOTKIT_ORCHESTRATOR_CHAT",
		organizationId,
	);
	const multiAgent = useRuntimeEligible(
		"COPILOTKIT_MULTI_AGENT_CHAT",
		organizationId,
	);
	return runtime && multiAgent;
}

/** A usage-limit refusal's limits, wherever its body carries them. */
function usageLimitPayloadOf(body: unknown) {
	if (
		typeof body === "object" &&
		body !== null &&
		"data" in body &&
		isAiUsageLimitExceededPayload(body.data)
	) {
		return body.data;
	}
	return isAiUsageLimitExceededPayload(body) ? body : null;
}

/** The picks a member saves: never a model kept in this chat only. */
function savable(agents: SelectedAgent[]): SelectedAgent[] {
	return agents.filter((agent) => !agent.chatOnly);
}

export function useMultiAgentChat(options: {
	/**
	 * The surface offers it and the viewer may use it: the page passes
	 * `useMultiAgentOffered`; the drawer offers nothing.
	 */
	offered: boolean;
	organizationId: string | undefined;
	/** The thread a new turn goes to (null: a new conversation). */
	conversationId: string | null;
	/** The thread's latest saved turn: a multi-agent one still running is followed again. */
	latest?: {
		id: string;
		userMessage: string;
		multiAgent?: MultiAgentTurnRecord;
	};
	/** The chat's own pick: the first agent of a multi-agent turn. */
	first: SelectedAgent | null;
	/** Change the chat's own pick. */
	setFirst: (agent: SelectedAgent | null) => void;
	/** Save the member's whole picked set (the chat agent selection store). */
	persist: (agents: SelectedAgent[]) => void;
	onConversationStarted: (threadId: string) => void;
}) {
	// Decided once, at mount, as the chat's transport is
	// (`useOrchestratorChatStream`): a chat that started on the stream route
	// never sends a multi-agent turn.
	const [enabled] = useState(() => options.offered);
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const [extraAgents, setExtraAgents] = useState<SelectedAgent[]>([]);
	const extrasRef = useRef<SelectedAgent[]>([]);
	const setExtras = useCallback((extras: SelectedAgent[]) => {
		extrasRef.current = extras;
		setExtraAgents(extras);
	}, []);
	const [view, setView] = useState<MultiAgentTurnView | null>(null);
	const turnRef = useRef<MultiAgentRuntimeTurn | null>(null);
	const startedAtRef = useRef<number | null>(null);
	const { trackEvent } = useAnalytics();
	const showAiUsageLimitToast = useShowAiUsageLimitToast();
	const hostRef = useRef({ trackEvent, showAiUsageLimitToast });
	hostRef.current = { trackEvent, showAiUsageLimitToast };

	useEffect(() => () => turnRef.current?.dispose(), []);

	const openTurn = useCallback(
		(threadId: string, initial: MultiAgentTurnView) => {
			turnRef.current?.dispose();
			const turn = new MultiAgentRuntimeTurn(threadId, initial, {
				organizationId: optionsRef.current.organizationId,
				onView: setView,
				onAnalyticsEvent: (name, payload) =>
					hostRef.current.trackEvent(name, payload),
				onUsageLimit: (body) => {
					const payload = usageLimitPayloadOf(body);
					if (payload) {
						hostRef.current.showAiUsageLimitToast(payload);
					}
				},
			});
			turnRef.current = turn;
			setView(initial);
			return turn;
		},
		[],
	);

	// After a reload: follow the thread's multi-agent turn still running.
	const latest = options.latest;
	const latestRecord = latest?.multiAgent;
	useEffect(() => {
		const threadId = optionsRef.current.conversationId;
		if (
			!enabled ||
			!threadId ||
			!latest ||
			!latestRecord ||
			latestRecord.final ||
			turnRef.current
		) {
			return;
		}
		const turn = openTurn(threadId, {
			...multiAgentViewFromRecord(latestRecord, latest.userMessage),
			executionId: latest.id,
		});
		void turn.attach();
	}, [enabled, latest, latestRecord, openTurn]);

	// Reopening a conversation whose last turn went to several agents picks
	// those agents again. Armed when the chat moves to a conversation it did
	// not start here, and spent on that conversation's first latest turn.
	const restoreArmedRef = useRef(false);
	const startedHereRef = useRef<string | null>(null);
	const conversationId = options.conversationId;
	useEffect(() => {
		restoreArmedRef.current =
			Boolean(conversationId) &&
			conversationId !== startedHereRef.current;
	}, [conversationId]);
	useEffect(() => {
		if (!enabled || !restoreArmedRef.current || !latest) {
			return;
		}
		restoreArmedRef.current = false;
		if (!latestRecord) {
			return;
		}
		const [first, ...rest] = multiAgentPicks(latestRecord);
		if (first && rest.length > 0) {
			optionsRef.current.setFirst(first);
			setExtras(rest.slice(0, MAX_MULTI_AGENTS - 1));
		}
	}, [enabled, latest, latestRecord, setExtras]);

	/**
	 * Pick or remove an agent. The first pick is the chat's own (one pick
	 * keeps the single-agent turn); with multi-agent turns, agents picked
	 * after it join the next message, at most four in all, and removing the
	 * first makes the next one first. The whole set is saved, as Nexus
	 * saves it; a model kept in this chat only never is.
	 */
	const toggle = useCallback(
		(agent: SelectedAgent) => {
			const { first, setFirst, persist } = optionsRef.current;
			const extras = extrasRef.current;
			if (enabled && first && first.agentId !== agent.agentId) {
				const picked = extras.some(
					(pick) => pick.agentId === agent.agentId,
				);
				if (!picked && extras.length + 1 >= MAX_MULTI_AGENTS) {
					toast.message(
						`A message can go to at most ${MAX_MULTI_AGENTS} agents.`,
					);
					return;
				}
				const next = picked
					? extras.filter((pick) => pick.agentId !== agent.agentId)
					: [...extras, agent];
				setExtras(next);
				if (!agent.chatOnly) {
					persist(savable([first, ...next]));
				}
				return;
			}
			const removing = first?.agentId === agent.agentId;
			const [promoted = null, ...rest] = removing ? extras : [];
			const next = removing ? promoted : agent;
			setFirst(next);
			if (removing) {
				setExtras(rest);
			}
			if (shouldPersistAgentSelection(first, next)) {
				persist(
					savable(next ? [next, ...(removing ? rest : extras)] : []),
				);
			}
		},
		[enabled, setExtras],
	);

	/** The member's saved picks beyond the first, restored at hydration. */
	const restoreExtras = useCallback(
		(agents: SelectedAgent[]) => {
			if (enabled) {
				setExtras(agents.slice(0, MAX_MULTI_AGENTS - 1));
			}
		},
		[enabled, setExtras],
	);

	/** An agent of the turn is still answering, or waits on an approval. */
	const isRunning =
		view !== null &&
		!isMultiAgentTurnOver(view) &&
		view.agents.some((agent) => agent.isLoading);

	/**
	 * Send one message to every picked agent: the chat's send has prepared
	 * it as for one agent (uploads, attachments, Fabric tools, integrations,
	 * template), and this starts the multi-agent turn with it.
	 */
	const sendRun = useCallback(
		async (run: MultiAgentSendRun): Promise<void> => {
			const current = optionsRef.current;
			const picks = [
				...(current.first ? [current.first] : []),
				...extrasRef.current,
			];
			if (isRunning) {
				toast.message("The agents are still answering.");
				return;
			}
			const turnKey = `${MULTI_AGENT_KEY_PREFIX}${newClientRequestKey()}`;
			const turn = openTurn(
				run.threadId,
				pendingMultiAgentTurn(turnKey, run.content, picks),
			);
			startedAtRef.current = Date.now();
			if (current.conversationId !== run.threadId) {
				startedHereRef.current = run.threadId;
				current.onConversationStarted(run.threadId);
			}
			await turn.send({
				messages: [
					...run.history.map((message, index) => ({
						id: `${turnKey}:history:${index}`,
						...message,
					})),
					{
						id: `${turnKey}:user`,
						role: "user" as const,
						content: run.content,
					},
				],
				agentIds: picks.map((pick) => pick.agentId),
				forwardedProps: run.forwardedProps,
			});
			if (
				turn.current.status === "refused" &&
				!turn.current.executionId
			) {
				const note = run.onRefused();
				if (note) {
					toast.message(note);
				}
			}
		},
		[isRunning, openTurn],
	);

	const answer = useCallback(
		async (
			interruptId: string,
			decision: { approved: boolean; feedback?: string },
		): Promise<ApprovalSendResult> => {
			const turn = turnRef.current;
			if (!turn) {
				return "stale";
			}
			void turn.answer(interruptId, decision);
			return "sent";
		},
		[],
	);

	/**
	 * Stop every agent still answering, as Nexus stops them: each shows
	 * Stopped at once, with one cancel event per agent (surface "nexus").
	 * False when no multi-agent turn is running.
	 */
	const stop = useCallback(
		(trigger: CancelEventPayload["triggered_by"]): boolean => {
			const turn = turnRef.current;
			if (!turn || !isRunning) {
				return false;
			}
			const startedAt = startedAtRef.current;
			const latencyMs =
				startedAt !== null ? Math.max(0, Date.now() - startedAt) : 0;
			for (const agent of turn.current.agents) {
				if (!agent.isLoading) {
					continue;
				}
				emitCancelEvent({
					surface: "nexus",
					agentId: agent.agentId,
					executionId: agent.executionId ?? null,
					partial_token_count: Math.ceil(agent.content.length / 4),
					latency_to_cancel_ms: latencyMs,
					triggered_by: trigger,
				});
			}
			void turn.stop().then((stopped) => {
				if (!stopped) {
					toast.error("Couldn't stop the agents. Try again.");
				}
			});
			return true;
		},
		[isRunning],
	);

	/** Whether the next message goes to several agents (two picks or more). */
	const goesToAgents =
		enabled && Boolean(options.first) && extraAgents.length > 0;

	/** Whether a saved turn shows as the live turn instead (still running here). */
	const showsLive = (execution: {
		id: string;
		multiAgent?: MultiAgentTurnRecord;
	}) =>
		Boolean(
			execution.multiAgent &&
				!execution.multiAgent.final &&
				execution.id === view?.executionId,
		);

	/** The live turn to show, unless the thread already has its final record. */
	const liveView = (
		executions: ReadonlyArray<{
			id: string;
			multiAgent?: MultiAgentTurnRecord;
		}>,
	) =>
		view &&
		!executions.some(
			(execution) =>
				execution.id === view.executionId &&
				execution.multiAgent?.final,
		)
			? view
			: null;

	return {
		enabled,
		extraAgents: enabled ? extraAgents : [],
		toggle,
		restoreExtras,
		showsLive,
		liveView,
		view,
		isRunning,
		/** The chat send's hand-off, set while the next message goes to several agents. */
		sendRun: goesToAgents ? sendRun : undefined,
		answer,
		stop,
	};
}
