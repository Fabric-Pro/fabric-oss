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
 * The one exception is `.fabric`, the CLI's own state (Fizzy #2704): a path
 * with a `.fabric` segment at any depth, in any case, is refused whatever
 * it names, since inside a selected `.fabric` folder the defaults, applied
 * relative to it, would no longer see it.
 *
 * Every per-path rule lives in `contextSyncPathSelectable`, which `listTree`
 * applies to each tree entry, so the tree never offers what this refuses.
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

const FABRIC_DIRECTORY = ".fabric";

/** The patterns that can match a file (no trailing slash), lower-cased. */
const EXCLUDED_FILE_NAMES: ReadonlySet<string> = new Set(
	DEFAULT_CONTEXT_IGNORE_PATTERNS.filter((p) => !p.endsWith("/")).map((p) =>
		p.toLowerCase(),
	),
);

/**
 * The longest path `configure` accepts: its input schema's bound, applied
 * here too so `listTree` never offers a path `configure` would refuse.
 */
export const MAX_CONTEXT_SYNC_PATH_LENGTH = 1024;

type ContextSyncPathsError =
	| { code: "INVALID_PATH"; path: string; message: string }
	| { code: "EXCLUDED_PATH"; path: string; message: string }
	| { code: "TOO_MANY_PATHS"; message: string }
	| { code: "PATH_PREFIX_OVERLAP"; path: string; message: string };

export type ContextSyncPathsResult =
	| { ok: true; paths: string[] }
	| ({ ok: false } & ContextSyncPathsError);

/** `path` is in the canonical spelling `configure` accepts (file comment). */
function isCanonicalContextSyncPath(path: string): boolean {
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

/**
 * `path` names a coding-instructions file the defaults always exclude, by
 * its basename (the one file rule `configure` applies).
 */
function isExcludedContextSyncFile(path: string): boolean {
	return EXCLUDED_FILE_NAMES.has(basename(path).toLowerCase());
}

/**
 * `path` is the `.fabric` directory or lies under it, at any depth and in
 * any case, as the `.fabric/` default exclusion matches: the CLI's own
 * state, which a run never syncs (Fizzy #2704).
 */
function isInFabricDirectory(path: string): boolean {
	return path
		.split("/")
		.some((segment) => segment.toLowerCase() === FABRIC_DIRECTORY);
}

export type ContextSyncPathVerdict =
	| { ok: true }
	| { ok: false; code: "INVALID_PATH" | "EXCLUDED_PATH"; message: string };

/**
 * Whether one path may be selected, on its own (file comment): at most
 * `MAX_CONTEXT_SYNC_PATH_LENGTH` characters, in the canonical spelling, no
 * `.fabric` segment, and no basename a default exclusion names. `""` (the
 * whole repository) is selectable; whether it may stand with others is
 * `canonicalizeContextSyncPaths`'s rule, not this one. The one per-path
 * rule set for both `configure` and `listTree`.
 */
export function contextSyncPathSelectable(
	path: string,
): ContextSyncPathVerdict {
	if (path === "") {
		return { ok: true };
	}
	if (path.length > MAX_CONTEXT_SYNC_PATH_LENGTH) {
		return {
			ok: false,
			code: "INVALID_PATH",
			message: `A path is at most ${MAX_CONTEXT_SYNC_PATH_LENGTH} characters long.`,
		};
	}
	if (!isCanonicalContextSyncPath(path)) {
		return {
			ok: false,
			code: "INVALID_PATH",
			message: `"${path}" is not a repository path in its plain form: use '/' between folders, with no leading './' or '/', no trailing '/', no '.' or '..' segments and no surrounding spaces.`,
		};
	}
	if (isInFabricDirectory(path)) {
		return {
			ok: false,
			code: "EXCLUDED_PATH",
			message: `"${path}" is in a .fabric folder, the Fabric CLI's own state, which Living Memory never syncs.`,
		};
	}
	if (isExcludedContextSyncFile(path)) {
		return {
			ok: false,
			code: "EXCLUDED_PATH",
			message: `"${path}" is a coding-instructions file, which Living Memory never syncs; manage it with coding instructions instead.`,
		};
	}
	return { ok: true };
}

/** `a` is `b`'s ancestor (or equal), by whole segments. */
function isSegmentPrefix(a: string, b: string): boolean {
	return a === "" || b === a || b.startsWith(`${a}/`);
}

export function canonicalizeContextSyncPaths(
	raw: readonly string[],
): ContextSyncPathsResult {
	for (const path of raw) {
		const verdict = contextSyncPathSelectable(path);
		if (!verdict.ok) {
			return {
				ok: false,
				code: verdict.code,
				path,
				message: verdict.message,
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
