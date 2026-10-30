"use client";

import { useCopilotKit } from "@copilotkit/react-core/v2";
import { useEffect, useRef } from "react";

/**
 * CopilotKit 1.80's async fresh-thread connect can clear initialState after
 * mount effects. Core emits run-start after that wipe and before copying state
 * into the request. Match by id because the provider may replace the provisional
 * agent instance. Read the latest seed without resubscribing on each render.
 */
export function useReseedAgentStateOnRunStart(
	agentId: string,
	reseed: (state: Record<string, unknown>) => Record<string, unknown>,
) {
	const { copilotkit } = useCopilotKit();
	const reseedRef = useRef(reseed);
	reseedRef.current = reseed;
	useEffect(() => {
		const subscription = copilotkit.subscribe({
			onAgentRunStarted: ({ agent }) => {
				if (agent.agentId === agentId) {
					agent.setState(reseedRef.current(agent.state ?? {}));
				}
			},
		});
		return () => subscription.unsubscribe();
	}, [copilotkit, agentId]);
}
