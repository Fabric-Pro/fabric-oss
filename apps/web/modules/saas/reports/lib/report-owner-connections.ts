function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a saved report is bound to connections. What those connections read,
 * its context, resources and data source parameters, is then the owner's to
 * change: `reports.instances.update` refuses the same edits from anyone else.
 */
export function reportHasConnections(connections: unknown): boolean {
	if (!isRecord(connections)) {
		return false;
	}
	return [
		connections.mcpConfigs,
		connections.mcpBindings,
		connections.integrations,
		connections.integrationBindings,
	].some((bound) =>
		Array.isArray(bound)
			? bound.length > 0
			: isRecord(bound) && Object.keys(bound).length > 0,
	);
}
