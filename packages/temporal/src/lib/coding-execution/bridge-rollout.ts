/** Keep API and worker settings aligned; drain runs before changing the endpoint or mode. */
export function isFabricAgentsBridgeEnabled(): boolean {
	return process.env.FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED === "true";
}
