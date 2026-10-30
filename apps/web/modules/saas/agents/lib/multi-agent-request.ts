/**
 * How one picked agent of a multi-agent message is run: its system prompt and
 * tool scope on top of the chat's own. Moved out of Nexus's
 * `useMultiAgentStream` so the agent runtime's multi-agent engine builds each
 * agent's turn by the same rules. Pure: no fetching, no React.
 */

/** A picked agent's own configuration, as its registry entry, template instance or model gives it. */
export interface MultiAgentProfile {
	agentId: string;
	name: string;
	description?: string | null;
	/** Full instructions (template instances): replace the default prompt. */
	instructions?: string | null;
	/** The agent's own MCP servers; undefined falls back to the chat's. */
	enabledMcpConfigIds?: string[] | null;
	/** The agent's knowledge bases (RAG scope). */
	workspaceIds?: string[];
	/** Set when the pick is a model. */
	modelOverride?: string;
	/** The template instance, for its memory and skills. */
	instanceId?: string;
	enabledFabricToolIds?: string[];
	boundProjectId?: string | null;
	/** The agent's OAuth integrations; undefined falls back to the chat's. */
	enabledIntegrationIds?: string[];
}

/** What the chat would send for a single-agent message. */
export interface MultiAgentSharedScope {
	enabledMcpConfigIds?: string[] | null;
	enabledFabricToolIds?: string[] | null;
	enabledIntegrationIds?: string[] | null;
	/** Explicit project selection; null disables the agent's default. */
	projectId?: string | null;
	/** The chat's attached knowledge bases, used when the agent has none. */
	workspaceIds?: string[];
}

/** The per-agent fields of one agent's Orchestrator turn request. */
export interface MultiAgentRequestOverrides {
	systemPrompt: string;
	modelOverride: string | undefined;
	instanceId: string | undefined;
	enabledMcpConfigIds: string[] | null;
	enabledFabricToolIds: string[] | null;
	enabledIntegrationIds: string[] | null;
	workspaceIds: string[];
	projectId: string | null | undefined;
}

/** Keeps replies compact and readable in a chat column. */
const CHAT_FORMATTING_POLICY = `
Respond for a chat interface:
- Be concise by default.
- Avoid decorative emojis unless they are explicitly useful.
- Prefer short headings, or no headings, unless structure materially improves clarity.
- Use tables only when they clearly improve readability.
- Do not write like a blog post, essay, or newsletter unless asked.
`.trim();

/** Workspace retrieval tools a focused agent keeps when it has knowledge bases. */
const RAG_TOOLS = ["workspace_rag_query", "workspace_rag_summarize"] as const;

/**
 * The agent's system prompt: its full instructions when it has them, else a
 * prompt built from its name and description.
 */
function multiAgentSystemPrompt(
	agent: Pick<MultiAgentProfile, "name" | "description" | "instructions">,
): string {
	if (agent.instructions) {
		return agent.instructions;
	}
	return agent.description
		? `You are ${agent.name}. ${agent.description}\n\n${CHAT_FORMATTING_POLICY}`
		: `You are ${agent.name}, an AI assistant.\n\n${CHAT_FORMATTING_POLICY}`;
}

/**
 * One agent's request fields. The agent's own MCP servers win over the
 * chat's. A focused agent (its own MCP servers) gets no Fabric tools unless
 * the chat enables some, plus workspace retrieval when it has knowledge
 * bases; a general agent keeps the chat's Fabric tools.
 */
export function multiAgentRequestOverrides(
	agent: MultiAgentProfile,
	shared: MultiAgentSharedScope = {},
): MultiAgentRequestOverrides {
	const enabledMcpConfigIds =
		agent.enabledMcpConfigIds !== undefined
			? agent.enabledMcpConfigIds
			: (shared.enabledMcpConfigIds ?? null);
	const isFocusedAgent =
		enabledMcpConfigIds !== null && enabledMcpConfigIds.length > 0;
	const baseFabricToolIds =
		agent.enabledFabricToolIds ??
		(isFocusedAgent
			? (shared.enabledFabricToolIds ?? [])
			: (shared.enabledFabricToolIds ?? null));
	const enabledFabricToolIds = isFocusedAgent
		? withRetrieval(baseFabricToolIds ?? [], agent.workspaceIds)
		: baseFabricToolIds;
	return {
		systemPrompt: multiAgentSystemPrompt(agent),
		modelOverride: agent.modelOverride,
		instanceId: agent.instanceId,
		enabledMcpConfigIds,
		enabledFabricToolIds,
		enabledIntegrationIds:
			agent.enabledIntegrationIds !== undefined
				? agent.enabledIntegrationIds
				: (shared.enabledIntegrationIds ?? null),
		workspaceIds: agent.workspaceIds ?? shared.workspaceIds ?? [],
		projectId:
			shared.projectId !== undefined
				? shared.projectId
				: agent.boundProjectId,
	};
}

function withRetrieval(
	toolIds: string[],
	workspaceIds: string[] | undefined,
): string[] {
	return workspaceIds && workspaceIds.length > 0
		? [...new Set([...toolIds, ...RAG_TOOLS])]
		: toolIds;
}
