export const RETIRED_SYSTEM_AGENT_IDS = [
	"cuga_generalist",
	"cuga-generalist",
] as const;

export function isRetiredSystemAgent(agent: {
	agentId: string;
	scope: string;
}): boolean {
	return (
		agent.scope === "SYSTEM" &&
		RETIRED_SYSTEM_AGENT_IDS.some((id) => id === agent.agentId)
	);
}
