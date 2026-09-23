/**
 * Which paths under the pushed folder are never candidates at all.
 *
 * Two layers, matched with gitignore semantics by the `ignore` package:
 *
 *  1. DEFAULTS, always applied and never overridable. Version-control and
 *     tool state (`.git/`, `.fabric/` — where the lock lives —
 *     `node_modules/`), and every coding-instruction file or folder
 *     (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/`, `.cursor/`,
 *     `.codex/`, and directories named `skills`, `agents`, `hooks`, `rules`
 *     or `scripts` at any depth). Instructions have their own reviewed path
 *     into a project — `fabric instructions push` — and pushing them into
 *     Context as well would make the same text answer from two places, one
 *     of them unreviewed.
 *  2. The USER's: `<dir>/.contextignore` if present, then each `--exclude`.
 *
 * Kept as two matchers rather than one pattern list, because in one list a
 * user's `!CLAUDE.md` would re-include what the defaults exclude. A path the
 * defaults exclude is excluded whatever the user's rules say.
 *
 * Matching is case-insensitive (the package's default), so `claude.md` and
 * `Skills/` are excluded too.
 */
import ignore from "ignore";

type Ignore = ReturnType<typeof ignore>;

export const CONTEXT_IGNORE_FILENAME = ".contextignore";

const DEFAULT_CONTEXT_IGNORE_PATTERNS: readonly string[] = [
	".git/",
	".fabric/",
	".claude/",
	".cursor/",
	".codex/",
	"node_modules/",
	"CLAUDE.md",
	"AGENTS.md",
	"GEMINI.md",
	"skills/",
	"agents/",
	"hooks/",
	"rules/",
	"scripts/",
	CONTEXT_IGNORE_FILENAME,
];

export interface ContextIgnoreRules {
	/** Is this file (relative, `/`-separated) left out? */
	ignoresFile(relativePath: string): boolean;
	/** Is this directory left out, and so not walked into? */
	ignoresDirectory(relativePath: string): boolean;
}

export function buildContextIgnoreRules(
	input: { contextIgnore?: string | null; excludes?: readonly string[] } = {},
): ContextIgnoreRules {
	const defaults: Ignore = ignore().add([...DEFAULT_CONTEXT_IGNORE_PATTERNS]);
	const user: Ignore = ignore();
	if (input.contextIgnore) {
		user.add(input.contextIgnore);
	}
	if (input.excludes && input.excludes.length > 0) {
		user.add([...input.excludes]);
	}
	const ignores = (candidate: string) =>
		defaults.ignores(candidate) || user.ignores(candidate);
	return {
		ignoresFile: (relativePath) => ignores(relativePath),
		// The trailing slash is what makes a directory-only pattern
		// (`drafts/`) match: gitignore semantics, as the package implements
		// them.
		ignoresDirectory: (relativePath) => ignores(`${relativePath}/`),
	};
}
