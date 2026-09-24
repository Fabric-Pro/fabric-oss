/**
 * Which files of a repository the Living Memory sync may apply, and the key
 * each is stored under (design 2026-09-23 §2, §5.3.1 steps 5–7, Fizzy #2657).
 * Pure: no I/O, no clock.
 *
 * The server's twin of `fabric context push`'s rules. The CLI keeps its copy
 * (`packages/cli/src/lib/context-sync/ignore.ts`, `classify.ts`, and the
 * path checks in `plan.ts`), and `configure` keeps the default exclusions in
 * `packages/api/modules/projects/procedures/contexts/repository-sync/paths.ts`.
 * The three must agree: a file the CLI would push and the sync would not (or
 * the reverse) is a file that flips between two owners. Change all three
 * together; `context-sync-rules.test.ts` carries the CLI's cases.
 *
 * Paths here are git's: repository-relative, `/`-separated, exact bytes. The
 * rules of one selected folder F are matched against the path RELATIVE to F,
 * as the CLI matches paths relative to the folder it pushes. What the sync
 * stores and compares is the storage key (`normalizeContextSourcePath` of the
 * repository path), so protection is expressed in storage-key coordinates.
 */
import path from "node:path";
import {
	ContextSourcePathError,
	normalizeContextSourcePath,
} from "@repo/database";
import ignore from "ignore";

type Ignore = ReturnType<typeof ignore>;

export const CONTEXT_IGNORE_FILENAME = ".contextignore";

/**
 * `fabric context push`'s default exclusions, never overridable by a
 * `.contextignore`: version-control and tool state, and every
 * coding-instruction file or folder at any depth (instructions have their
 * own reviewed path into a project). Twins:
 * `packages/cli/src/lib/context-sync/ignore.ts` (DEFAULT_CONTEXT_IGNORE_PATTERNS)
 * and `packages/api/modules/projects/procedures/contexts/repository-sync/paths.ts`.
 * Change all three together.
 */
export const DEFAULT_CONTEXT_IGNORE_PATTERNS: readonly string[] = [
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

/** A selected folder's `.contextignore` counts only up to this size (§5.3.1 step 6). */
export const MAX_CONTEXT_IGNORE_BYTES = 64 * 1024;

/**
 * The ceiling on one synced file: the CLI's `MAX_CONTEXT_FILE_BYTES` and the
 * API's `MAX_SYNCED_CONTEXT_BYTES`.
 */
export const MAX_CONTEXT_FILE_BYTES = 2 * 1024 * 1024;

/** Compared lower-cased, so `README.MD` is text too. */
const CONTEXT_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
	".md",
	".markdown",
	".txt",
	".json",
	".yaml",
	".yml",
]);

export interface ContextIgnoreRules {
	/** Is this file (relative to the folder, `/`-separated) left out? */
	ignoresFile(relativePath: string): boolean;
	/** Is this directory left out, with everything beneath it? */
	ignoresDirectory(relativePath: string): boolean;
}

/**
 * The CLI's `buildContextIgnoreRules`, minus `--exclude` (a sync has only
 * the folder's `.contextignore`). Two matchers rather than one pattern list,
 * so a user's `!CLAUDE.md` cannot re-include what the defaults exclude.
 * Case-insensitive (the package's default), gitignore semantics, and a file
 * under an ignored directory is ignored with it, which is what makes one
 * flat inventory match the CLI's walk (which never descends into one).
 *
 * The matcher THROWS for a path it cannot evaluate (empty, `./`-prefixed);
 * `matchContextEntry` turns that into `unmatchable`.
 */
export function buildContextIgnoreRules(
	input: { contextIgnore?: string | null } = {},
): ContextIgnoreRules {
	const defaults: Ignore = ignore().add([...DEFAULT_CONTEXT_IGNORE_PATTERNS]);
	const user: Ignore = ignore();
	if (input.contextIgnore) {
		user.add(input.contextIgnore);
	}
	const ignores = (candidate: string) =>
		defaults.ignores(candidate) || user.ignores(candidate);
	return {
		ignoresFile: (relativePath) => ignores(relativePath),
		// The trailing slash is what makes a directory-only pattern
		// (`drafts/`) match.
		ignoresDirectory: (relativePath) => ignores(`${relativePath}/`),
	};
}

/** Git tree entry modes (`git ls-tree`). */
const GIT_REGULAR_FILE_MODES: ReadonlySet<string> = new Set([
	"100644",
	"100755",
]);

/**
 * A regular blob: the only entry the sync reads. A symlink (`120000`) or a
 * submodule (`160000`) is never followed and never read (§2 "regular files
 * only"); a folder's `.contextignore` that is not a regular file is a policy
 * failure, not an empty policy (§5.3.1 step 6).
 */
export function isRegularFileMode(mode: string): boolean {
	return GIT_REGULAR_FILE_MODES.has(mode);
}

export type ContextEntryMatch = "kept" | "ignored" | "unmatchable";

/**
 * One inventory entry against its folder's rules, matched the way the CLI's
 * walk matches it (`packages/cli/src/lib/context-sync/walk.ts`): a regular
 * file as a file; a link or a submodule — which a walk would see as a link
 * or a directory, and never follow — as a file OR a directory, so
 * `node_modules -> ../x` is the ignored directory rather than a stray link.
 * A path the matcher cannot evaluate is `unmatchable` (attention
 * `invalid-path`), as the CLI reports it.
 */
export function matchContextEntry(
	rules: ContextIgnoreRules,
	relativePath: string,
	mode: string,
): ContextEntryMatch {
	try {
		const ignored = isRegularFileMode(mode)
			? rules.ignoresFile(relativePath)
			: rules.ignoresFile(relativePath) ||
				rules.ignoresDirectory(relativePath);
		return ignored ? "ignored" : "kept";
	} catch {
		return "unmatchable";
	}
}

export function hasTextExtension(relativePath: string): boolean {
	return CONTEXT_TEXT_EXTENSIONS.has(
		path.posix.extname(relativePath).toLowerCase(),
	);
}

const HAS_NON_WHITESPACE = /\S/;

/**
 * The file's text, or why it is not text the sync may store — the CLI's
 * `classifyContextBytes`, reason for reason. `fatal: true` makes "decodes as
 * UTF-8" mean something (the default decoder substitutes U+FFFD silently),
 * and `ignoreBOM: true` keeps a byte-order mark in the string, so the hash
 * of the stored content is the hash of the bytes in the repository.
 */
export function classifyContextBytes(
	bytes: Uint8Array,
):
	| { ok: true; content: string }
	| { ok: false; reason: "binary" | "empty" | "too-large" } {
	if (bytes.byteLength > MAX_CONTEXT_FILE_BYTES) {
		return { ok: false, reason: "too-large" };
	}
	let content: string;
	try {
		content = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: true,
		}).decode(bytes);
	} catch {
		return { ok: false, reason: "binary" };
	}
	// Valid UTF-8 can still hold U+0000, which Postgres `text` cannot store.
	if (content.includes("\u0000")) {
		return { ok: false, reason: "binary" };
	}
	// Nothing but whitespace (a lone BOM counts as whitespace to `\s`).
	if (!HAS_NON_WHITESPACE.test(content)) {
		return { ok: false, reason: "empty" };
	}
	return { ok: true, content };
}

export type ContextStorageKeyResult =
	| { ok: true; storageKey: string }
	| {
			ok: false;
			reason: "invalid-path";
			/** The server's reason word, or `backslash`. Never the path. */
			detail: ContextSourcePathError["reason"] | "backslash";
	  };

/**
 * The key a repository path is stored under (§2, §5.3.1 step 5):
 * `normalizeContextSourcePath` of the path. A backslash is refused BEFORE
 * normalising, as the CLI's planner refuses it: inside a POSIX file name it
 * is not a separator, and the normaliser would read it as one, storing the
 * file under a path that names something else.
 */
export function contextStorageKey(
	repositoryPath: string,
): ContextStorageKeyResult {
	if (repositoryPath.includes("\\")) {
		return { ok: false, reason: "invalid-path", detail: "backslash" };
	}
	try {
		return {
			ok: true,
			storageKey: normalizeContextSourcePath(repositoryPath),
		};
	} catch (error) {
		if (error instanceof ContextSourcePathError) {
			return { ok: false, reason: "invalid-path", detail: error.reason };
		}
		throw error;
	}
}

/**
 * The path of `repositoryPath` relative to the selected folder, or `null`
 * when it is not strictly inside it. `""` is the whole repository. Whole
 * segments only: `docs` contains `docs/a.md`, never `docs-archive/a.md`.
 */
export function relativeToSelectedFolder(
	selectedFolder: string,
	repositoryPath: string,
): string | null {
	if (selectedFolder === "") {
		return repositoryPath === "" ? null : repositoryPath;
	}
	const prefix = `${selectedFolder}/`;
	if (
		!repositoryPath.startsWith(prefix) ||
		repositoryPath.length === prefix.length
	) {
		return null;
	}
	return repositoryPath.slice(prefix.length);
}

/**
 * The storage-key prefix a selected folder protects when its ignore policy
 * cannot be evaluated (§5.3.1 step 6): nothing under it is written, and no
 * managed row under it is pruned. `""` — the whole repository — means EVERY
 * managed row of the sync; any other folder F means the keys under `F/`.
 * Selected paths are canonical (`configure` requires
 * `normalizeContextSourcePath(F) === F`), so F is its own storage key.
 */
export function protectedPrefixFor(selectedFolder: string): string {
	return selectedFolder === "" ? "" : `${selectedFolder}/`;
}

/** Is a storage key under any of these protected prefixes? `""` covers every key. */
export function isUnderProtectedPrefix(
	storageKey: string,
	prefixes: readonly string[],
): boolean {
	return prefixes.some(
		(prefix) => prefix === "" || storageKey.startsWith(prefix),
	);
}

/** The default exclusions that can match a file name, lower-cased. */
const EXCLUDED_FILE_NAMES: ReadonlySet<string> = new Set(
	DEFAULT_CONTEXT_IGNORE_PATTERNS.filter((p) => !p.endsWith("/")).map((p) =>
		p.toLowerCase(),
	),
);

const FABRIC_DIRECTORY = ".fabric";

/**
 * `repositoryPath` has a `.fabric` segment, at any depth and in any case:
 * the CLI's own state, which the sync never applies (Fizzy #2704), as
 * `configure` refuses it (`paths.ts`). Needed beyond the `.fabric/` default
 * because that pattern is matched relative to a selected folder, and so
 * cannot see a `.fabric` that is, or is above, the selection itself.
 */
export function isInFabricDirectory(repositoryPath: string): boolean {
	return repositoryPath
		.split("/")
		.some((segment) => segment.toLowerCase() === FABRIC_DIRECTORY);
}

/**
 * A directly selected FILE is judged by its basename against the default
 * exclusions (§5.3.1 step 6), exactly as `configure` judges it (`paths.ts`):
 * `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` and `.contextignore`, any case, are
 * excluded; a directly selected `skills/x.md` is not — the folder patterns
 * apply only inside a selected folder, relative to it. The one exception is
 * `.fabric`: a file with a `.fabric` segment anywhere in its path is
 * excluded too, so a configuration stored before `configure` refused one
 * fails closed.
 */
export function isExcludedDirectlySelectedFile(
	repositoryPath: string,
): boolean {
	if (isInFabricDirectory(repositoryPath)) {
		return true;
	}
	const slash = repositoryPath.lastIndexOf("/");
	const basename =
		slash === -1 ? repositoryPath : repositoryPath.slice(slash + 1);
	return EXCLUDED_FILE_NAMES.has(basename.toLowerCase());
}
