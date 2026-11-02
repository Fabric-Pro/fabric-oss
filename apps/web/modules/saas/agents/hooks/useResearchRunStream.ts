"use client";

import { useState } from "react";
import { RESEARCH_AGENT_ID } from "../lib/research-runtime-protocol";
import {
	type UseResearchRunStreamOptions,
	useResearchRuntimeStream,
} from "./useResearchRuntimeStream";
import { useRuntimeEligible } from "./useRuntimeEligible";
import { useWorkflowTemplateStream } from "./useWorkflowTemplateStream";

/** Which transport Deep Research runs over: the stream route, or the agent runtime. */
export type ResearchRunTransport = "legacy" | "runtime";

const TRANSPORT_HOOKS = {
	legacy: useWorkflowTemplateStream,
	runtime: useResearchRuntimeStream,
} as const satisfies Record<
	ResearchRunTransport,
	(
		options: UseResearchRunStreamOptions,
	) => ReturnType<typeof useWorkflowTemplateStream>
>;

/**
 * Deep Research's stream, over the transport chosen when the page mounts.
 *
 * The choice is made once and kept for the component's lifetime, so the same
 * hook runs on every render (the rules of hooks) and a run never changes
 * transport halfway: turning the flag on or off, or a role that loads after
 * the page mounted, takes effect on the next page load. Until the
 * organization and the viewer's role are known the page stays on the stream
 * route, which serves everyone. `resultRestored` is true only for a result
 * the runtime reopened from a saved conversation.
 */
export function useResearchRunStream(options: UseResearchRunStreamOptions) {
	// `COPILOTKIT_RESEARCH_RUNS` on, the page's organization on screen, and
	// a role that may save conversations (see `useRuntimeEligible`); only the
	// template the runtime serves.
	const eligible =
		useRuntimeEligible(
			"COPILOTKIT_RESEARCH_RUNS",
			options.organizationId ?? undefined,
		) && options.templateSlug === RESEARCH_AGENT_ID;
	const [transport] = useState<ResearchRunTransport>(() =>
		eligible ? "runtime" : "legacy",
	);
	const useTransportStream = TRANSPORT_HOOKS[transport];
	return {
		resultRestored: false,
		...useTransportStream(options),
		transport,
	};
}
