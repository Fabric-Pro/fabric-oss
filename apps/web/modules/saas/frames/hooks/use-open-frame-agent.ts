"use client";

import {
	type FabricAgentLaunchContext,
	useOptionalFabricAgentLauncher,
} from "@saas/agents/components/FabricAgentLauncher";
import { useMemo, useRef } from "react";

/**
 * What `fabric.openAgent(prompt)` does on a page that frames agent-written
 * pages: open Fabric Agent from where the page is (its surface, its Workspace
 * or project) with the prompt as a draft the person still has to send. Absent
 * where there is no launcher, so the shell can leave the request unanswered.
 */
export function useOpenFrameAgent(
	context: Omit<FabricAgentLaunchContext, "prompt">,
): ((prompt: string) => void) | undefined {
	const openLauncher = useOptionalFabricAgentLauncher()?.openLauncher;
	const latestContext = useRef(context);
	latestContext.current = context;
	return useMemo(
		() =>
			openLauncher
				? (prompt: string) =>
						openLauncher({ ...latestContext.current, prompt })
				: undefined,
		[openLauncher],
	);
}
