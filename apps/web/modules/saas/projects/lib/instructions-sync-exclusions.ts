/**
 * Folder exclusions in the Coding Instructions repository-sync configure
 * dialog (Fizzy #2726): which rows of the folder browser the sync will skip,
 * and the project ignore rules an "Exclude" toggle stages.
 *
 * What is skipped is decided exactly as the sync decides it: the folder's
 * `.fabricignore`, when it has a rule, replaces the project's rules; else the
 * project's own list when it has one (an empty list is a setting); else the
 * defaults (`resolveIgnoreGlobs`), always behind the built-in rules
 * (`buildIgnoreMatcher`), with paths relative to the synced folder.
 *
 * A toggle stages an edit to the project's own list, nothing more: the
 * pattern for a folder `F` under the synced folder is `F/**`. Edits are kept
 * as additions and removals against the SAVED list, so staging and then
 * unstaging the same folder leaves the saved list exactly as it was — a
 * project with no setting of its own keeps none, rather than being pinned
 * to a copy of today's defaults. The first addition to a project with no
 * setting starts from the defaults, so they are not silently dropped.
 */
import {
	buildIgnoreMatcher,
	canonicalKey,
	DEFAULT_IGNORE_GLOBS,
	type IgnoreLayer,
	type IgnoreMatch,
	PROJECT_IGNORE_GLOB_LIMITS,
	resolveIgnoreGlobs,
} from "@repo/instructions";

/** Staged edits to the project's own ignore list, against the saved one. */
export type ExclusionEdits = {
	readonly add: readonly string[];
	readonly remove: readonly string[];
};

export const NO_EXCLUSION_EDITS: ExclusionEdits = { add: [], remove: [] };

/** Whether anything is staged. */
export function hasExclusionEdits(edits: ExclusionEdits): boolean {
	return edits.add.length > 0 || edits.remove.length > 0;
}

/** The rule an "Exclude" toggle writes for `folder` (relative to the synced folder). */
export function folderExclusionPattern(folder: string): string {
	return `${folder}/**`;
}

/**
 * Whether two rules are the same rule to the matcher: it compiles both
 * case-insensitively, after the same slash and `./` clean-up
 * `canonicalKey` performs on a path.
 */
function sameRule(a: string, b: string): boolean {
	return canonicalKey(a) === canonicalKey(b);
}

/**
 * The project's own ignore list once `edits` apply: the saved list itself
 * (`null` included) while nothing is staged; otherwise the saved list — or,
 * for a project with no setting, the defaults it stands for — without the
 * removed rules and with the added ones appended.
 */
export function stagedProjectGlobs(
	saved: readonly string[] | null,
	edits: ExclusionEdits,
): string[] | null {
	if (!hasExclusionEdits(edits)) {
		return saved === null ? null : [...saved];
	}
	const next = (saved ?? DEFAULT_IGNORE_GLOBS).filter(
		(glob) => !edits.remove.some((rule) => sameRule(glob, rule)),
	);
	for (const rule of edits.add) {
		if (!next.some((glob) => sameRule(glob, rule))) {
			next.push(rule);
		}
	}
	return next;
}

/**
 * `edits` with `pattern` excluded (`exclude`) or not. Turning a folder back
 * the way the saved list has it cancels the staged edit rather than staging
 * its opposite.
 */
export function toggleExclusion(
	edits: ExclusionEdits,
	pattern: string,
	exclude: boolean,
): ExclusionEdits {
	const add = edits.add.filter((rule) => !sameRule(rule, pattern));
	const remove = edits.remove.filter((rule) => !sameRule(rule, pattern));
	if (exclude) {
		return remove.length < edits.remove.length
			? { add, remove }
			: { add: [...add, pattern], remove };
	}
	return add.length < edits.add.length
		? { add, remove }
		: { add, remove: [...remove, pattern] };
}

/** Whether saving `staged` would change the saved list. */
export function projectGlobsChanged(
	saved: readonly string[] | null,
	staged: readonly string[] | null,
): boolean {
	if (saved === null || staged === null) {
		return saved !== staged;
	}
	return (
		saved.length !== staged.length ||
		saved.some((glob, i) => glob !== staged[i])
	);
}

/** The matcher the sync would build for the synced folder. */
export type SyncExclusionMatcher = {
	/** The layer that decides beside the built-in rules. */
	layer: "fabricignore" | "project" | "default";
	match: (path: string) => IgnoreMatch | null;
};

/**
 * The sync's matcher for one folder: its `.fabricignore` rules (already
 * parsed by the server's `parseFabricIgnore`; `null` for no file, or a file
 * the sync drops) and the project's staged list.
 */
export function syncExclusionMatcher(input: {
	fabricIgnoreRules: readonly string[] | null;
	projectGlobs: readonly string[] | null;
}): SyncExclusionMatcher {
	const resolved = resolveIgnoreGlobs({
		// Parsed rules re-join to text that parses back to the same rules.
		fabricIgnoreText: input.fabricIgnoreRules?.join("\n") ?? null,
		projectGlobs: input.projectGlobs,
	});
	return { layer: resolved.layer, match: buildIgnoreMatcher(resolved) };
}

/**
 * Names for files a folder might hold, chosen unlike one another — a bare
 * name, a dotfile, a Markdown file — so that only a rule about the FOLDER
 * matches all of them. A rule about some files (`**\/*.md`, `**\/.*`,
 * `**\/fabric-*`, `**\/*-*`) misses at least one.
 */
const PROBE_NAMES = ["a", ".b", "c.md"] as const;

/**
 * The rule that skips `folder` as a whole, or null. The folder only reads
 * as skipped when every probe directly inside it AND every probe a folder
 * deeper is skipped: `docs/*` skips only `docs`'s own files, and
 * `docs/*\/**` only its subfolders', so neither makes the whole folder read
 * as skipped. A heuristic about the folder's CONTENT, which the preview only
 * uses for folders: every file row is judged on its own path.
 */
function folderMatch(
	match: SyncExclusionMatcher["match"],
	folder: string,
): IgnoreMatch | null {
	let first: IgnoreMatch | null = null;
	for (const name of PROBE_NAMES) {
		for (const probe of [
			`${folder}/${name}`,
			`${folder}/${name}/${name}`,
		]) {
			const hit = match(probe);
			if (!hit) {
				return null;
			}
			first ??= hit;
		}
	}
	return first;
}

/**
 * A skipped folder the rows below it sit in: its repository path and the
 * rule that skips it. A row below only says it is skipped "because this
 * folder is" when the same rule skips it; whether it is skipped at all is
 * always decided on its own.
 */
export type ExcludedAncestor = { path: string; rule: string };

/**
 * What a row passes down to the rows below it: the nearest skipped folder,
 * which is this one when a rule of its own skips it.
 */
export function excludedAncestorForChildren(
	row: ExclusionRow,
	path: string,
	parent: ExcludedAncestor | null,
): ExcludedAncestor | null {
	if (row.kind !== "excluded" || row.cause.via !== "rule") {
		return parent;
	}
	return { path, rule: row.cause.rule };
}

/** Why a row is skipped. */
export type ExclusionCause =
	| { via: "rule"; rule: string; layer: IgnoreLayer }
	/** Inside a skipped folder, `ancestor` (a repository path). */
	| { via: "ancestor"; ancestor: string }
	/**
	 * Not a regular file (a symbolic link): the sync keeps only regular
	 * files, so no rule, and no toggle, can include it.
	 */
	| { via: "notRegular" };

/** Why a folder's toggle cannot be changed, when it cannot. */
type ExclusionBlock =
	/** The `.fabricignore` replaces the project's rules. */
	| "fabricignore"
	/** Skipped by a rule the toggle does not own, or by an ancestor. */
	| "excluded"
	/** `*` or `?` in the path: `F/**` would not match it literally. */
	| "wildcard"
	/** `F/**` is longer than a project rule may be. */
	| "tooLong"
	/** The project's list already holds as many rules as it may. */
	| "full"
	/** What is skipped is not known yet, or could not be read. */
	| "unknown";

type FolderToggle = {
	pattern: string;
	checked: boolean;
	block: ExclusionBlock | null;
};

export type ExclusionRow =
	/** Not inside the synced folder (or the synced folder itself): nothing to show. */
	| { kind: "outside" }
	/** What is skipped is not known: a folder's toggle shows its own rule, disabled. */
	| { kind: "unknown"; toggle: FolderToggle | null }
	| { kind: "included"; toggle: FolderToggle | null }
	| { kind: "excluded"; cause: ExclusionCause; toggle: FolderToggle | null };

/** `path` relative to the synced folder `root`, or null when it is not inside it. */
function pathUnderRoot(path: string, root: string): string | null {
	if (root === "") {
		return path;
	}
	return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
}

/**
 * Whether the project's own list (with the staged edits applied) has no
 * room for one more rule. A project with no setting would start from the
 * defaults, so they count.
 */
export function projectIgnoreListFull(
	projectGlobs: readonly string[] | null,
): boolean {
	return (
		(projectGlobs ?? DEFAULT_IGNORE_GLOBS).length + 1 >
		PROJECT_IGNORE_GLOB_LIMITS.maxGlobs
	);
}

/**
 * The toggle's own refusal for a folder that is not skipped: a path the
 * pattern cannot name literally, a pattern too long to store, or a list
 * already full.
 */
function blockForNewRule(
	folder: string,
	pattern: string,
	projectGlobs: readonly string[] | null,
): ExclusionBlock | null {
	if (/[*?]/.test(folder)) {
		return "wildcard";
	}
	if (pattern.length > PROJECT_IGNORE_GLOB_LIMITS.maxGlobLength) {
		return "tooLong";
	}
	if (projectIgnoreListFull(projectGlobs)) {
		return "full";
	}
	return null;
}

/**
 * One row of the folder browser, as the sync would treat it.
 *
 * A FILE is skipped exactly when the sync's matcher matches its path
 * relative to the synced folder — what `planSnapshotFiles` decides — never
 * because of a folder above it. A file the listing marks `regular: false`
 * (a symbolic link) is always skipped, before any rule: the sync's
 * inventory keeps regular files only, so the planner never sees one.
 * A FOLDER is skipped when the matcher skips it as a whole
 * (`folderMatch`); inside a skipped folder its toggle is locked, since only
 * the outer folder's rule can be changed here.
 *
 * `excludedAncestor` is the nearest skipped folder a parent row passed down
 * (`excludedAncestorForChildren`), if any. `matcher` is null while what is
 * skipped is not known (the folder's `.fabricignore` is being read, or
 * could not be).
 */
export function describeExclusionRow(input: {
	path: string;
	type: "file" | "dir";
	/** The listing's `regular: false`: a file that is not a regular file. */
	regular?: false;
	root: string;
	excludedAncestor: ExcludedAncestor | null;
	matcher: SyncExclusionMatcher | null;
	/** The project's own list with the staged edits applied. */
	projectGlobs: readonly string[] | null;
}): ExclusionRow {
	const relative = pathUnderRoot(input.path, input.root);
	if (relative === null) {
		return { kind: "outside" };
	}
	const isDir = input.type === "dir";
	if (!isDir && input.regular === false) {
		// Known without the rules: nothing the matcher says can change it.
		return { kind: "excluded", cause: { via: "notRegular" }, toggle: null };
	}
	const pattern = folderExclusionPattern(relative);
	const ownRulePresent = (input.projectGlobs ?? []).some((glob) =>
		sameRule(glob, pattern),
	);
	if (!input.matcher) {
		return {
			kind: "unknown",
			toggle: isDir
				? { pattern, checked: ownRulePresent, block: "unknown" }
				: null,
		};
	}
	const fromFile = input.matcher.layer === "fabricignore";
	const ancestor = input.excludedAncestor;
	const match = isDir
		? folderMatch(input.matcher.match, relative)
		: input.matcher.match(relative);
	if (match) {
		const own =
			isDir &&
			!fromFile &&
			ancestor === null &&
			match.layer === "project" &&
			sameRule(match.rule, pattern);
		return {
			kind: "excluded",
			cause:
				ancestor !== null && sameRule(match.rule, ancestor.rule)
					? { via: "ancestor", ancestor: ancestor.path }
					: { via: "rule", rule: match.rule, layer: match.layer },
			toggle: isDir
				? {
						pattern,
						checked: true,
						block: own
							? null
							: fromFile
								? "fabricignore"
								: "excluded",
					}
				: null,
		};
	}
	return {
		kind: "included",
		toggle: isDir
			? {
					pattern,
					checked: false,
					block: fromFile
						? "fabricignore"
						: blockForNewRule(
								relative,
								pattern,
								input.projectGlobs,
							),
				}
			: null,
	};
}
