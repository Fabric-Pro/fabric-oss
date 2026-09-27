/**
 * The selected paths of a Living Memory repository sync, and the paths left
 * out inside them, as `configure` accepts them (design 2026-09-23 §2, §5.1;
 * Fizzy #2750 §5.2). Pure.
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
 * The default exclusions, `.fabric`, the basename rule, and the spelling
 * and length rule (`contextSyncPathSpellingProblem`) are the canonical
 * module's (`@repo/instructions/context-sync-rules`, Fizzy #2750 §7), which
 * the run and the configure dialog import too, so the dialog refuses a
 * typed path, or a folder the tree only implied, exactly as this does.
 *
 * The rest: duplicates dropped, sorted, at most 50, and none a prefix of
 * another by whole segments (`docs` and `docs/guides` overlap; `docs` and
 * `docs-archive` do not).
 *
 * Left-out paths (`canonicalizeContextSyncExcludedPaths`) are checked
 * lexically too, since `configure` cannot know a file from a folder: each in
 * the same canonical spelling and length bound (so it is its own storage
 * key), no `.fabric` segment (never synced, so nothing to leave out), and no
 * `.contextignore` basename (a policy file is read as policy, never left
 * out); a coding-instructions basename is allowed, since leaving one out is
 * a no-op. Then duplicates dropped, sorted, at most 200, each strictly
 * inside exactly one selected path and none inside another left-out path.
 * `contextSyncExcludedPathAllowed` holds the per-path rules, which
 * `listTree` applies to each entry as well.
 */
import {
	firstExcludedPathOutsideSelection,
	isStrictlyInsideContextSyncPath,
} from "@repo/database";
import {
	contextSyncPathSpellingProblem,
	defaultRuleForDirectlySelectedFile,
	isContextIgnorePolicyFile,
	isInContextSyncFabricDirectory,
	MAX_CONTEXT_SYNC_PATH_LENGTH,
} from "@repo/instructions/context-sync-rules";

const MAX_CONTEXT_SYNC_PATHS = 50;

/** At most this many left-out paths, counted after duplicates are dropped. */
export const MAX_CONTEXT_SYNC_EXCLUDED_PATHS = 200;

/**
 * `configure`'s input bound on the raw left-out list, before duplicates are
 * dropped: it only keeps an unbounded list out of the handler.
 */
export const MAX_CONTEXT_SYNC_EXCLUDED_PATHS_INPUT = 400;

/**
 * The longest path `configure` accepts: its input schema's bound, applied
 * here too so `listTree` never offers a path `configure` would refuse.
 */
export { MAX_CONTEXT_SYNC_PATH_LENGTH };

type ContextSyncPathsError =
	| { code: "INVALID_PATH"; path: string; message: string }
	| { code: "EXCLUDED_PATH"; path: string; message: string }
	| { code: "TOO_MANY_PATHS"; message: string }
	| { code: "PATH_PREFIX_OVERLAP"; path: string; message: string };

export type ContextSyncPathsResult =
	| { ok: true; paths: string[] }
	| ({ ok: false } & ContextSyncPathsError);

const NOT_CANONICAL_MESSAGE = (path: string) =>
	`"${path}" is not a repository path in its plain form: use '/' between folders, with no leading './' or '/', no trailing '/', no '.' or '..' segments and no surrounding spaces.`;
const TOO_LONG_MESSAGE = `A path is at most ${MAX_CONTEXT_SYNC_PATH_LENGTH} characters long.`;

/** A non-empty path's spelling or length refusal, if it has one. */
function spellingVerdict(
	path: string,
): { ok: false; code: "INVALID_PATH"; message: string } | null {
	switch (contextSyncPathSpellingProblem(path)) {
		case null:
			return null;
		case "too-long":
			return {
				ok: false,
				code: "INVALID_PATH",
				message: TOO_LONG_MESSAGE,
			};
		case "not-canonical":
			return {
				ok: false,
				code: "INVALID_PATH",
				message: NOT_CANONICAL_MESSAGE(path),
			};
	}
}

const FABRIC_MESSAGE = (path: string) =>
	`"${path}" is in a .fabric folder, the Fabric CLI's own state, which Living Memory never syncs.`;

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
	const spelling = spellingVerdict(path);
	if (spelling) {
		return spelling;
	}
	if (isInContextSyncFabricDirectory(path)) {
		return {
			ok: false,
			code: "EXCLUDED_PATH",
			message: FABRIC_MESSAGE(path),
		};
	}
	if (defaultRuleForDirectlySelectedFile(path) !== null) {
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

// =============================================================================
// Left-out paths (Fizzy #2750 §5.2)
// =============================================================================

export type ContextSyncExcludedPathVerdict =
	| { ok: true }
	| {
			ok: false;
			code:
				| "INVALID_PATH"
				| "EXCLUDED_PATH"
				| "EXCLUDED_PATH_POLICY_FILE";
			message: string;
	  };

/**
 * Whether one path may be left out, on its own (file comment): not the
 * whole repository, at most `MAX_CONTEXT_SYNC_PATH_LENGTH` characters, in
 * the canonical spelling, no `.fabric` segment, and not a `.contextignore`.
 * The one per-path rule set for both `configure` and `listTree`.
 */
export function contextSyncExcludedPathAllowed(
	path: string,
): ContextSyncExcludedPathVerdict {
	if (path === "") {
		return {
			ok: false,
			code: "INVALID_PATH",
			message:
				"Leave out a folder or a file inside a selected folder, not the whole repository.",
		};
	}
	const spelling = spellingVerdict(path);
	if (spelling) {
		return spelling;
	}
	if (isInContextSyncFabricDirectory(path)) {
		return {
			ok: false,
			code: "EXCLUDED_PATH",
			message: FABRIC_MESSAGE(path),
		};
	}
	if (isContextIgnorePolicyFile(path)) {
		return {
			ok: false,
			code: "EXCLUDED_PATH_POLICY_FILE",
			message: `"${path}" is a folder's .contextignore, which the sync reads as that folder's policy and never syncs, so it cannot be left out.`,
		};
	}
	return { ok: true };
}

type ContextSyncExcludedPathsError =
	| {
			code:
				| "INVALID_PATH"
				| "EXCLUDED_PATH"
				| "EXCLUDED_PATH_POLICY_FILE";
			path: string;
			message: string;
	  }
	| { code: "TOO_MANY_EXCLUDED_PATHS"; message: string }
	| { code: "EXCLUDED_PATH_OUTSIDE_SELECTION"; path: string; message: string }
	| {
			code: "EXCLUDED_PATH_OVERLAP";
			path: string;
			/** The left-out path it is inside. */
			withPath: string;
			message: string;
	  };

export type ContextSyncExcludedPathsResult =
	| { ok: true; excludedPaths: string[] }
	| ({ ok: false } & ContextSyncExcludedPathsError);

/**
 * The left-out paths `configure` stores, against the canonical selected
 * `paths` (`canonicalizeContextSyncPaths`'s answer): every path passes
 * `contextSyncExcludedPathAllowed`; duplicates are dropped and the rest
 * sorted, at most `MAX_CONTEXT_SYNC_EXCLUDED_PATHS`; each is strictly inside
 * one selected path (never equal to one); and none is inside another.
 */
export function canonicalizeContextSyncExcludedPaths(
	raw: readonly string[],
	paths: readonly string[],
): ContextSyncExcludedPathsResult {
	for (const path of raw) {
		const verdict = contextSyncExcludedPathAllowed(path);
		if (!verdict.ok) {
			return {
				ok: false,
				code: verdict.code,
				path,
				message: verdict.message,
			};
		}
	}

	const excludedPaths = [...new Set(raw)].sort();
	if (excludedPaths.length > MAX_CONTEXT_SYNC_EXCLUDED_PATHS) {
		return {
			ok: false,
			code: "TOO_MANY_EXCLUDED_PATHS",
			message: `Leave out at most ${MAX_CONTEXT_SYNC_EXCLUDED_PATHS} folders or files.`,
		};
	}
	const outside = firstExcludedPathOutsideSelection(paths, excludedPaths);
	if (outside !== null) {
		return {
			ok: false,
			code: "EXCLUDED_PATH_OUTSIDE_SELECTION",
			path: outside,
			message: paths.includes(outside)
				? `"${outside}" is selected; untick it instead of leaving it out.`
				: `"${outside}" is not inside a selected folder, so there is nothing to leave it out of.`,
		};
	}
	// Sorted, so a left-out ancestor sorts before every path under it.
	for (let i = 0; i < excludedPaths.length; i++) {
		for (let j = 0; j < i; j++) {
			const [ancestor, path] = [
				excludedPaths[j] as string,
				excludedPaths[i] as string,
			];
			if (isStrictlyInsideContextSyncPath(ancestor, path)) {
				return {
					ok: false,
					code: "EXCLUDED_PATH_OVERLAP",
					path,
					withPath: ancestor,
					message: `"${path}" is inside "${ancestor}", which is already left out.`,
				};
			}
		}
	}
	return { ok: true, excludedPaths };
}
