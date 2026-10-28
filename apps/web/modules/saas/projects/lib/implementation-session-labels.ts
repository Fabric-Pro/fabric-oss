export type ExecutionChannel = "BACKGROUND_AGENTS" | "LOCAL_AGENTS";

export type ExecutionProvider = "BACKGROUND_AGENTS" | "KANBAN_LOCAL";

export interface FabricAgentConnectionOption {
	value: string;
	label: string;
	description: string;
}

export const FABRIC_AGENT_CONNECTIONS: readonly FabricAgentConnectionOption[] =
	[
		{
			value: "default",
			label: "Server default",
			description: "Use the default backend configured on Fabric Agents",
		},
		{
			value: "claude-max",
			label: "Claude Max",
			description: "Anthropic Claude Code / Claude Max subscription",
		},
		{
			value: "codex",
			label: "Codex",
			description: "OpenAI Codex CLI coding agent",
		},
		{
			value: "cursor-cli",
			label: "Cursor",
			description: "Cursor CLI coding agent",
		},
		{
			value: "antigravity-cli",
			label: "Antigravity",
			description: "Google Antigravity coding agent",
		},
		{
			value: "droid-cli",
			label: "Factory Droid",
			description: "Factory Droid autonomous coding agent",
		},
		{
			value: "grok-cli",
			label: "Grok",
			description: "xAI Grok coding agent",
		},
		{
			value: "kimi-cli",
			label: "Kimi",
			description: "Moonshot Kimi coding agent",
		},
	] as const;

const CONNECTION_ALIAS_LABELS: Record<string, string> = {
	"anthropic-api": "Claude (API)",
	"chatgpt-plus": "Codex",
	cursor: "Cursor",
	antigravity: "Antigravity",
	droid: "Factory Droid",
	grok: "Grok",
	"grokbot-cli": "GrokBot",
	kimi: "Kimi",
};

export function getFabricAgentConnectionLabel(
	connectionSlug?: string | null,
): string | null {
	if (!connectionSlug || connectionSlug === "default") {
		return null;
	}
	const normalized = connectionSlug.trim().toLowerCase();
	const match = FABRIC_AGENT_CONNECTIONS.find(
		(option) => option.value.toLowerCase() === normalized,
	);
	if (match) {
		return match.label;
	}
	return CONNECTION_ALIAS_LABELS[normalized] ?? connectionSlug;
}

export function getExecutionChannelLabel(channel?: string | null): string {
	switch (channel) {
		case "LOCAL_AGENTS":
			return "Local execution";
		default:
			return "Remote execution";
	}
}

export function getExecutionProviderLabel(provider?: string | null): string {
	switch (provider) {
		case "KANBAN_LOCAL":
			return "Local development";
		default:
			return "Fabric Agents";
	}
}

export function getExecutionProviderPlatformLabel(
	provider?: string | null,
): string {
	switch (provider) {
		case "KANBAN_LOCAL":
			return "Fabric Kanban";
		default:
			return "Fabric Agents";
	}
}

export function getExecutionProviderDescription(
	provider?: string | null,
): string {
	switch (provider) {
		case "KANBAN_LOCAL":
			return "Runs in your checked-out repository through Fabric Kanban. Run fabric-kanban locally to pull queued work.";
		default:
			return "Runs in an isolated git worktree on Fabric Agents with live desktop & Web UI session tracking.";
	}
}

export type ImplementationRecommendationInput = {
	hasRepositoryContext: boolean;
	openTaskCount: number;
	focusedTaskId?: string | null;
	implementationDefaultChannel?: ExecutionChannel | null;
	implementationDefaultProvider?: ExecutionProvider | null;
};

export type ImplementationRecommendation = {
	channel: ExecutionChannel;
	provider: ExecutionProvider;
	reason: string;
};

export function getImplementationRecommendation(
	input: ImplementationRecommendationInput,
): ImplementationRecommendation {
	if (!input.hasRepositoryContext) {
		return {
			channel: "BACKGROUND_AGENTS",
			provider: "BACKGROUND_AGENTS",
			reason: "Direct implementation needs a connected repository. Until one is configured, Weave is the better starting point for planning and orchestration.",
		};
	}

	return {
		channel: "BACKGROUND_AGENTS",
		provider: "BACKGROUND_AGENTS",
		reason: "Fabric Agents is the recommended path for direct implementation in an isolated git worktree. Choose local development only when Fabric Kanban should pull queued work into a manual checkout.",
	};
}
