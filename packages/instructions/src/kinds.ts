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

export function classifyPath(path: string): InstructionFileKind {
	const key = canonicalKey(path);
	const segments = key.split("/");
	const base = segments[segments.length - 1] ?? "";
	const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";

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
