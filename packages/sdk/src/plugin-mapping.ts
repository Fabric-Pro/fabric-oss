/**
 * Where a project's instruction files go when a coding tool loads them, and
 * which ones it has no place for.
 *
 * One pure mapping, shared by everything that has to agree about it: the CLI
 * that builds the plugin and the server that tells a project admin, in the
 * Coding Instructions tab, what a plugin leaves out. It reads paths (and, when
 * the caller knows them, sizes and whether a file is text) and nothing else.
 *
 * The standard layout, at the root of the instructions or under `.claude/`
 * (folder names are matched without regard to case; the names below them keep
 * theirs):
 *
 *   skills/<name>/**           ->  plugin skills/<name>/**
 *   agents/<file>.md           ->  plugin agents/<file>.md
 *   commands/**                ->  plugin commands/**
 *   rules/**\/*.md              ->  project rules (delivered into the project
 *                                  folder, not placed in the plugin)
 *   CLAUDE.md (else AGENTS.md) ->  the session's always-on context
 */

export type PluginTool = "claude-code" | "codex";

/** Why a plugin has no place for an instruction file. */
export const PLUGIN_LEFT_OUT_REASONS = [
	"outside-plugin-folders",
	"skill-needs-folder",
	"agent-must-be-markdown-file",
	"rule-must-be-markdown",
	"not-text",
	"always-on-shadowed",
] as const;

export type PluginLeftOutReason = (typeof PLUGIN_LEFT_OUT_REASONS)[number];

/** What the caller knows about an instruction file. */
export interface PluginEntry {
	/** Relative POSIX path inside the instructions tree. */
	path: string;
	/** Bytes, when known. A file of size 0 is not a memory file. */
	size?: number;
	/** Whether the file is text, when known. */
	isText?: boolean;
}

export interface PluginPlan {
	/** Files that go into the plugin, and where. Sorted by path. */
	carried: Array<{ path: string; as: string }>;
	/** Files delivered as project rules, and their path below `rules/`. Sorted by path. */
	rules: Array<{ path: string; as: string }>;
	/** The memory file the session context is built from. */
	alwaysOn: { path: AlwaysOnFile } | null;
	/** Files with no place, and why. Sorted by path. */
	leftOut: Array<{ path: string; reason: PluginLeftOutReason }>;
}

const ALWAYS_ON_FILES = ["CLAUDE.md", "AGENTS.md"] as const;
type AlwaysOnFile = (typeof ALWAYS_ON_FILES)[number];

/** The path with a leading `.claude/` taken off, as segments. */
function segmentsBelowRoot(instructionPath: string): string[] {
	const segments = instructionPath.split("/");
	return segments[0]?.toLowerCase() === ".claude"
		? segments.slice(1)
		: segments;
}

function isMarkdown(name: string | undefined): boolean {
	return name?.toLowerCase().endsWith(".md") ?? false;
}

/**
 * Where an instruction file goes in the plugin, or `null` when the plugin
 * tree has no place for it (project rules are delivered elsewhere).
 */
export function pluginPathFor(instructionPath: string): string | null {
	const rest = segmentsBelowRoot(instructionPath);
	const folder = rest[0]?.toLowerCase();
	if (rest.length < 2) {
		return null;
	}
	const below = rest.slice(1);
	switch (folder) {
		case "skills":
			return below.length >= 2 ? `skills/${below.join("/")}` : null;
		case "agents":
			return below.length === 1 && isMarkdown(below[0])
				? `agents/${below[0]}`
				: null;
		case "commands":
			return `commands/${below.join("/")}`;
		default:
			return null;
	}
}

/**
 * The path of a project rule below `rules/`, or `null` when the file is not
 * one. `rules/**` and `.claude/rules/**` markdown files are rules.
 */
export function projectRulePathFor(instructionPath: string): string | null {
	const rest = segmentsBelowRoot(instructionPath);
	if (
		rest.length < 2 ||
		rest[0]?.toLowerCase() !== "rules" ||
		!isMarkdown(rest[rest.length - 1])
	) {
		return null;
	}
	return rest.slice(1).join("/");
}

/** Why a path with no place has none. */
function reasonFor(instructionPath: string): PluginLeftOutReason {
	const rest = segmentsBelowRoot(instructionPath);
	if (rest.length >= 2) {
		switch (rest[0]?.toLowerCase()) {
			case "skills":
				return "skill-needs-folder";
			case "agents":
				return "agent-must-be-markdown-file";
			case "rules":
				return "rule-must-be-markdown";
			default:
				break;
		}
	}
	return "outside-plugin-folders";
}

const byPath = (a: { path: string }, b: { path: string }) =>
	a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * What a plugin for `tool` does with each instruction file. Claude Code reads
 * `CLAUDE.md` first and Codex `AGENTS.md`; the other is the fallback when the
 * preferred one is missing or empty, and is otherwise left out as shadowed.
 */
export function planPluginFiles(
	entries: readonly PluginEntry[],
	tool: PluginTool,
): PluginPlan {
	const order: readonly AlwaysOnFile[] =
		tool === "codex" ? ["AGENTS.md", "CLAUDE.md"] : ALWAYS_ON_FILES;
	const present = new Map(entries.map((entry) => [entry.path, entry]));
	const alwaysOn =
		order.find((name) => {
			const entry = present.get(name);
			return entry !== undefined && entry.size !== 0;
		}) ?? null;

	const plan: PluginPlan = {
		carried: [],
		rules: [],
		alwaysOn: alwaysOn === null ? null : { path: alwaysOn },
		leftOut: [],
	};
	for (const entry of entries) {
		if (entry.path === alwaysOn) {
			continue;
		}
		if ((ALWAYS_ON_FILES as readonly string[]).includes(entry.path)) {
			plan.leftOut.push({
				path: entry.path,
				reason: "always-on-shadowed",
			});
			continue;
		}
		const place = pluginPathFor(entry.path);
		const rule = projectRulePathFor(entry.path);
		if (place === null && rule === null) {
			plan.leftOut.push({
				path: entry.path,
				reason: reasonFor(entry.path),
			});
		} else if (entry.isText === false) {
			plan.leftOut.push({ path: entry.path, reason: "not-text" });
		} else if (rule !== null) {
			plan.rules.push({ path: entry.path, as: rule });
		} else if (place !== null) {
			plan.carried.push({ path: entry.path, as: place });
		}
	}
	plan.carried.sort(byPath);
	plan.rules.sort(byPath);
	plan.leftOut.sort(byPath);
	return plan;
}
