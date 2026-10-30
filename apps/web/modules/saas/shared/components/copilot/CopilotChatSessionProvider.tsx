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
 * own (`DocumentGeneratorEditor`, `TaskPlannerEditor`,
 * `AiLoadingSync`, `AgentChatCode`); each of those adds one connect until it
 * is converted to read this context.
 *
 * `useCopilotChatSession()` throws when no provider is in scope rather than
 * falling back to a private `useCopilotChatInternal()` call — a silent fallback
 * would quietly reintroduce the very per-instance connect this provider exists
 * to remove.
 *
 * Context publishes a stable external store. The compatibility hook returns the
 * full session; selectors notify consumers when their selected values change,
 * and action delegates call the latest committed session implementation.
 */

import { useCopilotChatInternal } from "@copilotkit/react-core";
import {
	createContext,
	type ReactNode,
	useContext,
	useLayoutEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";

export type CopilotChatSession = ReturnType<typeof useCopilotChatInternal>;
type Store = {
	session: CopilotChatSession;
	listeners: Set<() => void>;
	subscribe: (listener: () => void) => () => void;
};
const CopilotChatSessionContext = createContext<Store | null>(null);

export function CopilotChatSessionProvider({
	children,
}: {
	children: ReactNode;
}) {
	const session = useCopilotChatInternal();
	const storeRef = useRef<Store | null>(null);
	if (!storeRef.current) {
		const listeners = new Set<() => void>();
		storeRef.current = {
			session,
			listeners,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		};
	}
	const store = storeRef.current;
	useLayoutEffect(() => {
		store.session = session;
		for (const listener of store.listeners) {
			listener();
		}
	}, [store, session]);
	return (
		<CopilotChatSessionContext.Provider value={store}>
			{children}
		</CopilotChatSessionContext.Provider>
	);
}

export function useCopilotChatSessionSelector<S>(
	selector: (session: CopilotChatSession) => S,
	equality: (a: S, b: S) => boolean = Object.is,
): S {
	const store = useContext(CopilotChatSessionContext);
	if (!store) {
		throw new Error(
			"useCopilotChatSession() requires a <CopilotChatSessionProvider> above it.",
		);
	}
	const snapshot = useMemo(() => {
		let initialized = false;
		let cached: S;
		return () => {
			const next = selector(store.session);
			if (!initialized || !equality(cached, next)) {
				cached = next;
				initialized = true;
			}
			return cached;
		};
	}, [store, selector, equality]);
	return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}

/** Full-session compatibility read; prefer a selector for page components. */
export function useCopilotChatSession(): CopilotChatSession {
	return useCopilotChatSessionSelector((session) => session);
}

/** Stable delegates read the latest committed session, including after agent replacement. */
export function useCopilotChatSessionActions() {
	const store = useContext(CopilotChatSessionContext);
	if (!store) {
		throw new Error(
			"useCopilotChatSessionActions requires a CopilotChatSessionProvider",
		);
	}
	return useMemo(
		() => ({
			appendMessage: (
				...args: Parameters<CopilotChatSession["appendMessage"]>
			) => store.session.appendMessage(...args),
			setMessages: (
				...args: Parameters<CopilotChatSession["setMessages"]>
			) => store.session.setMessages(...args),
		}),
		[store],
	);
}
