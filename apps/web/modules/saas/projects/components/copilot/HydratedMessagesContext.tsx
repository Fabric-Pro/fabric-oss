"use client";

/**
 * Carries the SSR-hydrated persisted conversation into the live
 * `<CopilotSidebar>` tree WITHOUT pushing it through `agent.messages`.
 *
 * # Why this exists
 *
 * The previous design pushed persisted messages into CopilotKit's
 * runtime store via `sendMessage(...)`. That worked locally but flaked
 * on staging (#1120, #1124, #1126, #1129). The fully-instrumented
 * trace in #1131 proved CopilotKit's agent lifecycle is unreliable:
 * the agent swaps between provisional and real mid-render, writes
 * briefly succeed and then get pruned, and no client-side bookkeeping
 * can keep up.
 *
 * Fix: render hydrated messages **outside** the CopilotKit lifecycle.
 * CopilotKit owns LIVE streaming only. Historical turns come from this
 * context, are merged into the rendered messages list by
 * `CustomMessages`, and stay visible regardless of what
 * `agent.messages` does.
 *
 * # How it's wired
 *
 * `DocumentEditor` / `StoryWorkspace` mount `<HydratedMessagesProvider>`
 * around `<CopilotSidebar>`, passing the SSR-loaded `initialMessages`
 * AND the current `activeConversationId`. `<CopilotSidebar Messages={
 * CustomMessages}>` reads the provider context and prepends those
 * messages before the live `useCopilotChatInternal()` stream, deduping
 * by id so messages don't double-render after persistence + reload.
 *
 * # Reset semantics
 *
 * NOTE: Partially superseded by the AC-2 update below — the memo is now
 * keyed off `[data, sameThread, initialMessages]` (live byId query), not
 * `activeConversationId`. The behavior described here still holds via the
 * `sameThread` gate on the SSR first-paint fallback.
 *
 * The historical messages reset to empty when the active conversation
 * id changes — specifically, when the user clicks "Start a new
 * conversation" and the parent transitions `activeConversationId` from
 * its SSR-loaded value to a fresh id (or to `null` between archive +
 * first send). Without this, the user would see the archived
 * conversation's history bleeding into their brand-new thread, because
 * the page itself doesn't remount on conversation reset.
 *
 * Mechanism: `useMemo` keyed off `activeConversationId`. When the id
 * stays the same as the SSR-loaded one, the historical messages stay.
 * When the id differs (or goes null), the historical set goes empty.
 * Once that fresh thread sends its first message, the new id sticks
 * and stays empty until the next reload (where the SSR loader will
 * fetch the now-persisted turns and seed historical from scratch).
 *
 * # AC-2 update
 * Historical messages now come from the LIVE, conversationId-keyed query
 * useDocumentAssistantConversationById(activeConversationId) (getByIdForDocument)
 * instead of a frozen SSR prop, so an operation-result system message persisted
 * while the user was away appears on tab-return without a reload. Keying by
 * conversationId (not scope) keeps the on-screen thread stable under multi-tab /
 * new-conversation / shared-thread activity. SSR initialMessages are the
 * first-paint fallback for the SSR thread only. useConversationRealtime (SSE)
 * invalidates the byId key on message_appended; staleTime:0 + refetchOnWindowFocus
 * is the correctness floor when SSE is unavailable.
 */

import { useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
} from "react";
import { useConversationRealtime } from "../../../agents/hooks/useConversationRealtime";
import {
	documentAssistantHistoryKeys,
	useDocumentAssistantConversationById,
} from "../../hooks/useDocumentAssistantHistory";

/**
 * Persisted message shape coming from the SSR loader. Loose by design
 * because the wire format from `getActiveDocumentAssistantConversation`
 * is duck-typed.
 */
export type HydratedMessage = Record<string, unknown>;

interface HydratedMessagesApi {
	historicalMessages: ReadonlyArray<HydratedMessage>;
	historicalIdSet: ReadonlySet<string>;
}

const HydratedMessagesContext = createContext<HydratedMessagesApi | null>(null);

interface ProviderProps {
	initialMessages: ReadonlyArray<HydratedMessage>;
	/**
	 * The conversation id the SSR `initialMessages` belong to. When the
	 * active conversation id flips to a different value (e.g. user
	 * clicked "Start a new conversation" → archive + reset to null →
	 * eventually a new id from the first send), the historical messages
	 * reset to empty so the user doesn't see the archived conversation's
	 * turns bleeding into their fresh thread.
	 *
	 * `null` here means "no persisted thread for this document/feature
	 * yet" — same case as the brand-new visitor with an empty initial
	 * payload.
	 */
	ssrConversationId: string | null;
	/**
	 * The PARENT'S live tracker of the active conversation id. Diverges
	 * from `ssrConversationId` after "Start a new conversation". When
	 * they differ, this provider knows the SSR payload is stale and
	 * empties the historical set.
	 */
	activeConversationId: string | null;
	documentRefKind: "PROJECT_DOCUMENT" | "USER_STORY";
	documentRefId: string;
	projectId: string;
	organizationId: string | null;
	children: ReactNode;
}

export function HydratedMessagesProvider({
	initialMessages,
	ssrConversationId,
	activeConversationId,
	documentRefKind,
	documentRefId,
	projectId,
	organizationId,
	children,
}: ProviderProps) {
	const queryClient = useQueryClient();
	const sameThread =
		ssrConversationId !== null &&
		ssrConversationId === activeConversationId;

	const { data } = useDocumentAssistantConversationById({
		conversationId: activeConversationId,
		documentRefKind,
		documentRefId,
		projectId,
		organizationId,
		staleTime: 0,
		refetchOnWindowFocus: true,
		refetchOnReconnect: true,
	});

	// Memoize so `useConversationRealtime` (which lists onMessageAppended in
	// its effect deps) doesn't tear down + reopen the SSE EventSource on every
	// re-render. HydratedMessagesProvider re-renders frequently during
	// CopilotKit streaming; an unstable inline closure would churn the
	// connection and a message_appended arriving in a teardown gap would be
	// dropped. Deps are all stable across streaming re-renders: the four
	// scope props are SSR-stable, activeConversationId only changes on
	// new-conversation/fork, and queryClient is a singleton from context.
	const onMessageAppended = useCallback(() => {
		if (!activeConversationId) {
			return;
		}
		queryClient.invalidateQueries({
			queryKey: documentAssistantHistoryKeys.byId(
				activeConversationId,
				documentRefKind,
				documentRefId,
				projectId,
				organizationId,
			),
		});
	}, [
		activeConversationId,
		queryClient,
		documentRefKind,
		documentRefId,
		projectId,
		organizationId,
	]);

	// Only open the realtime SSE once the conversation is confirmed to exist
	// server-side. Subscribing for an id the server can't resolve (a stale,
	// not-yet-persisted, or cross-tenant id) makes the SSE route return 404 —
	// and EventSource can't see the status code, so the hook would retry up to
	// 5× before giving up, spamming the console with failed requests for no
	// gain. `useDocumentAssistantConversationById` above already tells us
	// whether the conversation exists (`data.conversation` is null on an
	// archived/deleted/missing thread), so gate on it. Valid conversations are
	// unaffected: the SSE simply opens once the (sub-second) query resolves,
	// and the cache remains the source of truth regardless.
	useConversationRealtime({
		conversationId: activeConversationId,
		enabled: Boolean(activeConversationId) && data?.conversation != null,
		onMessageAppended,
	});

	const value = useMemo<HydratedMessagesApi>(() => {
		let messages: ReadonlyArray<HydratedMessage>;
		if (data !== undefined) {
			// Query RESOLVED (possibly with conversation: null when the thread was
			// archived / deleted / visibility-hidden while away). Trust the server:
			// an explicit miss is [], NOT the stale SSR transcript. Only a pending
			// (undefined) query falls back to SSR below (Codex adversarial review).
			const liveMessages = data.conversation?.messages;
			messages = Array.isArray(liveMessages)
				? (liveMessages as ReadonlyArray<HydratedMessage>)
				: [];
		} else if (sameThread) {
			messages = initialMessages; // pending → SSR first-paint fallback (no flash)
		} else {
			messages = [];
		}
		const idSet = new Set<string>();
		for (const m of messages) {
			const id = (m as { id?: unknown }).id;
			if (typeof id === "string") {
				idSet.add(id);
			}
		}
		return { historicalMessages: messages, historicalIdSet: idSet };
	}, [data, sameThread, initialMessages]);

	return (
		<HydratedMessagesContext.Provider value={value}>
			{children}
		</HydratedMessagesContext.Provider>
	);
}

/**
 * Returns `null` when no provider is mounted above (e.g. the Fabric AI
 * page or BacklogChat surfaces). `<CustomMessages>` falls back to the
 * default "live only" behavior in that case so we don't break callers
 * that don't have a persisted conversation to hydrate.
 */
export function useHydratedMessages(): HydratedMessagesApi | null {
	return useContext(HydratedMessagesContext);
}
