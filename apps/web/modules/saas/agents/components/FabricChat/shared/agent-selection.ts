import { BUILT_IN_TO_FABRIC_TOOLS } from "../../../lib/builtin-tool-map";

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
	/** Enabled built-in capabilities mapped to runtime tool IDs. */
	enabledFabricToolIds?: string[];
	/** Default project; an explicit conversation attachment takes precedence. */
	boundProjectId?: string | null;
	/** OAuth integration IDs this agent has access to (resolved from toolConnections) */
	enabledIntegrationIds?: string[];
	/** Raw OAuth provider names from toolConnections — resolved to IDs before storing */
	enabledIntegrationProviders?: string[];
	/**
	 * A ChatGPT plan model picked for this chat (Fizzy #2770 F13): kept in the
	 * chat, never saved as the member's selection.
	 */
	chatOnly?: boolean;
}

/** A chat's ChatGPT plan pick, never a saved provider model's id. */
export const PLAN_MODEL_AGENT_PREFIX = "plan-model:";

/** A model picked as the chat's agent: a provider model or a plan pick. */
export function isModelSelectionId(agentId: string): boolean {
	return (
		agentId.startsWith("model:") ||
		agentId.startsWith(PLAN_MODEL_AGENT_PREFIX)
	);
}

/**
 * For a multi-agent selection (Nexus): what to save after `changed` was
 * picked or removed, or null to save nothing. A chat-only plan pick is never
 * saved, and changing it saves nothing.
 */
export function selectionToPersist(
	changed: SelectedAgent | undefined,
	next: SelectedAgent[],
): SelectedAgent[] | null {
	if (changed?.chatOnly) {
		return null;
	}
	return next.filter((agent) => !agent.chatOnly);
}

/**
 * Whether a selection change should be saved: never one that picks, or
 * clears, a model kept in this chat only.
 */
export function shouldPersistAgentSelection(
	current: SelectedAgent | null,
	next: SelectedAgent | null,
): boolean {
	return !(next ? next.chatOnly : current?.chatOnly);
}

/** Older saved selections identify instances only through the agent ID. */
export function getSelectedAgentInstanceId(
	agent: Pick<SelectedAgent, "agentId" | "instanceId">,
): string | undefined {
	return (
		agent.instanceId ??
		(agent.agentId.startsWith("template-instance:")
			? agent.agentId.slice("template-instance:".length) || undefined
			: undefined)
	);
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
	mcpServerConfigurations?: Array<{
		mcpConfigId: string;
		isEnabled?: boolean;
	}> | null;
	_count?: { mcpServerConfigurations?: number };
	workspaceIds?: string[];
}): {
	instructions: string | null;
	enabledMcpConfigIds: string[];
	/** Includes disabled bindings so dedicated chats can distinguish inheritance from disable-all. */
	hasMcpConfiguration: boolean;
	workspaceIds: string[];
	instanceId?: string;
	enabledIntegrationProviders: string[];
	enabledFabricToolIds: string[] | undefined;
	boundProjectId: string | null;
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

	// Dedicated chats already ignore malformed entries. Keep that behavior when
	// resolving their configuration through this shared browser-safe builder.
	const rawConnections = instance.toolConnections;
	const toolConnectionsMap = Object.fromEntries(
		Object.entries(
			rawConnections &&
				typeof rawConnections === "object" &&
				!Array.isArray(rawConnections)
				? rawConnections
				: {},
		).filter(
			([, value]) =>
				value && typeof value === "object" && !Array.isArray(value),
		),
	) as Record<
		string,
		{
			enabled?: boolean;
			mcpConfigId?: string;
			connectionId?: string;
			projectId?: unknown;
		}
	>;

	const fromToolConnections = Object.entries(toolConnectionsMap)
		.filter(([, conn]) => conn.enabled !== false)
		.map(([key, conn]) =>
			key.startsWith("mcp:")
				? key.slice(4)
				: "connectionId" in conn
					? conn.connectionId
					: conn.mcpConfigId,
		)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
	const fromMcpServerConfs = (instance.mcpServerConfigurations ?? [])
		.filter((binding) => binding.isEnabled !== false)
		.map((binding) => binding.mcpConfigId);
	const enabledMcpConfigIds = [
		...new Set([...fromToolConnections, ...fromMcpServerConfs]),
	];
	const hasMcpConfiguration =
		Object.entries(toolConnectionsMap).some(
			([key, conn]) =>
				key.startsWith("mcp:") ||
				"connectionId" in conn ||
				"mcpConfigId" in conn,
		) ||
		(instance.mcpServerConfigurations?.length ?? 0) > 0 ||
		(instance._count?.mcpServerConfigurations ?? 0) > 0;

	// Extract OAuth integration providers (keys with no mcpConfigId and not mcp:-prefixed)
	// e.g. "GITHUB": {"enabled": true} → ["GITHUB"]
	const enabledIntegrationProviders = Object.entries(toolConnectionsMap)
		.filter(
			([key, conn]) =>
				conn.enabled !== false &&
				!conn.mcpConfigId &&
				!("connectionId" in conn) &&
				!key.startsWith("mcp:") &&
				!(key in BUILT_IN_TO_FABRIC_TOOLS),
		)
		.map(([key]) => key);

	// No declared built-in capabilities inherits the caller's scope; an explicit
	// configuration with every capability disabled must remain [] (disable all).
	const builtInConnections = Object.entries(toolConnectionsMap).filter(
		([key, conn]) =>
			Object.hasOwn(BUILT_IN_TO_FABRIC_TOOLS, key) &&
			!("connectionId" in conn),
	);
	const enabledFabricToolIds =
		builtInConnections.length > 0
			? [
					...new Set(
						builtInConnections
							.filter(([, conn]) => conn.enabled !== false)
							.flatMap(([key]) => BUILT_IN_TO_FABRIC_TOOLS[key]),
					),
				]
			: undefined;
	const projectConfig = toolConnectionsMap["project-context"];
	const boundProjectId =
		projectConfig?.enabled !== false &&
		projectConfig &&
		!("connectionId" in projectConfig) &&
		typeof projectConfig?.projectId === "string" &&
		projectConfig.projectId.length > 0
			? projectConfig.projectId
			: null;

	return {
		hasMcpConfiguration,
		enabledFabricToolIds,
		boundProjectId,
		instructions: instructionParts.join("\n\n") || null,
		enabledMcpConfigIds:
			enabledMcpConfigIds.length > 0 ? enabledMcpConfigIds : [],
		workspaceIds: instance.workspaceIds ?? [],
		instanceId: instance.id,
		enabledIntegrationProviders,
	};
}
