"use client";

import {
	type FabricAgentLaunchContext,
	useRegisterFabricAgentContext,
} from "@saas/agents/components/FabricAgentLauncher";
import { useOpenFrameAgent } from "./use-open-frame-agent";

/**
 * Where the viewer is, for Fabric Agent, on a page of agent-written pages: the
 * context is registered while the page is open, so the agent opened from
 * anywhere on it knows what "here" is, and the function returned opens the
 * agent from that same place with a draft to finish.
 */
export function useFrameAgentContext(
	context: Omit<FabricAgentLaunchContext, "prompt">,
): ((prompt: string) => void) | undefined {
	useRegisterFabricAgentContext(context);
	return useOpenFrameAgent(context);
}
