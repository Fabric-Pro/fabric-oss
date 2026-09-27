/**
 * What the Coding Instructions repository sync leaves out, and the project
 * ignore rules the configure dialog stages (Fizzy #2726, #2750 §4). The
 * shared selection tree's Coding Instructions adapter
 * (`components/repository-sync/lib/instructions-selection.ts`) builds every
 * row on this.
 *
 * What is skipped is decided exactly as the sync decides it: the folder's
 * `.fabricignore`, when it has a rule, replaces the project's rules; else the
 * project's own list when it has one (an empty list is a setting); else the
 * defaults (`resolveIgnoreGlobs`), always behind the built-in rules
 * (`buildIgnoreMatcher`), with paths relative to the synced folder.
 *
 * Unticking a row stages an edit to the project's own list, nothing more:
 * the pattern for a folder `F` under the synced folder is `F/**`, and for a
 * file its path relative to that folder. Edits are kept as additions and
 * removals against the SAVED list, so staging and then unstaging the same
 * row leaves the saved list exactly as it was — a project with no setting
 * of its own keeps none, rather than being pinned to a copy of today's
 * defaults. The first addition to a project with no setting starts from the
 * defaults, so they are not silently dropped.
 */
import {
	buildIgnoreMatcher,
	canonicalKey,
	DEFAULT_IGNORE_GLOBS,
	type IgnoreMatch,
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

/** The rule unticking `folder` writes (relative to the synced folder). */
export function folderExclusionPattern(folder: string): string {
	return `${folder}/**`;
}

/**
 * Whether two rules are the same rule to the matcher: it compiles both
 * case-insensitively, after the same slash and `./` clean-up
 * `canonicalKey` performs on a path, so `./docs/guide.md` is the rule the
 * row `docs/Guide.md` writes.
 */
export function sameRule(a: string, b: string): boolean {
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
 * `edits` with `pattern` excluded (`exclude`) or not. Turning a row back the
 * way the saved list has it cancels the staged edit rather than staging its
 * opposite.
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

/**
 * The saved rules `edits` remove, in their saved spelling: what the dialog
 * lists before Save, since the rules are shared with folder uploads and the
 * settings dialog and carry no record of who added them (Fizzy #2750 §4).
 */
export function savedRulesRemovedBy(
	saved: readonly string[] | null,
	edits: ExclusionEdits,
): string[] {
	if (saved === null || edits.remove.length === 0) {
		return [];
	}
	return saved.filter((glob) =>
		edits.remove.some((rule) => sameRule(glob, rule)),
	);
}

/** The matcher the sync would build for the synced folder. */
export type SyncExclusionMatcher = {
	/** The layer that decides beside the built-in rules. */
	layer: "fabricignore" | "project" | "default";
	/** That layer's rules, in the order the matcher tries them. */
	globs: readonly string[];
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
	return {
		layer: resolved.layer,
		globs: resolved.globs,
		match: buildIgnoreMatcher(resolved),
	};
}
