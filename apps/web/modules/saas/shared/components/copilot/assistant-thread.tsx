"use client";

/**
 * The CopilotKit thread a document, feature or topic assistant runs on.
 *
 * The thread id is the persisted conversation's id, so every turn of one
 * conversation reaches the agent under one thread: the agent keys the model's
 * prompt-cache session on it, and the durable runner (`/api/copilotkit`) finds
 * a run the page left behind by it.
 *
 * The rule, in one place for all three mounts:
 * - a mount that already has a conversation runs on its id;
 * - a mount without one runs on a fresh id, minted once, and the first
 *   persisted turn offers that id for the conversation it creates
 *   (`proposedConversationId`), so the two are one id from then on;
 * - the id never changes mid-session — a CopilotKit thread change clears the
 *   live transcript — except on "New conversation", which mints a fresh one,
 *   and on adopting a fork, which moves to the fork's conversation id (both
 *   clear the transcript anyway). A spill to a continuation conversation at
 *   the turn cap keeps the thread.
 */

import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";

export interface AssistantThread {
	threadId: string;
	/**
	 * The next turn runs on another thread: `conversationId` when the surface
	 * adopted an existing conversation (a fork), a fresh id otherwise ("New
	 * conversation").
	 */
	startNewThread: (conversationId?: string) => void;
}

const AssistantThreadContext = createContext<AssistantThread | null>(null);

/** Publishes the mount's thread to the persistence hook and the conversation controls. */
export const AssistantThreadProvider = AssistantThreadContext.Provider;

/** The surface's thread, or null outside an assistant mount. */
export function useAssistantThread(): AssistantThread | null {
	return useContext(AssistantThreadContext);
}

/**
 * The thread for a `<CopilotKit>` mount: `initialConversationId` when the
 * page loaded with a conversation, otherwise an id minted for this mount.
 * Read once; later changes of the conversation id do not move the thread.
 */
export function useAssistantThreadId(
	initialConversationId: string | null | undefined,
): AssistantThread {
	const [threadId, setThreadId] = useState(
		() => initialConversationId ?? crypto.randomUUID(),
	);
	const startNewThread = useCallback((conversationId?: string) => {
		setThreadId(conversationId ?? crypto.randomUUID());
	}, []);
	return useMemo(
		() => ({ threadId, startNewThread }),
		[threadId, startNewThread],
	);
}
