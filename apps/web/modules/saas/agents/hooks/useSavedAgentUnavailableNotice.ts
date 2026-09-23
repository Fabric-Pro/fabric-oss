"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

/** Shared by every surface that can announce it, so sonner shows it once. */
const SAVED_AGENT_UNAVAILABLE_TOAST_ID = "saved-agent-unavailable";

/**
 * FR13 (Fizzy #2040): the server drops saved agent picks whose targets no
 * longer resolve for this tenant. Saying so is the difference between "my
 * agent quietly changed" and "my agent went away, and I know why".
 *
 * Owned by the surfaces (the full page and the ⌘J drawer) rather than by one
 * engine: it used to live in the Direct chat only, so a user whose chat runs
 * on the orchestrator was never told. Reads the same cache entry the chats'
 * pickers hydrate from, so it costs no extra request. The drawer's chat is
 * mounted on every page, hence `enabled` — it announces only while open.
 */
export function useSavedAgentUnavailableNotice({
	organizationId,
	enabled,
}: {
	organizationId: string | null | undefined;
	enabled: boolean;
}) {
	const { user } = useSession();
	const agentSelectionQuery = useQuery({
		queryKey: ["chat-agent-selection", user?.id, organizationId ?? null],
		queryFn: async () => orpcClient.users.chatAgentSelection.get(),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		retry: 1,
		enabled: Boolean(user?.id) && enabled,
	});

	const announcedRef = useRef(false);
	const data = agentSelectionQuery.data;
	useEffect(() => {
		if (!enabled || announcedRef.current || !data) {
			return;
		}
		announcedRef.current = true;
		if (data.droppedCount <= 0) {
			return;
		}
		const [first] = data.selectedAgents;
		const inUse = first ?? data.defaultAgent;
		toast.message(
			first
				? "Some saved agents are no longer available."
				: "Your saved agent is no longer available.",
			{
				id: SAVED_AGENT_UNAVAILABLE_TOAST_ID,
				description: inUse
					? `Using ${inUse.name} for this chat.`
					: "Using your configured default for this chat.",
			},
		);
	}, [data, enabled]);
}
