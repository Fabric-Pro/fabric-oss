export type AgentId = "claude-code" | "codex" | "vscode" | "cursor" | "other";

export interface AgentTool {
	id: AgentId;
	label: string;
	/** A mark served from `public/integrations`, or `null` for the generic plug. */
	logo: string | null;
	/**
	 * Whether the mark sits on a neutral chip. The Anthropic mark is its own
	 * rounded tile and fills the space; every other mark is drawn on a chip so
	 * it reads the same in both themes.
	 */
	chipped: boolean;
	logoClassName: string;
	/** A single-colour black mark vanishes on a dark chip unless it is inverted. */
	invertOnDark: boolean;
}

/** In the order the picker shows them. */
export const AGENTS: readonly AgentTool[] = [
	{
		id: "claude-code",
		label: "Claude Code",
		logo: "/integrations/Anthropic.svg",
		chipped: false,
		logoClassName: "size-8",
		invertOnDark: false,
	},
	{
		id: "codex",
		label: "Codex",
		logo: "/integrations/Openai.svg",
		chipped: true,
		logoClassName: "size-5",
		invertOnDark: true,
	},
	{
		id: "vscode",
		label: "VS Code",
		logo: "/integrations/VisualStudioCode.svg",
		chipped: true,
		logoClassName: "size-6",
		invertOnDark: false,
	},
	{
		id: "cursor",
		label: "Cursor",
		logo: "/integrations/Cursor.svg",
		chipped: true,
		logoClassName: "size-5",
		invertOnDark: true,
	},
	{
		id: "other",
		label: "Other",
		logo: null,
		chipped: true,
		logoClassName: "size-5",
		invertOnDark: false,
	},
];

export function isAgentId(value: string): value is AgentId {
	return AGENTS.some((agent) => agent.id === value);
}

export function agentById(id: AgentId): AgentTool {
	const agent = AGENTS.find((candidate) => candidate.id === id);
	if (!agent) {
		throw new Error(`Unknown coding tool: ${id}`);
	}
	return agent;
}
