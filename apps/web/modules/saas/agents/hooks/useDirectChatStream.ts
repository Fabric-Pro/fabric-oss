"use client";

import { useState } from "react";
import {
	type UseDirectRuntimeStreamOptions,
	useDirectRuntimeStream,
} from "./useDirectRuntimeStream";
import { useDirectStream } from "./useDirectStream";
import { useRuntimeEligible } from "./useRuntimeEligible";

/** Which transport a Direct chat runs over: the stream route, or the agent runtime. */
export type DirectChatTransport = "legacy" | "runtime";

const TRANSPORT_HOOKS = {
	legacy: useDirectStream,
	runtime: useDirectRuntimeStream,
} as const satisfies Record<
	DirectChatTransport,
	(
		options: UseDirectRuntimeStreamOptions,
	) => ReturnType<typeof useDirectStream>
>;

/**
 * The Direct chat's stream, over the transport chosen when the chat mounts.
 *
 * The choice is made once and kept for the component's lifetime, so the same
 * hook runs on every render (the rules of hooks) and a conversation never
 * changes transport halfway: turning the flag on or off, or a role that
 * loads after the chat mounted, takes effect on the next chat. Until the
 * organization and the viewer's role are known the chat stays on the stream
 * route, which serves everyone.
 */
export function useDirectChatStream(options: UseDirectRuntimeStreamOptions) {
	// `COPILOTKIT_DIRECT_CHAT` on, the chat's organization on screen, and a
	// role that may save conversations (see `useRuntimeEligible`).
	const eligible = useRuntimeEligible(
		"COPILOTKIT_DIRECT_CHAT",
		options.organizationId,
	);
	const [transport] = useState<DirectChatTransport>(() =>
		eligible ? "runtime" : "legacy",
	);
	const useTransportStream = TRANSPORT_HOOKS[transport];
	return { ...useTransportStream(options), transport };
}
