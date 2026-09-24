export type InstructionFileKind =
	| "SKILL"
	| "AGENT"
	| "RULE"
	| "INSTRUCTIONS"
	| "SETTINGS"
	| "SCRIPT"
	| "KNOWLEDGE"
	| "OTHER";

export const INSTRUCTION_FILE_KINDS: readonly InstructionFileKind[] = [
	"SKILL",
	"AGENT",
	"RULE",
	"INSTRUCTIONS",
	"SETTINGS",
	"SCRIPT",
	"KNOWLEDGE",
	"OTHER",
];

const SCRIPT_EXTENSIONS = new Set([
	"sh",
	"bash",
	"zsh",
	"py",
	"js",
	"mjs",
	"cjs",
	"ts",
	"ps1",
	"rb",
	"pl",
]);
const KNOWLEDGE_EXTENSIONS = new Set(["md", "mdx", "rst"]);
const AGENT_DIRS = new Set([
	".claude",
	".codex",
	".cursor",
	".github",
	".agents",
	".windsurf",
]);

/** Lower-cased, forward-slashed, no leading "./". Does not validate; see paths.ts. */
export function canonicalKey(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/^(\.\/)+/, "")
		.toLowerCase();
}

/**
 * Guild-shaped trees (spec §5.8): a team loadout kept in neutral top-level
 * folders instead of an agent config dir. Recognised at the tree root or
 * directly under `.claude/`, case-insensitively (segments are already
 * lower-cased by `canonicalKey`). Inside these folders the folder decides the
 * kind, ahead of the file-name and extension rules below, so
 * `Knowledge/CLAUDE.md` is KNOWLEDGE and `Agents/tools/helper.py` is AGENT.
 * Anything outside them keeps today's rules.
 */
const GUILD_KNOWLEDGE_DIRS = new Set([
	"lessons",
	"knowledge",
	"userpreferences",
]);

function guildFolderKind(
	segments: readonly string[],
	ext: string,
): InstructionFileKind | null {
	const rel = segments[0] === ".claude" ? segments.slice(1) : segments;
	if (rel.length < 2) {
		return null;
	}
	const folder = rel[0] ?? "";
	switch (folder) {
		case "rules":
			return "RULE";
		case "agents":
			return "AGENT";
		case "skills":
			// `Skills/<name>/**`, or a `SKILL.md` at any depth under Skills/.
			return rel.length >= 3 || rel[rel.length - 1] === "skill.md"
				? "SKILL"
				: null;
		case "mcp":
			return rel.length === 2 && ext === "json" ? "SETTINGS" : null;
		case "env":
			return ext === "json" ? "SETTINGS" : null;
		default:
			return GUILD_KNOWLEDGE_DIRS.has(folder) ? "KNOWLEDGE" : null;
	}
}

export function classifyPath(path: string): InstructionFileKind {
	const key = canonicalKey(path);
	const segments = key.split("/");
	const base = segments[segments.length - 1] ?? "";
	const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";

	const guild = guildFolderKind(segments, ext);
	if (guild) {
		return guild;
	}

	// Skills: any file inside a <root>/skills/<name>/ directory under an agent config dir.
	const skillsIdx = segments.indexOf("skills");
	if (
		skillsIdx > 0 &&
		AGENT_DIRS.has(segments[skillsIdx - 1] ?? "") &&
		segments.length > skillsIdx + 2
	) {
		return "SKILL";
	}
	if (base === "skill.md") {
		return "SKILL";
	}

	if (
		segments.length >= 3 &&
		AGENT_DIRS.has(segments[0] ?? "") &&
		segments[1] === "agents"
	) {
		return "AGENT";
	}

	if (
		segments.length >= 3 &&
		AGENT_DIRS.has(segments[0] ?? "") &&
		(segments[1] === "rules" || segments[1] === "instructions")
	) {
		return "RULE";
	}
	if (base.endsWith(".instructions.md")) {
		return "RULE";
	}

	if (
		base === "claude.md" ||
		base === "agents.md" ||
		base === "gemini.md" ||
		base === "copilot-instructions.md"
	) {
		return "INSTRUCTIONS";
	}

	// The environment declaration `fabric instructions doctor` reads
	// (packages/cli/src/lib/instructions/checks.ts, INSTRUCTION_ENVIRONMENT_FILE).
	// Only the root copy is the declaration; a nested one stays OTHER.
	if (segments.length === 1 && base === "fabric.environment.json") {
		return "SETTINGS";
	}

	if (
		base === ".mcp.json" ||
		base === "mcp.json" ||
		base === "settings.json" ||
		base === "config.toml" ||
		base === "config.json"
	) {
		if (segments.length === 1 || AGENT_DIRS.has(segments[0] ?? "")) {
			return "SETTINGS";
		}
	}

	if (SCRIPT_EXTENSIONS.has(ext)) {
		return "SCRIPT";
	}
	if (KNOWLEDGE_EXTENSIONS.has(ext)) {
		return "KNOWLEDGE";
	}
	return "OTHER";
}
