"use client";

import { useAgent } from "@copilotkit/react-core/v2";
import { useCallback, useEffect, useRef, useState } from "react";
import { useReseedAgentStateOnRunStart } from "./use-agent-state-reseed";
import { useAgentStateSelector } from "./useAgentStateReadOnly";

/** Page subscriptions include only state fields read by that page and node transitions. */
export function usePageAgent<T extends object>(
	name: string,
	initialState: T,
	keys: readonly (keyof T)[],
) {
	const { agent } = useAgent({ agentId: name, updates: [] });
	const seed = useRef(initialState);
	seed.current = initialState;
	useReseedAgentStateOnRunStart(name, (state) =>
		Object.keys(state).length
			? state
			: ({ ...seed.current } as Record<string, unknown>),
	);
	useEffect(() => {
		if (!agent) {
			return;
		}
		const subscription = agent.subscribe({
			onRunInitialized: ({ state }) => {
				if (Object.keys(state ?? {}).length) {
					agent.setState({ ...agent.state, ...state });
				} else if (!Object.keys(agent.state ?? {}).length) {
					agent.setState({ ...seed.current });
				}
			},
		});
		return () => subscription.unsubscribe();
	}, [agent]);
	const selector = useCallback(
		(state: T) =>
			Object.fromEntries(keys.map((key) => [key, state[key]])) as T,
		[keys],
	);
	const equality = useCallback(
		(a: T, b: T) =>
			keys.every((key) => {
				const left = a[key];
				const right = b[key];
				return Array.isArray(left) && Array.isArray(right)
					? left.length === right.length &&
							left.every((value, index) =>
								Object.is(value, right[index]),
							)
					: Object.is(left, right);
			}),
		[keys],
	);
	const state = useAgentStateSelector<T, T>(name, selector, equality);
	const setState = useCallback(
		(update: T | ((prev: T) => T)) => {
			if (!agent) {
				return;
			}
			agent.setState(
				typeof update === "function"
					? update(agent.state as T)
					: { ...agent.state, ...update },
			);
		},
		[agent],
	);
	const [nodeName, setNodeName] = useState("start");
	const previousAgent = useRef(agent);
	useEffect(() => {
		if (previousAgent.current !== agent) {
			previousAgent.current = agent;
			setNodeName("start");
		}
		let lastActive = "start";
		let interrupted = false;
		const subscription = agent?.subscribe({
			onStepStartedEvent: ({ event }) => {
				lastActive = event.stepName;
				setNodeName(lastActive);
			},
			onRunStartedEvent: () => {
				lastActive = "start";
				interrupted = false;
				setNodeName("start");
			},
			onCustomEvent: ({ event }) => {
				if (event.name === "on_interrupt") {
					interrupted = true;
				}
			},
			onRunFinishedEvent: ({ outcome }) => {
				setNodeName(
					outcome === "interrupt" || interrupted ? lastActive : "end",
				);
				interrupted = false;
			},
			onRunErrorEvent: () => {
				setNodeName("end");
				interrupted = false;
			},
		});
		return () => subscription?.unsubscribe();
	}, [agent]);
	return { state, setState, nodeName, agent };
}
