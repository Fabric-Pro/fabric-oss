export interface FabricAgentLinkContext {
	basePath: string;
	projectId?: string | null;
	projectName?: string | null;
	storyId?: string | null;
	storyIdentifier?: string | null;
	storyTitle?: string | null;
	taskId?: string | null;
	taskIdentifier?: string | null;
	taskTitle?: string | null;
	prompt?: string | null;
}

export function buildFabricAgentHref({
	basePath,
	projectId,
	projectName,
	storyId,
	storyIdentifier,
	storyTitle,
	taskId,
	taskIdentifier,
	taskTitle,
	prompt,
}: FabricAgentLinkContext): string {
	const params = new URLSearchParams();

	if (projectId) {
		params.set("projectId", projectId);
	}
	if (projectName) {
		params.set("projectName", projectName);
	}
	if (storyId) {
		params.set("storyId", storyId);
	}
	if (storyIdentifier) {
		params.set("storyIdentifier", storyIdentifier);
	}
	if (storyTitle) {
		params.set("storyTitle", storyTitle);
	}
	if (taskId) {
		params.set("taskId", taskId);
	}
	if (taskIdentifier) {
		params.set("taskIdentifier", taskIdentifier);
	}
	if (taskTitle) {
		params.set("taskTitle", taskTitle);
	}
	if (prompt?.trim()) {
		params.set("prompt", prompt.trim());
	}

	const query = params.toString();
	return `${basePath}/agents/fabric-ai${query ? `?${query}` : ""}`;
}

const TEMPLATE_INSTANCE_AGENT_PREFIX = "template-instance:";

interface AgentInstanceChatLink {
	basePath: string;
	instance: { id: string; name?: string | null; description?: string | null };
	/** `UNIFIED_AGENT_INTERFACE` — off keeps the legacy Nexus link. */
	unifiedAgentInterface: boolean;
}

/**
 * Where an agent's "Chat" / "Try Agent" link goes (Fizzy #2040, FR8).
 *
 * With the unified interface on, the agent opens on the full chat page as an
 * instance-backed chat. `mode=agent` is part of that contract, not
 * decoration: the page only treats `?instanceId=` as a per-launch agent chat
 * alongside it, and without it the launch would overwrite the user's saved
 * engine preference. With the flag off (the rollback lever) the link keeps
 * pointing at Nexus, which the flag then restores.
 */
export function buildAgentInstanceChatHref({
	basePath,
	instance,
	unifiedAgentInterface,
}: AgentInstanceChatLink): string {
	if (unifiedAgentInterface) {
		const params = new URLSearchParams({
			mode: "agent",
			instanceId: instance.id,
		});
		return `${basePath}/agents/fabric-ai?${params.toString()}`;
	}
	return `${basePath}/nexus?agent=${encodeURIComponent(
		JSON.stringify({
			agentId: `${TEMPLATE_INSTANCE_AGENT_PREFIX}${instance.id}`,
			name: instance.name,
			description: instance.description ?? "",
		}),
	)}`;
}

/**
 * The agent instance a legacy Nexus `?agent=` link names, or `null`.
 *
 * The parameter is JSON `{ agentId: "template-instance:<id>", … }`. Anything
 * else — malformed JSON, a model or registered-agent id — has no instance to
 * open and is dropped.
 */
export function instanceIdFromLegacyNexusAgentParam(
	agent: string | string[] | null | undefined,
): string | null {
	const raw = Array.isArray(agent) ? agent[0] : agent;
	if (!raw) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const agentId =
		parsed && typeof parsed === "object"
			? (parsed as { agentId?: unknown }).agentId
			: undefined;
	if (
		typeof agentId !== "string" ||
		!agentId.startsWith(TEMPLATE_INSTANCE_AGENT_PREFIX)
	) {
		return null;
	}
	const instanceId = agentId.slice(TEMPLATE_INSTANCE_AGENT_PREFIX.length);
	return instanceId || null;
}

/**
 * Where a retired Nexus URL lands on the unified page. `?agent=` becomes an
 * instance-backed chat. `?c=` is dropped on purpose: on Nexus it names an
 * `AiChat` row, on the unified page an `AgentConversation`, so forwarding it
 * would open a conversation that does not exist there.
 */
export function unifiedChatHrefFromNexusQuery(
	basePath: string,
	query: Record<string, string | string[] | undefined>,
): string {
	const instanceId = instanceIdFromLegacyNexusAgentParam(query.agent);
	if (instanceId) {
		return buildAgentInstanceChatHref({
			basePath,
			instance: { id: instanceId },
			unifiedAgentInterface: true,
		});
	}
	return `${basePath}/agents/fabric-ai`;
}
