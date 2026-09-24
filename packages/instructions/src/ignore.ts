import { canonicalKey } from "./kinds";

export type IgnoreLayer = "always" | "fabricignore" | "project" | "default";
export type IgnoreMatch = { rule: string; layer: IgnoreLayer };

/**
 * The built-in rules are `**\/`-prefixed so they match a directory of that
 * name at ANY depth, unlike a user-authored `.fabricignore` line, which stays
 * root-anchored (R6). The two are not the same kind of rule: a `.fabricignore`
 * line is a statement about one tree the author can see, while these describe
 * a directory whose meaning is the same wherever it appears —
 * `apps/web/node_modules/`, a vendored `submodule/.git/`, or a nested
 * `tasks/`. Root-anchoring them silently narrowed the built-in list to the
 * top level, which mattered most for `.git`: a nested `.git/config` can carry
 * a credentialed remote URL.
 *
 * `retro.md`, `.claude/settings.local.json`, and `.codex/hooks.json` stay
 * root-anchored: they name one specific file at the top of a repository, not
 * a category of path, and a `docs/retro.md` is ordinary content. The two hook
 * paths are unconditional exclusions because `init` owns them locally.
 *
 * `.guild/` is Guild's local state folder (spec §5.8): it never holds
 * instructions, and it stays root-anchored like the hook paths because it
 * names one folder at the top of a tree.
 *
 * `.fabric/` is the CLI's own state: `fabric instructions sync` keeps its
 * ledger at `.fabric/instructions.lock` inside the checkout, and the CLI
 * refuses a published bundle that names anything under `.fabric` (its
 * reserved root, `packages/cli/src/lib/instructions/paths.ts`). A repository
 * that commits the lock, which any team syncing into the repository they
 * publish from will do, must therefore never have it published, or every
 * later `sync` refuses the whole bundle (Fizzy #2704). Root-anchored, like
 * `.guild/`.
 *
 * The bare `.fabric` and `.git` entries cover a root FILE of that name: the
 * CLI reserves the first path segment, so a file called `.git` (what a git
 * worktree or submodule checkout has at its root) or `.fabric` is refused
 * there too, and `x/**` never matches a path with no slash.
 *
 * `**\/CLAUDE.local.md` is the odd one out among the file-specific rules: it
 * is deliberately NOT root-anchored, unlike the two hook files and
 * `.guild/`. Claude Code reads `CLAUDE.local.md` as machine-personal notes in
 * ANY directory it walks, not only the repository root, so a nested
 * `packages/web/CLAUDE.local.md` is just as personal to one machine as the
 * root one and must be excluded at every depth, the same way `.git/` is.
 */
export const ALWAYS_IGNORE_GLOBS: readonly string[] = [
	"**/.git/**",
	".git",
	".claude/settings.local.json",
	".codex/hooks.json",
	".fabric",
	".fabric/**",
	".guild/**",
	"**/CLAUDE.local.md",
];

/**
 * The one path whose CONTENT decides an upload's exclusion rules.
 *
 * Named here rather than spelled out at each site because three of them have
 * to agree exactly: the browser preview that reads the file
 * (`apps/web/modules/saas/projects/lib/read-folder.ts`), the procedure that
 * freezes the parsed rules into the snapshot
 * (`packages/api/.../instructions/begin-snapshot.ts`), and the verify
 * activity that checks the STORED bytes still parse to those frozen rules
 * (`packages/temporal/src/activities/project-instructions.ts`). A typo in any
 * one of them turns that last check into a silent pass.
 *
 * Root-anchored and exact: a nested `docs/.fabricignore` is ordinary content,
 * for the same reason `retro.md` above stays root-anchored.
 */
export const FABRIC_IGNORE_FILE = ".fabricignore";

export const DEFAULT_IGNORE_GLOBS: readonly string[] = [
	"**/node_modules/**",
	"**/.playwright-mcp/**",
	"**/tasks/**",
	"**/metrics/**",
	"retro.md",
	"**/*.jsonl",
	"**/.DS_Store",
];

const REGEXP_ESCAPE_CHARS = new Set([
	".",
	"+",
	"^",
	"$",
	"{",
	"}",
	"(",
	")",
	"|",
	"[",
	"]",
	"\\",
]);

/**
 * Compiles one glob to a fully anchored, case-insensitive RegExp.
 *
 * Exported so `secrets.ts` can express `SECRET_FILE_PATTERNS` in the same
 * syntax the ignore layers use rather than carrying a second, subtly
 * different matcher: two matchers that disagree about what `**` or a
 * trailing `/` means is exactly how a `.env` gets excluded by one rule and
 * missed by the other.
 */
export function globToRegExp(glob: string): RegExp {
	let g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
	if (g.endsWith("/")) {
		g = `${g}**`;
	}
	let re = "";
	for (let i = 0; i < g.length; i++) {
		const c = g.charAt(i);
		if (c === "*") {
			if (g.charAt(i + 1) === "*") {
				const slashAfter = g.charAt(i + 2) === "/";
				re += slashAfter ? "(?:.*/)?" : ".*";
				i += slashAfter ? 2 : 1;
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else if (REGEXP_ESCAPE_CHARS.has(c)) {
			re += `\\${c}`;
		} else {
			re += c;
		}
	}
	// Always fully anchor: a bare name with no slash and no `**` must match
	// only at the root, never at an arbitrary depth. A leading `**/` already
	// supplies its own "any depth" prefix via the `(?:.*/)?` substitution above.
	return new RegExp(`^${re}$`, "i");
}

export function compileIgnore(
	globs: readonly string[],
	layers?: readonly IgnoreLayer[],
): (path: string) => IgnoreMatch | null {
	const compiled = globs.map((rule, i) => ({
		rule,
		re: globToRegExp(rule),
		layer:
			layers?.[i] ??
			(ALWAYS_IGNORE_GLOBS.includes(rule)
				? "always"
				: DEFAULT_IGNORE_GLOBS.includes(rule)
					? "default"
					: "project"),
	}));
	return (path) => {
		const key = canonicalKey(path);
		for (const c of compiled) {
			if (c.re.test(key)) {
				return { rule: c.rule, layer: c.layer };
			}
		}
		return null;
	};
}

export function parseFabricIgnore(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(
			(l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("!"),
		);
}

export function resolveIgnoreGlobs(input: {
	fabricIgnoreText?: string | null;
	projectGlobs?: readonly string[] | null;
}): { globs: string[]; layer: "fabricignore" | "project" | "default" } {
	const fromFile = input.fabricIgnoreText
		? parseFabricIgnore(input.fabricIgnoreText)
		: [];
	if (fromFile.length > 0) {
		return { globs: fromFile, layer: "fabricignore" };
	}
	// PRESENCE, not length. `null`/`undefined` means the project has no ignore
	// setting at all, which is what the default list is for. An empty ARRAY is
	// a setting: `updateSettings` accepts `[]`
	// (`packages/api/.../instructions/update-settings.ts`) and the settings
	// dialog states in so many words that clearing the box means a project
	// list that excludes nothing. Treating the two the same handed an API
	// client that had explicitly asked for no exclusions the full default set
	// instead — and froze `layer: "default"` into the snapshot's
	// `settingsFrozen`, so the tab then explained the exclusions with a rule
	// the project had switched off.
	if (input.projectGlobs) {
		return { globs: [...input.projectGlobs], layer: "project" };
	}
	return { globs: [...DEFAULT_IGNORE_GLOBS], layer: "default" };
}

/** The matcher every caller should build: always-rules first, then the resolved layer. */
export function buildIgnoreMatcher(
	resolved: ReturnType<typeof resolveIgnoreGlobs>,
) {
	const globs = [...ALWAYS_IGNORE_GLOBS, ...resolved.globs];
	const layers: IgnoreLayer[] = [
		...ALWAYS_IGNORE_GLOBS.map(() => "always" as const),
		...resolved.globs.map(() => resolved.layer),
	];
	return compileIgnore(globs, layers);
}
