/**
 * The shape of a picked agent, and how a template instance becomes one.
 *
 * Both were private to the Nexus page, which is the only surface with an
 * agent/model picker today. The unified agent interface makes the picker
 * shared, so the type it produces and the builder that normalizes a raw
 * template instance into it have to live beside the shared chat components.
 *
 * Pure: a type and one total function, no React and no data fetching.
 */

export interface SelectedAgent {
	agentId: string;
	name: string;
	description?: string | null;
	/** Full agent instructions (for template instances — overrides default system prompt) */
	instructions?: string | null;
	/** MCP config IDs this agent should have access to (null = use user prefs) */
	enabledMcpConfigIds?: string[] | null;
	/** Workspace IDs for RAG scoping — links to agent's knowledge base */
	workspaceIds?: string[];
	/** canonical model name — only set when this is a model-as-agent (agentId starts with "model:") */
	modelOverride?: string;
	/** vendor name for model agents — used to display vendor logos */
	vendor?: string;
	/** agent instance ID for memory/skills loading */
	instanceId?: string;
	/** OAuth integration IDs this agent has access to (resolved from toolConnections) */
	enabledIntegrationIds?: string[];
	/** Raw OAuth provider names from toolConnections — resolved to IDs before storing */
	enabledIntegrationProviders?: string[];
}

/**
 * Extract and build the agent config fields from a raw template instance object.
 * Shared by AgentBrowserPanel, ComposePicker, and the config registry.
 */
export function buildInstanceAgentConfig(instance: {
	id?: string;
	template?: { instructions?: string | null } | null;
	customInstructions?: unknown;
	toolConnections?: unknown;
	mcpServerConfigurations?: Array<{ mcpConfigId: string }> | null;
	workspaceIds?: string[];
}): {
	instructions: string | null;
	enabledMcpConfigIds: string[];
	workspaceIds: string[];
	instanceId?: string;
	enabledIntegrationProviders: string[];
} {
	const baseInstructions: string = instance.template?.instructions ?? "";
	const custom = instance.customInstructions as Record<
		string,
		unknown
	> | null;
	const instructionParts = [baseInstructions.trim()].filter(Boolean);
	if (custom?.role && typeof custom.role === "string" && custom.role.trim()) {
		instructionParts.push(custom.role.trim());
	}
	if (
		custom?.additionalContext &&
		typeof custom.additionalContext === "string" &&
		custom.additionalContext.trim()
	) {
		instructionParts.push(custom.additionalContext.trim());
	}
	if (
		custom?.constraints &&
		typeof custom.constraints === "string" &&
		custom.constraints.trim()
	) {
		instructionParts.push(`Constraints:\n${custom.constraints.trim()}`);
	}

	const toolConnectionsMap =
		(instance.toolConnections as Record<
			string,
			{ enabled?: boolean; mcpConfigId?: string }
		> | null) ?? {};
	const fromToolConnections = Object.values(toolConnectionsMap)
		.filter((conn) => conn.enabled !== false && conn.mcpConfigId)
		.map((conn) => conn.mcpConfigId as string);
	const fromMcpServerConfs = (
		(instance.mcpServerConfigurations ?? []) as Array<{
			mcpConfigId: string;
		}>
	).map((c) => c.mcpConfigId);
	const enabledMcpConfigIds = [
		...new Set([...fromToolConnections, ...fromMcpServerConfs]),
	];

	// Extract OAuth integration providers (keys with no mcpConfigId and not mcp:-prefixed)
	// e.g. "GITHUB": {"enabled": true} → ["GITHUB"]
	const enabledIntegrationProviders = Object.entries(toolConnectionsMap)
		.filter(
			([key, conn]) =>
				conn.enabled !== false &&
				!conn.mcpConfigId &&
				!key.startsWith("mcp:"),
		)
		.map(([key]) => key);

	return {
		instructions: instructionParts.join("\n\n") || null,
		enabledMcpConfigIds:
			enabledMcpConfigIds.length > 0 ? enabledMcpConfigIds : [],
		workspaceIds: instance.workspaceIds ?? [],
		instanceId: instance.id,
		enabledIntegrationProviders,
	};
}
