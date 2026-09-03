"use client";

/**
 * `CopilotChatSessionProvider` — one `useCopilotChatInternal()` instance per
 * CopilotKit surface, published to every read-only consumer through context.
 *
 * # Why this exists
 *
 * On CopilotKit 1.70, `useCopilotChatInternal()` is not a passive read hook:
 * each call site owns a private `lastConnectedAgentRef` and fires
 * `copilotkit.connectAgent({ agent })` from its own effect
 * (`@copilotkit/react-core/dist/index.mjs:39-84`), and `connectAgent`
 * (`@copilotkit/core/dist/index.mjs:2714-2735`) has no in-flight or
 * already-connected guard. `useCopilotChat()` is a thin wrapper over the same
 * hook (`react-core/dist/index.mjs:350-364`), so it connects too. The result is
 * one `agent/connect` POST per mounted call site, and one agent run mirrored
 * into one response stream per connect.
 *
 * Measured on the feature workspace (Fizzy #2389): opening a feature fired one
 * `info` POST plus ~16 `agent/connect` POSTs to `/api/copilotkit`, and a single
 * agent run came back as ~5 identical response streams — the page-level hooks,
 * the always-mounted sidebar descendants, and one more call site per rendered
 * assistant message, each connecting independently.
 *
 * The other CopilotKit hooks (`useCoAgent`, `useCopilotAction`,
 * `useCoAgentStateRender`, `useCopilotReadable`, `useCopilotChatSuggestions`)
 * do NOT connect — only `useCopilotChat` / `useCopilotChatInternal` do. So the
 * fix is to call the connecting hook exactly once per surface and let every
 * read-only consumer share that value.
 *
 * # Contract
 *
 * Mount `<CopilotChatSessionProvider>` immediately inside each `<CopilotKit>`
 * and above every consumer. `<CopilotSidebar>` calls `useCopilotChatInternal`
 * internally as well and that call stays (react-ui's default `Messages`,
 * `Input` and per-chip `Suggestion` also call it, but the app replaces all
 * three with components that read this context). On the feature workspace,
 * where every call site now reads this context, the steady-state connect
 * count is two (sidebar + this provider) regardless of message count. Other surfaces
 * still hold direct `useCopilotChat` / `useCopilotChatInternal` calls of their
 * own (`DocumentEditor`, `DocumentGeneratorEditor`, `TaskPlannerEditor`,
 * `AiLoadingSync`, `AgentChatCode`); each of those adds one connect until it
 * is converted to read this context.
 *
 * `useCopilotChatSession()` throws when no provider is in scope rather than
 * falling back to a private `useCopilotChatInternal()` call — a silent fallback
 * would quietly reintroduce the very per-instance connect this provider exists
 * to remove.
 *
 * The published value is the full `useCopilotChatInternal()` return, a strict
 * superset of `useCopilotChat()`'s (`react-core/dist/index.d.mts:303` types the
 * latter as an `Omit<>` of the former), so consumers of either hook can read
 * the same fields — `visibleMessages`, `messages`, `isLoading`, `appendMessage`,
 * `setMessages`, `interrupt`, `agent` — with unchanged semantics.
 */

import { useCopilotChatInternal } from "@copilotkit/react-core";
import { createContext, type ReactNode, useContext } from "react";

export type CopilotChatSession = ReturnType<typeof useCopilotChatInternal>;

const CopilotChatSessionContext = createContext<CopilotChatSession | null>(
	null,
);

export function CopilotChatSessionProvider({
	children,
}: {
	children: ReactNode;
}) {
	// The one and only connecting call for this surface. Its return object is
	// a fresh reference on every render of this provider, exactly as it was
	// when each consumer held its own hook — so consumer re-render timing is
	// unchanged by the consolidation.
	const session = useCopilotChatInternal();

	return (
		<CopilotChatSessionContext.Provider value={session}>
			{children}
		</CopilotChatSessionContext.Provider>
	);
}

/**
 * Read the surface's shared CopilotKit chat session.
 *
 * @throws When no `<CopilotChatSessionProvider>` is mounted above the caller.
 */
export function useCopilotChatSession(): CopilotChatSession {
	const session = useContext(CopilotChatSessionContext);
	if (session === null) {
		throw new Error(
			"useCopilotChatSession() requires a <CopilotChatSessionProvider> above it. " +
				"Mount one immediately inside this surface's <CopilotKit> provider — " +
				"see CopilotChatSessionProvider.tsx for why the hook must not be called directly.",
		);
	}
	return session;
}
