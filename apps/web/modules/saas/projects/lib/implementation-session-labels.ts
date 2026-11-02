export type ExecutionChannel = "BACKGROUND_AGENTS" | "LOCAL_AGENTS";

export type ExecutionProvider = "BACKGROUND_AGENTS" | "KANBAN_LOCAL";

type FabricAgentModelTier = "COMPLEX" | "STANDARD" | "SIMPLE";

export interface FabricAgentModelOption {
	id: string;
	label: string;
	tier: FabricAgentModelTier;
	tierLabel: string;
	description: string;
}

export interface FabricAgentConnectionOption {
	value: string;
	label: string;
	shortLabel: string;
	vendor: string;
	subscriptionBadge: string;
	description: string;
	defaultModel: string;
	models: readonly FabricAgentModelOption[];
}

export type FabricAgentFallbackPolicy =
	| "subscription_harnesses"
	| "org_paid_api"
	| "pause_on_limit";

export interface FabricAgentFallbackPolicyOption {
	value: FabricAgentFallbackPolicy;
	label: string;
	badge: string;
	description: string;
}

export const FABRIC_AGENT_FALLBACK_POLICIES: readonly FabricAgentFallbackPolicyOption[] =
	[
		{
			value: "subscription_harnesses",
			label: "Fallback to other subscription harnesses",
			badge: "Recommended · Zero API cost",
			description:
				"Automatically rotate across your enabled subscription harnesses (Claude, Codex, Droid, Grok, Kimi) when the primary harness reaches its subscription quota.",
		},
		{
			value: "org_paid_api",
			label: "Use organization's paid API provider",
			badge: "Guaranteed SLA",
			description:
				"Switch to your organization's configured paid AI provider (Databricks Mosaic AI, Anthropic API, OpenAI API, Bedrock, or Vertex) when subscription tokens are spent.",
		},
		{
			value: "pause_on_limit",
			label: "Pause & wait for subscription reset",
			badge: "Strict",
			description:
				"Keep the coding session pinned to the selected harness and pause execution in place until your subscription quota window resets.",
		},
	] as const;

const DEFAULT_FALLBACK_HARNESS_CHAIN: readonly string[] = [
	"claude-max",
	"codex",
	"droid-cli",
	"grok-cli",
	"kimi-cli",
] as const;

export const FABRIC_AGENT_CONNECTIONS: readonly FabricAgentConnectionOption[] =
	[
		{
			value: "default",
			label: "Server default",
			shortLabel: "Auto",
			vendor: "Fabric Agents",
			subscriptionBadge: "Server routing",
			description: "Use the default backend configured on Fabric Agents",
			defaultModel: "default",
			models: [
				{
					id: "default",
					label: "Server default model (Auto)",
					tier: "STANDARD",
					tierLabel: "Default",
					description:
						"Uses the active harness and model tier configured on the selected Fabric Agents server.",
				},
			],
		},
		{
			value: "claude-max",
			label: "Claude Max",
			shortLabel: "Claude",
			vendor: "Anthropic",
			subscriptionBadge: "Claude Pro / Max",
			description: "Anthropic Claude Code / Claude Max subscription",
			defaultModel: "claude-sonnet-5-5",
			models: [
				{
					id: "claude-opus-5-5",
					label: "Claude Opus 5.5",
					tier: "COMPLEX",
					tierLabel: "Best · Complex",
					description:
						"Deep architecture, multi-file refactoring, and complex reasoning.",
				},
				{
					id: "claude-sonnet-5-5",
					label: "Claude Sonnet 5.5",
					tier: "STANDARD",
					tierLabel: "Balanced · Default",
					description:
						"Recommended daily driver for full-stack feature implementation.",
				},
				{
					id: "claude-haiku-5-5",
					label: "Claude Haiku 5.5",
					tier: "SIMPLE",
					tierLabel: "Fast · Simple",
					description:
						"High-speed edits, unit tests, and lightweight fixes.",
				},
			],
		},
		{
			value: "codex",
			label: "Codex",
			shortLabel: "Codex",
			vendor: "OpenAI",
			subscriptionBadge: "ChatGPT Plus / Pro",
			description: "OpenAI Codex CLI coding agent",
			defaultModel: "gpt-6.1-sol",
			models: [
				{
					id: "gpt-6.1-sol",
					label: "GPT-6.1 Sol (High Reasoning)",
					tier: "COMPLEX",
					tierLabel: "Best · Complex",
					description:
						"Flagship OpenAI coding model for complex backend and systems work.",
				},
				{
					id: "gpt-6-sol",
					label: "GPT-6 Sol",
					tier: "STANDARD",
					tierLabel: "Balanced · Default",
					description:
						"Balanced speed and coding accuracy on your ChatGPT subscription.",
				},
				{
					id: "gpt-5.5-mini",
					label: "GPT-5.5 Mini",
					tier: "SIMPLE",
					tierLabel: "Fast · Simple",
					description:
						"Low-latency execution for targeted tasks and lint fixes.",
				},
			],
		},
		{
			value: "droid-cli",
			label: "Factory Droid",
			shortLabel: "Droid",
			vendor: "Factory",
			subscriptionBadge: "Factory Plan",
			description: "Factory Droid autonomous coding agent",
			defaultModel: "gpt-6.1-sol",
			models: [
				{
					id: "gpt-6.1-sol",
					label: "Droid · GPT-6.1 Sol",
					tier: "COMPLEX",
					tierLabel: "Best · Complex",
					description:
						"Autonomous multi-step engineering with verification loops.",
				},
				{
					id: "gpt-6-sol",
					label: "Droid · GPT-6 Sol",
					tier: "STANDARD",
					tierLabel: "Balanced · Default",
					description:
						"Standard autonomous feature delivery and PR preparation.",
				},
				{
					id: "gemini-3.8-flash",
					label: "Droid · Gemini 3.8 Flash",
					tier: "SIMPLE",
					tierLabel: "Fast · Simple",
					description: "Rapid iteration and repository exploration.",
				},
			],
		},
		{
			value: "grok-cli",
			label: "Grok",
			shortLabel: "Grok",
			vendor: "xAI",
			subscriptionBadge: "SuperGrok / xAI",
			description: "xAI Grok coding agent",
			defaultModel: "grok-4.7",
			models: [
				{
					id: "grok-4.7",
					label: "Grok 4.7",
					tier: "COMPLEX",
					tierLabel: "Best · Complex",
					description:
						"xAI flagship reasoning and coding model with deep context.",
				},
				{
					id: "grok-4.6",
					label: "Grok 4.6",
					tier: "STANDARD",
					tierLabel: "Balanced · Default",
					description: "Balanced coding performance and throughput.",
				},
				{
					id: "grok-4.5",
					label: "Grok 4.5 Fast",
					tier: "SIMPLE",
					tierLabel: "Fast · Simple",
					description: "Fast turnaround for incremental tasks.",
				},
			],
		},
		{
			value: "kimi-cli",
			label: "Kimi",
			shortLabel: "Kimi",
			vendor: "Moonshot AI",
			subscriptionBadge: "Kimi Code Plan",
			description: "Moonshot Kimi coding agent",
			defaultModel: "kimi-code/kimi-for-coding",
			models: [
				{
					id: "kimi-code/k3.1-pro",
					label: "Kimi K3.1 Pro",
					tier: "COMPLEX",
					tierLabel: "Best · Complex",
					description:
						"Long-context repository analysis and multi-module changes.",
				},
				{
					id: "kimi-code/kimi-for-coding",
					label: "Kimi for Coding",
					tier: "STANDARD",
					tierLabel: "Balanced · Default",
					description:
						"Purpose-built coding model included with Kimi Code subscriptions.",
				},
				{
					id: "kimi-code/k3.1-pro-highspeed",
					label: "Kimi K3.1 Highspeed",
					tier: "SIMPLE",
					tierLabel: "Fast · Simple",
					description:
						"High-throughput streaming for rapid code generation.",
				},
			],
		},
		{
			value: "antigravity-cli",
			label: "Antigravity",
			shortLabel: "Antigravity",
			vendor: "Google",
			subscriptionBadge: "Google AI Plan",
			description: "Google Antigravity coding agent",
			defaultModel: "gemini-4-argon-high",
			models: [
				{
					id: "gemini-4-argon-high",
					label: "Gemini 4 Argon (High)",
					tier: "COMPLEX",
					tierLabel: "Best · Complex",
					description:
						"Deep agentic planning and full-repository synthesis.",
				},
				{
					id: "gemini-4-argon-medium",
					label: "Gemini 4 Argon (Medium)",
					tier: "STANDARD",
					tierLabel: "Balanced · Default",
					description: "Balanced agentic coding and verification.",
				},
				{
					id: "gemini-3.8-flash-low",
					label: "Gemini 3.8 Flash",
					tier: "SIMPLE",
					tierLabel: "Fast · Simple",
					description: "Low-latency edits and quick checks.",
				},
			],
		},
		{
			value: "cursor-cli",
			label: "Cursor",
			shortLabel: "Cursor",
			vendor: "Anysphere",
			subscriptionBadge: "Cursor Pro",
			description: "Cursor CLI coding agent",
			defaultModel: "claude-sonnet-4-6",
			models: [
				{
					id: "claude-opus-4-6",
					label: "Cursor · Claude Opus 4.6",
					tier: "COMPLEX",
					tierLabel: "Best · Complex",
					description:
						"High-reasoning model routed through Cursor CLI.",
				},
				{
					id: "claude-sonnet-4-6",
					label: "Cursor · Claude Sonnet 4.6",
					tier: "STANDARD",
					tierLabel: "Balanced · Default",
					description: "Default Cursor coding model.",
				},
				{
					id: "cursor-fast",
					label: "Cursor Fast",
					tier: "SIMPLE",
					tierLabel: "Fast · Simple",
					description: "Fast completions and quick patches.",
				},
			],
		},
	] as const;

export interface ProjectDelegationPreferences {
	preferredServerScope: "PRIVATE" | "TEAM";
	defaultConnection: string;
	defaultModel: string;
	fallbackPolicy: FabricAgentFallbackPolicy;
	fallbackHarnesses: string[];
}

export const DEFAULT_PROJECT_DELEGATION_PREFERENCES: ProjectDelegationPreferences =
	{
		preferredServerScope: "TEAM",
		defaultConnection: "default",
		defaultModel: "default",
		fallbackPolicy: "subscription_harnesses",
		fallbackHarnesses: [...DEFAULT_FALLBACK_HARNESS_CHAIN],
	};

function projectDelegationStorageKey(projectId: string): string {
	return `fabric-project-delegation-prefs-${projectId}`;
}

export function loadProjectDelegationPreferences(
	projectId?: string | null,
): ProjectDelegationPreferences {
	if (!projectId || typeof window === "undefined") {
		return DEFAULT_PROJECT_DELEGATION_PREFERENCES;
	}
	try {
		const raw = window.localStorage.getItem(
			projectDelegationStorageKey(projectId),
		);
		if (!raw) {
			return DEFAULT_PROJECT_DELEGATION_PREFERENCES;
		}
		const parsed = JSON.parse(raw) as Partial<ProjectDelegationPreferences>;
		return {
			preferredServerScope:
				parsed.preferredServerScope === "PRIVATE" ? "PRIVATE" : "TEAM",
			defaultConnection:
				typeof parsed.defaultConnection === "string"
					? parsed.defaultConnection
					: "default",
			defaultModel:
				typeof parsed.defaultModel === "string"
					? parsed.defaultModel
					: "default",
			fallbackPolicy:
				parsed.fallbackPolicy === "org_paid_api" ||
				parsed.fallbackPolicy === "pause_on_limit" ||
				parsed.fallbackPolicy === "subscription_harnesses"
					? parsed.fallbackPolicy
					: "subscription_harnesses",
			fallbackHarnesses: Array.isArray(parsed.fallbackHarnesses)
				? parsed.fallbackHarnesses.filter(
						(item): item is string => typeof item === "string",
					)
				: [...DEFAULT_FALLBACK_HARNESS_CHAIN],
		};
	} catch {
		return DEFAULT_PROJECT_DELEGATION_PREFERENCES;
	}
}

export function saveProjectDelegationPreferences(
	projectId: string,
	prefs: ProjectDelegationPreferences,
): void {
	if (!projectId || typeof window === "undefined") {
		return;
	}
	try {
		window.localStorage.setItem(
			projectDelegationStorageKey(projectId),
			JSON.stringify(prefs),
		);
		window.dispatchEvent(
			new CustomEvent("fabric-project-delegation-prefs-updated", {
				detail: { projectId, prefs },
			}),
		);
	} catch {
		// Ignore storage quota errors in restricted browsers.
	}
}

export function getFabricAgentConnectionModels(
	connectionValue: string,
): readonly FabricAgentModelOption[] {
	const found = FABRIC_AGENT_CONNECTIONS.find(
		(c) => c.value === connectionValue,
	);
	return found?.models ?? FABRIC_AGENT_CONNECTIONS[0].models;
}

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

export type FabricDesktopDeepLinkView =
	| "allSessions"
	| "settings"
	| "sources"
	| "agents"
	| "skills";

export interface FabricDesktopNewSessionUrlInput {
	projectName: string;
	projectId?: string | null;
	origin?: string | null;
	prompt?: string | null;
	send?: boolean;
}

/**
 * Builds a `fabricagents://action/new-chat` deep link that opens Fabric Desktop
 * directly into a new coding session pre-populated with this project's context
 * and zero-key OAuth MCP gateway URL.
 */
export function buildFabricDesktopNewSessionUrl(
	input: FabricDesktopNewSessionUrlInput,
): string {
	const params = new URLSearchParams();
	const trimmedName = (
		(input.projectName ?? "").trim() || "Fabric Project"
	).slice(0, 120);
	params.set("name", trimmedName);

	let sanitizedOrigin: string | null = null;
	if (input.origin) {
		try {
			const parsedOrigin = new URL(input.origin);
			parsedOrigin.username = "";
			parsedOrigin.password = "";
			sanitizedOrigin = parsedOrigin.origin;
		} catch {
			sanitizedOrigin = null;
		}
	}

	const trimmedPrompt = input.prompt?.trim();
	if (trimmedPrompt) {
		params.set("input", trimmedPrompt.slice(0, 1000));
	} else if (sanitizedOrigin && input.projectId) {
		const gateway = `${sanitizedOrigin}/api/mcp-gateway/projects/${encodeURIComponent(input.projectId)}`;
		params.set(
			"input",
			`Work on project "${trimmedName}" using Fabric MCP gateway ${gateway}. Read active features, tasks, and coding instructions, then start implementation.`.slice(
				0,
				1000,
			),
		);
	} else {
		params.set(
			"input",
			`Work on project "${trimmedName}". Read active features, tasks, and coding instructions, then start implementation.`.slice(
				0,
				1000,
			),
		);
	}

	if (input.send) {
		params.set("send", "true");
	}

	return `fabricagents://action/new-chat?${params.toString()}`;
}

/**
 * Builds a `fabricagents://<view>` compound deep link to open Fabric Desktop
 * directly to All Sessions, AI Connections & Settings (`settings`), or
 * MCP/API Sources (`sources`).
 */
export function buildFabricDesktopViewUrl(
	view: FabricDesktopDeepLinkView = "allSessions",
): string {
	return `fabricagents://${view}`;
}

export interface RemoteAgentServerDelegationUrlInput {
	serverUrl: string;
	projectName: string;
	projectId?: string | null;
	origin?: string | null;
	prompt?: string | null;
	connection?: string | null;
	model?: string | null;
	fallbackPolicy?: FabricAgentFallbackPolicy | null;
}

/**
 * Builds a remote Fabric Agents server session URL (`https://agents.example.com/?...`
 * or `http://127.0.0.1:9100/?...`) that delegates a coding task directly to the
 * remote server with the project's stateless/OAuth MCP gateway and subscription
 * harness parameters pre-attached.
 */
export function buildRemoteAgentServerDelegationUrl(
	input: RemoteAgentServerDelegationUrlInput,
): string {
	let base = "http://127.0.0.1:9100";
	try {
		const parsed = new URL(input.serverUrl.trim());
		if (parsed.protocol === "http:" || parsed.protocol === "https:") {
			parsed.username = "";
			parsed.password = "";
			base = parsed.origin;
		}
	} catch {
		base = "http://127.0.0.1:9100";
	}

	const params = new URLSearchParams();
	const trimmedName = (
		(input.projectName ?? "").trim() || "Fabric Project"
	).slice(0, 120);
	params.set("project", trimmedName);
	if (input.projectId) {
		params.set("projectId", input.projectId);
	}
	if (input.connection && input.connection !== "default") {
		params.set("harness", input.connection);
	}
	if (input.model && input.model !== "default") {
		params.set("model", input.model);
	}
	if (input.fallbackPolicy) {
		params.set("fallback", input.fallbackPolicy);
	}
	if (input.origin && input.projectId) {
		try {
			const parsedOrigin = new URL(input.origin);
			params.set(
				"mcpGateway",
				`${parsedOrigin.origin}/api/mcp-gateway/projects/${encodeURIComponent(input.projectId)}`,
			);
		} catch {
			// Ignore malformed origin
		}
	}
	if (input.prompt?.trim()) {
		params.set("prompt", input.prompt.trim().slice(0, 1000));
	}
	return `${base}/?${params.toString()}`;
}
