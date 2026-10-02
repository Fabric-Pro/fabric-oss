/**
 * Which files of a repository the Living Memory sync may apply, and the key
 * each is stored under (design 2026-09-23 §2, §5.3.1 steps 5–7, Fizzy #2657).
 * Pure: no I/O, no clock.
 *
 * The default exclusions, the text extensions, `.fabric`, the policy
 * filename and the two ways the defaults apply (a directly selected file by
 * its basename, a file inside a selected folder relative to it) come from
 * the one canonical module, `@repo/instructions/context-sync-rules`, which
 * `configure` imports too (Fizzy #2750 §7). The published CLI keeps its own
 * copy, pinned to that module by its parity test. What stays here is the
 * run's own: the folder's `.contextignore` layered over the defaults, git
 * modes, byte classification, storage keys and protected prefixes.
 *
 * Paths here are git's: repository-relative, `/`-separated, exact bytes. The
 * rules of one selected folder F are matched against the path RELATIVE to F,
 * as the CLI matches paths relative to the folder it pushes. What the sync
 * stores and compares is the storage key (`normalizeContextSourcePath` of the
 * repository path), so protection is expressed in storage-key coordinates.
 */

import {
	ContextSourcePathError,
	normalizeContextSourcePath,
} from "@repo/database";
// The constant from its pure module, not the package entry: a test that replaces
// the entry with a few exports still gets the real bound.
import { MAX_CONTEXT_SOURCE_PATH_LENGTH } from "@repo/database/prisma/queries/projects/context-source-path";
import {
	CONTEXT_IGNORE_FILENAME,
	createContextDefaultRules,
	findContextIgnoreProblem,
	hasContextTextExtension,
	isExcludedDirectlySelectedFile,
	isInContextSyncFabricDirectory,
} from "@repo/instructions/context-sync-rules";
import ignore from "ignore";

type Ignore = ReturnType<typeof ignore>;

export { CONTEXT_IGNORE_FILENAME, isExcludedDirectlySelectedFile };

/** A selected folder's `.contextignore` counts only up to this size (§5.3.1 step 6). */
export const MAX_CONTEXT_IGNORE_BYTES = 64 * 1024;

/**
 * The ceiling on one synced file: the CLI's `MAX_CONTEXT_FILE_BYTES` and the
 * API's `MAX_SYNCED_CONTEXT_BYTES`.
 */
export const MAX_CONTEXT_FILE_BYTES = 2 * 1024 * 1024;

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
	const defaults = createContextDefaultRules();
	const user: Ignore = ignore();
	if (input.contextIgnore) {
		// The run refuses such a file before it gets here (`readIgnorePolicies`);
		// this keeps the matcher from ever being handed one, whoever calls.
		const problem = findContextIgnoreProblem(input.contextIgnore);
		if (problem) {
			throw new Error(
				`.contextignore line ${problem.line} has ${problem.groups} \`**\` groups; at most ${problem.max} can be evaluated`,
			);
		}
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
	// A path the sync could never store is never handed to the matcher: its
	// time grows with a path's depth, and this bounds it by what a sync can
	// hold. But a rule that leaves out a FOLDER leaves out everything beneath
	// it, however deep, so the folder prefixes that fit are judged first
	// (shortest first, so the cost is bounded by the cap): a long path inside
	// `node_modules/` is ignored, as the CLI's walk, which never descends
	// there, would leave it. Otherwise it is `unmatchable`
	// (attention `invalid-path`), which is what a path no key can hold is.
	if (relativePath.length > MAX_CONTEXT_SOURCE_PATH_LENGTH) {
		return ancestorDirectoryIsIgnored(rules, relativePath)
			? "ignored"
			: "unmatchable";
	}
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

/**
 * Whether a folder above a path too long to store is left out by the rules.
 * Only prefixes within the storable length are judged, so the matcher never
 * sees a path over the cap.
 */
function ancestorDirectoryIsIgnored(
	rules: ContextIgnoreRules,
	relativePath: string,
): boolean {
	let end = relativePath.indexOf("/");
	while (end > 0 && end <= MAX_CONTEXT_SOURCE_PATH_LENGTH) {
		try {
			if (rules.ignoresDirectory(relativePath.slice(0, end))) {
				return true;
			}
		} catch {
			return false;
		}
		end = relativePath.indexOf("/", end + 1);
	}
	return false;
}

/** One of the text extensions, in any case (the canonical module's rule). */
export function hasTextExtension(relativePath: string): boolean {
	return hasContextTextExtension(relativePath);
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

/**
 * Is a storage key at or under one of the member's left-out keys (Fizzy
 * #2750 §5.5)? Whole segments, case-sensitive, in storage-key coordinates:
 * `docs/drafts` covers itself and `docs/drafts/x.md`, never
 * `docs/drafts-2/x.md` or `docs/Drafts/x.md`. Left-out keys are never `""`
 * (`configure` refuses it); one would cover nothing here.
 */
export function isAtOrUnderLeftOutKey(
	storageKey: string,
	leftOutKeys: readonly string[],
): boolean {
	return leftOutKeys.some(
		(leftOut) =>
			leftOut !== "" &&
			(storageKey === leftOut || storageKey.startsWith(`${leftOut}/`)),
	);
}

/**
 * `repositoryPath` has a `.fabric` segment, at any depth and in any case:
 * the CLI's own state, which the sync never applies (Fizzy #2704), as
 * `configure` refuses it (`paths.ts`). Needed beyond the `.fabric/` default
 * because that pattern is matched relative to a selected folder, and so
 * cannot see a `.fabric` that is, or is above, the selection itself.
 */
export function isInFabricDirectory(repositoryPath: string): boolean {
	return isInContextSyncFabricDirectory(repositoryPath);
}
