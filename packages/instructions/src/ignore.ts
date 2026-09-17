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
 * `retro.md` and `.claude/settings.local.json` deliberately stay
 * root-anchored: they name one specific file at the top of a repository, not
 * a category of path, and a `docs/retro.md` is ordinary content.
 */
export const ALWAYS_IGNORE_GLOBS: readonly string[] = ["**/.git/**"];

export const DEFAULT_IGNORE_GLOBS: readonly string[] = [
	"**/node_modules/**",
	"**/.playwright-mcp/**",
	"**/tasks/**",
	"**/metrics/**",
	"retro.md",
	"**/*.jsonl",
	".claude/settings.local.json",
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
