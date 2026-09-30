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

/**
 * The most bytes of a repository's `.fabricignore` a repository sync reads
 * (design 2026-09-23 §5.3.2 step 6), the same 64 KiB an upload's `begin`
 * accepts. A larger file is dropped and the project's rules apply instead.
 *
 * Shared by the sync activity that reads the blob
 * (`packages/temporal/.../project-instruction-repository-sync.ts`) and the
 * configure dialog's preview of it (`repositorySync.readIgnoreFile`, Fizzy
 * #2726), so the preview never applies a file the sync would drop.
 */
export const MAX_FABRICIGNORE_BYTES = 64 * 1024;

/**
 * `updateSettings`' bounds on a project's own ignore list
 * (`packages/api/.../instructions/update-settings.ts`): at most `maxGlobs`
 * rules of at most `maxGlobLength` characters each. The configure dialog's
 * folder exclusions (Fizzy #2726) refuse a toggle that would break either
 * before anything is sent.
 */
export const PROJECT_IGNORE_GLOB_LIMITS = {
	maxGlobs: 200,
	maxGlobLength: 256,
} as const;

export const DEFAULT_IGNORE_GLOBS: readonly string[] = [
	"**/node_modules/**",
	"**/.playwright-mcp/**",
	"**/tasks/**",
	"**/metrics/**",
	"retro.md",
	"**/*.jsonl",
	"**/.DS_Store",
];

type GlobToken =
	| { kind: "literal"; char: string }
	| { kind: "anyChar" }
	| { kind: "star" }
	| { kind: "doubleStar" }
	// `**/` is the optional group `(?:.*/)?`, as an open token that can skip
	// the group and a body token that loops until the `/` that ends it.
	| { kind: "groupOpen" }
	| { kind: "groupBody" };

export type GlobMatcher = { test(path: string): boolean };

function tokenizeGlob(glob: string): GlobToken[] {
	let g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
	if (g.endsWith("/")) {
		g = `${g}**`;
	}
	const tokens: GlobToken[] = [];
	for (let i = 0; i < g.length; i++) {
		const c = g.charAt(i);
		if (c === "*") {
			if (g.charAt(i + 1) === "*") {
				const slashAfter = g.charAt(i + 2) === "/";
				if (slashAfter) {
					tokens.push({ kind: "groupOpen" }, { kind: "groupBody" });
				} else {
					tokens.push({ kind: "doubleStar" });
				}
				i += slashAfter ? 2 : 1;
			} else {
				tokens.push({ kind: "star" });
			}
		} else if (c === "?") {
			tokens.push({ kind: "anyChar" });
		} else {
			tokens.push({ kind: "literal", char: c });
		}
	}
	return tokens;
}

/**
 * What a RegExp with the `i` flag and no `u` flag compares: the spec's
 * `Canonicalize`, which upper-cases a character unless that changes its
 * length or maps a non-ASCII character into ASCII.
 */
export function foldRegExpCase(char: string): string {
	const upper = char.toUpperCase();
	if (upper.length !== 1) {
		return char;
	}
	if (char.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) {
		return char;
	}
	return upper;
}

/** The characters a regular expression's `.` refuses. */
function isLineTerminator(char: string): boolean {
	return (
		char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029"
	);
}

/**
 * Compiles one glob to a fully anchored, case-insensitive matcher.
 *
 * Exported so `secrets.ts` can express `SECRET_FILE_PATTERNS` in the same
 * syntax the ignore layers use rather than carrying a second, subtly
 * different matcher: two matchers that disagree about what `**` or a
 * trailing `/` means is exactly how a `.env` gets excluded by one rule and
 * missed by the other.
 *
 * Semantics (the ones the former regular-expression translation had, which
 * the equivalence test pins): `\` is read as `/`, a leading `./` is dropped,
 * a trailing `/` means `/**`, `?` is one character other than `/`, `*` is any
 * run of characters other than `/`, `**` is any run of characters, and `**\/`
 * is either nothing or any run of characters ending in a `/`.
 *
 * It is an NFA simulation over the tokens rather than a RegExp, because every
 * `*` became `[^/]*` and a glob such as `*a*a*a*a*a*a*a*a*c` backtracked
 * exponentially on a name that almost matched it. One pass over the path keeps
 * the set of tokens still reachable, so the cost is paths x tokens whatever the
 * glob or the path looks like. A path is caller data (an uploaded or cloned
 * tree), and a glob comes from a user's `.fabricignore`.
 */
export function compileGlob(glob: string): GlobMatcher {
	const tokens = tokenizeGlob(glob);
	const count = tokens.length;
	const folded = tokens.map((token) =>
		token.kind === "literal" ? foldRegExpCase(token.char) : "",
	);
	let current = new Uint8Array(count + 1);
	let next = new Uint8Array(count + 1);

	const closure = (states: Uint8Array) => {
		for (let i = 0; i < count; i++) {
			if (!states[i]) {
				continue;
			}
			const kind = tokens[i]?.kind;
			if (kind === "star" || kind === "doubleStar") {
				states[i + 1] = 1;
			} else if (kind === "groupOpen") {
				states[i + 1] = 1;
				states[i + 2] = 1;
			}
		}
	};

	return {
		test(path) {
			current.fill(0);
			current[0] = 1;
			closure(current);
			for (let p = 0; p < path.length; p++) {
				const char = path.charAt(p);
				const foldedChar = foldRegExpCase(char);
				const dotMatches = !isLineTerminator(char);
				next.fill(0);
				let any = false;
				for (let i = 0; i < count; i++) {
					if (!current[i]) {
						continue;
					}
					const token = tokens[i];
					if (!token) {
						continue;
					}
					switch (token.kind) {
						case "literal":
							if (folded[i] === foldedChar) {
								next[i + 1] = 1;
								any = true;
							}
							break;
						case "anyChar":
							if (char !== "/") {
								next[i + 1] = 1;
								any = true;
							}
							break;
						case "star":
							if (char !== "/") {
								next[i] = 1;
								any = true;
							}
							break;
						case "doubleStar":
							if (dotMatches) {
								next[i] = 1;
								any = true;
							}
							break;
						case "groupOpen":
							break;
						case "groupBody":
							if (dotMatches) {
								next[i] = 1;
								any = true;
							}
							if (char === "/") {
								next[i + 1] = 1;
								any = true;
							}
							break;
						default: {
							const unreachable: never = token;
							return unreachable;
						}
					}
				}
				if (!any) {
					return false;
				}
				closure(next);
				[current, next] = [next, current];
			}
			return current[count] === 1;
		},
	};
}

export function compileIgnore(
	globs: readonly string[],
	layers?: readonly IgnoreLayer[],
): (path: string) => IgnoreMatch | null {
	const compiled = globs.map((rule, i) => ({
		rule,
		matcher: compileGlob(rule),
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
			if (c.matcher.test(key)) {
				return { rule: c.rule, layer: c.layer };
			}
		}
		return null;
	};
}

export type FabricIgnoreDecoding = { ok: true; text: string } | { ok: false };

/**
 * The one way a root `.fabricignore`'s bytes become rules' text, for every
 * surface that reads them: the browser preview that freezes the rules
 * (`read-folder.ts`), the repository sync that freezes them from a blob, and
 * the gate that re-parses the STORED bytes and compares.
 *
 * Strict on purpose. Each of those decoded leniently and differently (the
 * browser replaced invalid bytes, the sync kept a byte-order mark, the gate
 * fell back to Latin-1), so a file that was not valid UTF-8 froze one set of
 * rules and re-parsed to another, and the upload was refused as
 * `ignore_mismatch` — a reason that blames the wrong thing. Here a file is
 * text only if it is valid UTF-8 with no NUL byte (UTF-16 and UTF-32 fail on
 * one or the other), and a leading byte-order mark is dropped. A caller that
 * gets `ok: false` freezes no rules from the file, and the gate rejects the
 * stored file with `ignore_encoding`.
 */
export function decodeFabricIgnore(bytes: Uint8Array): FabricIgnoreDecoding {
	if (bytes.includes(0)) {
		return { ok: false };
	}
	try {
		return {
			ok: true,
			text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
		};
	} catch {
		return { ok: false };
	}
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
