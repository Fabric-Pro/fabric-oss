/**
 * The name of a runtime agent's side payload on the wire. A request/reply
 * chat on the agent runtime sends its answer as AG-UI text and anything
 * else it hands the browser (sources, a structured result, progress) as a
 * CUSTOM event named `fabric.<agent>.<kind>`, so the browser tells the
 * agents' payloads apart by name alone.
 */
export function runtimeCustomEventName<
	Agent extends string,
	Kind extends string,
>(agentId: Agent, kind: Kind): `fabric.${Agent}.${Kind}` {
	return `fabric.${agentId}.${kind}`;
}
