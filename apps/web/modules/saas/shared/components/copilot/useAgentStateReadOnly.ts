"use client";

import { useCopilotKit } from "@copilotkit/react-core/v2/context";
import { useCallback, useMemo, useSyncExternalStore } from "react";

const EMPTY_STATE = {};
const EMPTY_MESSAGES: unknown[] = [];

/** Read the same named registry agent as useCoAgent, without run-start writes. */
function useAgentSelection<T, S>(
	agentName: string,
	selector: (state: T, messages: unknown[]) => S,
	isEqual: (a: S, b: S) => boolean,
	source: "state" | "both",
): S {
	const { copilotkit } = useCopilotKit();
	const subscribeRegistry = useCallback(
		(onStoreChange: () => void) => {
			const subscription = copilotkit.subscribe({
				onAgentsChanged: onStoreChange,
			});
			return () => subscription.unsubscribe();
		},
		[copilotkit],
	);
	// The registry lookup `getAgent` does first, without its "Agent … not
	// found" console warning: React reads this snapshot during row renders,
	// so a runtime in the Error state could warn once per row.
	const getAgent = useCallback(
		() => copilotkit.agents[agentName],
		[copilotkit, agentName],
	);
	const agent = useSyncExternalStore(subscribeRegistry, getAgent, getAgent);
	const subscribe = useCallback(
		(onStoreChange: () => void) => {
			const subscription = agent?.subscribe({
				onStateChanged: onStoreChange,
				...(source === "both"
					? { onMessagesChanged: onStoreChange }
					: {}),
			});
			return () => subscription?.unsubscribe();
		},
		[agent, source],
	);
	const getSnapshot = useMemo(() => {
		let cached: S;
		let initialized = false;
		return () => {
			const next = selector(
				(agent?.state ?? EMPTY_STATE) as T,
				agent?.messages ?? EMPTY_MESSAGES,
			);
			if (!initialized || !isEqual(cached, next)) {
				cached = next;
				initialized = true;
			}
			return cached;
		};
	}, [agent, selector, isEqual, source]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useAgentStateSelector<T, S>(
	agentName: string,
	selector: (state: T) => S,
	isEqual: (a: S, b: S) => boolean = Object.is,
): S {
	return useAgentSelection(agentName, selector, isEqual, "state");
}

export function useAgentTranscriptSelector<T, S>(
	agentName: string,
	selector: (state: T, messages: unknown[]) => S,
): S {
	return useAgentSelection(agentName, selector, Object.is, "both");
}

const identity = <T>(state: T) => state;
export function useAgentStateReadOnly<T>(agentName: string): { state: T } {
	return { state: useAgentStateSelector<T, T>(agentName, identity) };
}
