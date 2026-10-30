"use client";

import { useState } from "react";
import type { UseOrchestratorStreamOptions } from "../lib/orchestrator-stream-types";
import { useOrchestratorRuntimeStream } from "./useOrchestratorRuntimeStream";
import { useOrchestratorStream } from "./useOrchestratorStream";
import { useRuntimeEligible } from "./useRuntimeEligible";

/** Which transport an Orchestrator chat runs over: the stream route, or the agent runtime. */
export type OrchestratorChatTransport = "legacy" | "runtime";

const TRANSPORT_HOOKS = {
	legacy: useOrchestratorStream,
	runtime: useOrchestratorRuntimeStream,
} as const satisfies Record<
	OrchestratorChatTransport,
	(
		options: UseOrchestratorStreamOptions,
	) => ReturnType<typeof useOrchestratorStream>
>;

/**
 * The Orchestrator chat's stream, over the transport chosen when the chat
 * mounts (the same rule as the Direct chat's `useDirectChatStream`).
 *
 * The choice is made once and kept for the component's lifetime, so the same
 * hook runs on every render (the rules of hooks) and a conversation never
 * changes transport halfway: turning the flag on or off, or a role that loads
 * after the chat mounted, takes effect on the next chat. Until the
 * organization and the viewer's role are known the chat stays on the stream
 * route, which serves everyone.
 */
export function useOrchestratorChatStream(
	options: UseOrchestratorStreamOptions,
) {
	// `COPILOTKIT_ORCHESTRATOR_CHAT` on, the chat's organization on screen,
	// and a role that may save conversations (see `useRuntimeEligible`).
	const eligible = useRuntimeEligible(
		"COPILOTKIT_ORCHESTRATOR_CHAT",
		options.organizationId,
	);
	const [transport] = useState<OrchestratorChatTransport>(() =>
		eligible ? "runtime" : "legacy",
	);
	const useTransportStream = TRANSPORT_HOOKS[transport];
	return { ...useTransportStream(options), transport };
}
