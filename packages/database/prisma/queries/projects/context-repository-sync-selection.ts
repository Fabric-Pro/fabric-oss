/**
 * How a Living Memory repository sync's left-out paths sit inside its
 * selected paths (Fizzy #2750 §5.2, §5.3). Pure: no Prisma, no I/O.
 *
 * Both lists are canonical storage keys (`normalizeContextSourcePath(p) ===
 * p`) and compared by whole segments, case-sensitively: `docs` contains
 * `docs/drafts`, never `docs-archive`, and `""` (the whole repository)
 * contains every other path. A left-out path must be strictly inside a
 * selected path, never equal to one. `configure` refuses a list that does
 * not fit (`EXCLUDED_PATH_OUTSIDE_SELECTION`), and the configure write
 * refuses a kept list that new paths no longer contain
 * (`excluded-paths-stale`): one rule for both.
 */

/** `inner` is strictly inside `outer`, by whole segments. */
export function isStrictlyInsideContextSyncPath(
	outer: string,
	inner: string,
): boolean {
	if (inner === outer) {
		return false;
	}
	return outer === "" ? inner !== "" : inner.startsWith(`${outer}/`);
}

/**
 * The first left-out path that is not strictly inside one of the selected
 * paths, or `null` when every one is.
 */
export function firstExcludedPathOutsideSelection(
	paths: readonly string[],
	excludedPaths: readonly string[],
): string | null {
	for (const excluded of excludedPaths) {
		if (
			!paths.some((selected) =>
				isStrictlyInsideContextSyncPath(selected, excluded),
			)
		) {
			return excluded;
		}
	}
	return null;
}
