/**
 * The selected paths of a Living Memory repository sync, as `configure`
 * accepts them (design 2026-09-23 §2, §5.1). Pure.
 *
 * Each path is a repository-relative POSIX path naming a folder or a file,
 * and must already be in its canonical spelling — the storage key the sync
 * would derive for it — so what the member typed is exactly what is stored
 * and compared: no surrounding whitespace, no backslash, no trailing slash,
 * and `normalizeContextSourcePath(p) === p` (so no `./`, `//`, `.`/`..`
 * segment, leading `/`, control character, or non-NFC spelling). `""`
 * selects the whole repository and is allowed only alone.
 *
 * A path is not known to be a folder or a file until a run reads the tree,
 * so the one file rule applied here is the one the run applies to a
 * directly selected file (§5.3.1 step 6): its BASENAME against the default
 * exclusions. Of those, only the file patterns can match a basename —
 * `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.contextignore`, case-insensitive
 * — so a coding-instructions file is refused here, while a folder selection
 * (`skills`, `.claude`, `docs/agents`) is not: the run applies the defaults
 * inside a selected folder, relative to it, as `fabric context push` does.
 *
 * The rest: duplicates dropped, sorted, at most 50, and none a prefix of
 * another by whole segments (`docs` and `docs/guides` overlap; `docs` and
 * `docs-archive` do not).
 */
import {
	ContextSourcePathError,
	normalizeContextSourcePath,
} from "@repo/database";

const MAX_CONTEXT_SYNC_PATHS = 50;

/**
 * The default exclusions of `fabric context push`
 * (`packages/cli/src/lib/context-sync/ignore.ts`). The CLI keeps its copy and
 * the sync's activity keeps a twin; change all three together.
 */
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
	".contextignore",
];

/** The patterns that can match a file (no trailing slash), lower-cased. */
const EXCLUDED_FILE_NAMES: ReadonlySet<string> = new Set(
	DEFAULT_CONTEXT_IGNORE_PATTERNS.filter((p) => !p.endsWith("/")).map((p) =>
		p.toLowerCase(),
	),
);

type ContextSyncPathsError =
	| { code: "INVALID_PATH"; path: string; message: string }
	| { code: "EXCLUDED_PATH"; path: string; message: string }
	| { code: "TOO_MANY_PATHS"; message: string }
	| { code: "PATH_PREFIX_OVERLAP"; path: string; message: string };

export type ContextSyncPathsResult =
	| { ok: true; paths: string[] }
	| ({ ok: false } & ContextSyncPathsError);

function isCanonical(path: string): boolean {
	if (path.trim() !== path || path.includes("\\") || path.endsWith("/")) {
		return false;
	}
	try {
		return normalizeContextSourcePath(path) === path;
	} catch (error) {
		if (error instanceof ContextSourcePathError) {
			return false;
		}
		throw error;
	}
}

function basename(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? path : path.slice(slash + 1);
}

/** `a` is `b`'s ancestor (or equal), by whole segments. */
function isSegmentPrefix(a: string, b: string): boolean {
	return a === "" || b === a || b.startsWith(`${a}/`);
}

export function canonicalizeContextSyncPaths(
	raw: readonly string[],
): ContextSyncPathsResult {
	for (const path of raw) {
		if (path === "") {
			continue;
		}
		if (!isCanonical(path)) {
			return {
				ok: false,
				code: "INVALID_PATH",
				path,
				message: `"${path}" is not a repository path in its plain form: use '/' between folders, with no leading './' or '/', no trailing '/', no '.' or '..' segments and no surrounding spaces.`,
			};
		}
		if (EXCLUDED_FILE_NAMES.has(basename(path).toLowerCase())) {
			return {
				ok: false,
				code: "EXCLUDED_PATH",
				path,
				message: `"${path}" is a coding-instructions file, which Living Memory never syncs; manage it with coding instructions instead.`,
			};
		}
	}

	const paths = [...new Set(raw)].sort();
	if (paths.length > MAX_CONTEXT_SYNC_PATHS) {
		return {
			ok: false,
			code: "TOO_MANY_PATHS",
			message: `Select at most ${MAX_CONTEXT_SYNC_PATHS} folders or files.`,
		};
	}
	if (paths.length > 1 && paths.includes("")) {
		return {
			ok: false,
			code: "PATH_PREFIX_OVERLAP",
			path: "",
			message:
				"The whole repository is already selected; remove the other paths or select folders instead.",
		};
	}
	// Sorted, so an ancestor sorts before every path under it; checking each
	// path against every earlier one keeps this exact for the at most 50.
	for (let i = 0; i < paths.length; i++) {
		for (let j = 0; j < i; j++) {
			const [ancestor, path] = [paths[j] as string, paths[i] as string];
			if (isSegmentPrefix(ancestor, path)) {
				return {
					ok: false,
					code: "PATH_PREFIX_OVERLAP",
					path,
					message: `"${path}" is inside "${ancestor}", which is already selected.`,
				};
			}
		}
	}
	return { ok: true, paths };
}
