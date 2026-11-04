/**
 * Consolidation plan (specs/2026-10-21-ai-artifacts-hub §5.2, P4): which
 * files of a code repository are AI-tool content, and where each one lives in
 * the project's separate instructions repository.
 *
 * The plan is pure: it reads paths (and blob ids, to fold identical copies)
 * and never file contents. The canonical layout is the one the Coding
 * Instructions plugin renders from (`@fabricorg/sdk` plugin-mapping):
 *
 * - `AGENTS.md`, `CLAUDE.md` at the root (always-on);
 * - `rules/**` (always-on rules), `skills/<name>/**`, `agents/**`,
 *   `commands/**`;
 * - `tools/<tool>/**` for tool settings, hooks and anything else found in a
 *   tool folder: kept, so nothing is lost, but not delivered as instructions.
 *
 * A directory-scoped `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` (for example
 * `packages/api/AGENTS.md`) becomes `rules/scoped/<dir>/<file>` with a header
 * saying which folder it applies to (`transform: "scope-header"`).
 *
 * Files that are likely personal (`*.local.*`, `.env*`) are never moved. A
 * neutral root folder (`skills/`, `agents/`, `rules/`, `knowledge/`, ...) can
 * be application code just as well, so it is offered but not included by
 * default.
 */

export type ConsolidationTarget =
	| "INSTRUCTIONS"
	| "RULE"
	| "SKILL"
	| "AGENT"
	| "COMMAND"
	| "KNOWLEDGE"
	| "TOOL";

export type ConsolidationSourceFile = {
	path: string;
	/** The blob id; identical copies under two tools fold into one. */
	oid?: string;
	/** Git file mode; symlinks and submodules are never moved. */
	mode?: string;
};

export type ConsolidationItem = {
	/** The path in the code repository; removed by the cleanup pull request. */
	from: string;
	/** The path in the instructions repository; null when `from` is an identical duplicate of another item. */
	to: string | null;
	target: ConsolidationTarget;
	/** The tool the file was found under (`claude`, `cursor`, ...) or `shared`. */
	tool: string;
	/** Included unless the person opts out; false for neutral root folders. */
	defaultIncluded: boolean;
	transform?: "scope-header";
	/** For a duplicate: the item whose copy is kept. */
	duplicateOf?: string;
	oid?: string;
};

export type ConsolidationSkip = {
	path: string;
	reason: "personal" | "not-a-file";
};

export type ConsolidationPlan = {
	items: ConsolidationItem[];
	skipped: ConsolidationSkip[];
};

/** Tool folders whose content is AI configuration as a whole. `.github` is special-cased. */
const TOOL_DIRS: Record<string, string> = {
	".claude": "claude",
	".codex": "codex",
	".cursor": "cursor",
	".agents": "agents",
	".windsurf": "windsurf",
	".gemini": "gemini",
	".kiro": "kiro",
	".roo": "roo",
	".continue": "continue",
	".junie": "junie",
	".amazonq": "amazonq",
	".devin": "devin",
	".factory": "factory",
	".opencode": "opencode",
	".clinerules": "cline",
	".github": "copilot",
};

/** Which tool wins when two tools hold different files at one canonical path. */
const TOOL_PRIORITY = [
	"shared",
	"claude",
	"agents",
	"codex",
	"cursor",
	"copilot",
	"gemini",
	"windsurf",
	"kiro",
	"roo",
	"cline",
	"continue",
	"junie",
	"amazonq",
	"devin",
	"factory",
	"opencode",
];

/** Single files at the repository root that belong to one tool. */
const ROOT_TOOL_FILES: Record<string, { to: string; tool: string }> = {
	".cursorrules": { to: "rules/cursor.md", tool: "cursor" },
	".windsurfrules": { to: "rules/windsurf.md", tool: "windsurf" },
	".clinerules": { to: "rules/cline.md", tool: "cline" },
	".mcp.json": { to: "tools/mcp.json", tool: "shared" },
	".aider.conf.yml": { to: "tools/aider/.aider.conf.yml", tool: "aider" },
	".aiderignore": { to: "tools/aider/.aiderignore", tool: "aider" },
	".cursorignore": { to: "tools/cursor/.cursorignore", tool: "cursor" },
	".geminiignore": { to: "tools/gemini/.geminiignore", tool: "gemini" },
	"fabric.environment.json": {
		to: "fabric.environment.json",
		tool: "shared",
	},
};

/** Instruction files recognised at any depth. */
const INSTRUCTION_FILES = new Set(["agents.md", "claude.md", "gemini.md"]);

/** Neutral root folders: offered, not included by default. */
const NEUTRAL_ROOT_DIRS: Record<string, ConsolidationTarget> = {
	skills: "SKILL",
	agents: "AGENT",
	rules: "RULE",
	commands: "COMMAND",
	knowledge: "KNOWLEDGE",
	lessons: "KNOWLEDGE",
	userpreferences: "KNOWLEDGE",
};

/** `.github` paths that are Copilot content; the rest of `.github` is CI and never moved. */
function copilotItem(
	rest: string[],
): { to: string; target: ConsolidationTarget } | null {
	const [head, ...tail] = rest;
	const lowerHead = head?.toLowerCase();
	if (rest.length === 1 && lowerHead === "copilot-instructions.md") {
		return { to: "rules/copilot-instructions.md", target: "RULE" };
	}
	if (tail.length === 0) {
		return null;
	}
	const file = tail.join("/");
	switch (lowerHead) {
		case "instructions":
			return {
				to: `rules/${file.replace(/\.instructions\.md$/i, ".md")}`,
				target: "RULE",
			};
		case "prompts":
			return {
				to: `commands/${file.replace(/\.prompt\.md$/i, ".md")}`,
				target: "COMMAND",
			};
		case "agents":
		case "chatmodes":
			return {
				to: `agents/${file.replace(/\.(agent|chatmode)\.md$/i, ".md")}`,
				target: "AGENT",
			};
		case "skills":
			return tail.length >= 2
				? { to: `skills/${file}`, target: "SKILL" }
				: null;
		default:
			return null;
	}
}

/** A path inside a tool folder: its canonical place, or `tools/<tool>/...`. */
function toolDirItem(
	tool: string,
	rest: string[],
): { to: string; target: ConsolidationTarget } {
	const [head, ...tail] = rest;
	const lowerHead = head?.toLowerCase() ?? "";
	const file = tail.join("/");
	if (tail.length > 0) {
		if (lowerHead === "skills" && tail.length >= 2) {
			return { to: `skills/${file}`, target: "SKILL" };
		}
		if (lowerHead === "agents") {
			return { to: `agents/${file}`, target: "AGENT" };
		}
		if (
			lowerHead === "commands" ||
			lowerHead === "prompts" ||
			lowerHead === "workflows"
		) {
			return {
				to: `commands/${file.replace(/\.prompt\.md$/i, ".md")}`,
				target: "COMMAND",
			};
		}
		if (
			lowerHead === "rules" ||
			lowerHead === "instructions" ||
			lowerHead === "steering"
		) {
			return {
				to: `rules/${file.replace(/\.mdc$/i, ".md").replace(/\.instructions\.md$/i, ".md")}`,
				target: "RULE",
			};
		}
	}
	if (tool === "cline") {
		// `.clinerules/` is a folder of rules.
		return { to: `rules/${rest.join("/")}`, target: "RULE" };
	}
	if (rest.length === 1 && INSTRUCTION_FILES.has(lowerHead)) {
		// `.claude/CLAUDE.md`, `.gemini/GEMINI.md`: the tool's own always-on file.
		return { to: `rules/${tool}.md`, target: "RULE" };
	}
	if (
		tool === "junie" &&
		rest.length === 1 &&
		lowerHead === "guidelines.md"
	) {
		return { to: "rules/junie-guidelines.md", target: "RULE" };
	}
	return { to: `tools/${tool}/${rest.join("/")}`, target: "TOOL" };
}

function isPersonal(segments: string[]): boolean {
	const base = (segments[segments.length - 1] ?? "").toLowerCase();
	return base.startsWith(".env") || /\.local(\.[a-z0-9]+)?$/.test(base);
}

function classify(
	segments: string[],
): Omit<ConsolidationItem, "from" | "oid"> | null {
	const [first = "", ...rest] = segments;
	const lowerFirst = first.toLowerCase();
	const base = (segments[segments.length - 1] ?? "").toLowerCase();

	if (segments.length === 1) {
		const rootFile = ROOT_TOOL_FILES[lowerFirst];
		if (rootFile) {
			return {
				to: rootFile.to,
				target: rootFile.to.startsWith("tools/")
					? "TOOL"
					: rootFile.to.startsWith("rules/")
						? "RULE"
						: "INSTRUCTIONS",
				tool: rootFile.tool,
				defaultIncluded: true,
			};
		}
		if (
			lowerFirst === "agents.md" ||
			lowerFirst === "claude.md" ||
			// Reported as personal and left alone by `isPersonal`.
			/^(agents|claude|gemini)\.local\.md$/.test(lowerFirst)
		) {
			return {
				to: lowerFirst === "agents.md" ? "AGENTS.md" : "CLAUDE.md",
				target: "INSTRUCTIONS",
				tool: "shared",
				defaultIncluded: true,
			};
		}
		if (lowerFirst === "gemini.md") {
			return {
				to: "rules/gemini.md",
				target: "RULE",
				tool: "gemini",
				defaultIncluded: true,
			};
		}
		return null;
	}

	const tool = TOOL_DIRS[lowerFirst];
	if (tool) {
		const mapped =
			tool === "copilot" ? copilotItem(rest) : toolDirItem(tool, rest);
		return mapped ? { ...mapped, tool, defaultIncluded: true } : null;
	}

	const neutral = NEUTRAL_ROOT_DIRS[lowerFirst];
	if (neutral) {
		return {
			to: [lowerFirst, ...rest].join("/"),
			target: neutral,
			tool: "shared",
			defaultIncluded: false,
		};
	}

	if (INSTRUCTION_FILES.has(base)) {
		const dir = segments.slice(0, -1).join("/");
		return {
			to: `rules/scoped/${dir}/${segments[segments.length - 1]}`,
			target: "RULE",
			tool: base === "gemini.md" ? "gemini" : "shared",
			defaultIncluded: true,
			transform: "scope-header",
		};
	}
	return null;
}

function priorityOf(tool: string): number {
	const index = TOOL_PRIORITY.indexOf(tool);
	return index === -1 ? TOOL_PRIORITY.length : index;
}

/** Folders whose content is never AI configuration, whatever its name. */
const NEVER_SCANNED = new Set(["node_modules", ".git", "vendor", "dist"]);

export function planConsolidation(
	files: readonly ConsolidationSourceFile[],
): ConsolidationPlan {
	const items: ConsolidationItem[] = [];
	const skipped: ConsolidationSkip[] = [];
	for (const file of files) {
		const path = file.path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
		const segments = path.split("/").filter((s) => s !== "");
		if (segments.some((s) => NEVER_SCANNED.has(s.toLowerCase()))) {
			continue;
		}
		const mapped = classify(segments);
		if (!mapped) {
			continue;
		}
		if (file.mode && file.mode !== "100644" && file.mode !== "100755") {
			skipped.push({ path, reason: "not-a-file" });
			continue;
		}
		if (isPersonal(segments)) {
			skipped.push({ path, reason: "personal" });
			continue;
		}
		items.push({
			from: path,
			...mapped,
			...(file.oid ? { oid: file.oid } : {}),
		});
	}

	// One file per canonical path: the highest-priority tool keeps it, an
	// identical copy is only removed, a different one is kept under its tool.
	items.sort(
		(a, b) =>
			priorityOf(a.tool) - priorityOf(b.tool) ||
			a.from.localeCompare(b.from),
	);
	const owners = new Map<string, ConsolidationItem>();
	for (const item of items) {
		if (item.to === null) {
			continue;
		}
		const key = item.to.toLowerCase();
		const owner = owners.get(key);
		if (!owner) {
			owners.set(key, item);
			continue;
		}
		if (owner.oid !== undefined && owner.oid === item.oid) {
			item.duplicateOf = owner.from;
			item.to = null;
			continue;
		}
		item.to = `tools/${item.tool}/${item.from.split("/").slice(1).join("/") || item.from}`;
		item.target = "TOOL";
		owners.set(item.to.toLowerCase(), item);
	}
	items.sort((a, b) => a.from.localeCompare(b.from));
	return { items, skipped };
}

/** The header a directory-scoped instruction file gets in `rules/scoped/`. */
export function scopeHeader(from: string): string {
	const dir = from.split("/").slice(0, -1).join("/");
	return `> Applies when working on files under \`${dir}/\`.\n\n`;
}

/** The code repository's cleanup branch; one per consolidation run. */
export function cleanupBranchName(consolidationId: string): string {
	const suffix = consolidationId
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.slice(-8);
	return `fabric/move-ai-instructions-${suffix}`;
}
