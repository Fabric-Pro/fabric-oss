"use client";

/**
 * ProjectPresenceProvider
 *
 * Shares ONE `useProjectPresence` subscription with every consumer under it.
 *
 * Each `useProjectPresence` call is a fully independent connection: its own
 * `join` POST, its own two-minute heartbeat interval, and — through
 * `useProjectRealtime` — its own `EventSource`. The hook's internal
 * de-duplication only ever sees its own instance, so two components calling it
 * for the same project doubled the presence traffic and the open SSE streams
 * without either one being able to notice.
 *
 * On the project detail page that is exactly what happened: `ProjectDetails`
 * called the hook for its document/context refetch callbacks, and
 * `ProjectPresenceBar` — mounted through `ProjectHeader` in that same tree —
 * called it again for the avatar stack. Presence is now mounted once, at the
 * top of `ProjectDetails`, and read from here.
 *
 * `useProjectPresenceContext` throws rather than falling back to its own
 * subscription: a silent fallback would let the duplication return unnoticed
 * the next time a consumer is mounted outside a provider.
 */

import { createContext, type ReactNode, useContext } from "react";
import type { UseProjectPresenceReturn } from "../hooks/useProjectPresence";

const ProjectPresenceContext = createContext<UseProjectPresenceReturn | null>(
	null,
);

export function ProjectPresenceProvider({
	value,
	children,
}: {
	value: UseProjectPresenceReturn;
	children: ReactNode;
}) {
	return (
		<ProjectPresenceContext.Provider value={value}>
			{children}
		</ProjectPresenceContext.Provider>
	);
}

export function useProjectPresenceContext(): UseProjectPresenceReturn {
	const context = useContext(ProjectPresenceContext);
	if (!context) {
		throw new Error(
			"useProjectPresenceContext must be used inside a <ProjectPresenceProvider>. Presence is mounted once per project page; do not call useProjectPresence again in the same tree.",
		);
	}
	return context;
}
