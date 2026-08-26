/**
 * Pure helpers for incremental code indexing.
 *
 * These are intentionally dependency-free so they are safe to import inside the
 * Temporal workflow sandbox AND easy to unit-test in isolation. They must stay
 * deterministic: the workflow re-derives the "files to embed" set on every
 * `continueAsNew` resumption, so the same inputs must always yield the same
 * output.
 */

/**
 * Whether this run should index only the changed files rather than the whole
 * repository. True only when the caller asked for incremental AND actually
 * supplied a non-empty changed-file list (a webhook push). The type predicate
 * lets callers treat `changedFiles` as defined afterwards.
 */
export function isIncrementalRun(
	incremental: boolean | undefined,
	changedFiles: string[] | undefined,
): changedFiles is string[] {
	return Boolean(incremental && changedFiles && changedFiles.length > 0);
}

/**
 * The subset of `allFiles` to (re)embed on an incremental run: those whose
 * repository-relative path is in the changed set. Removed files are naturally
 * absent (they are not in the fresh checkout), so this yields exactly the
 * added + modified files that still exist. Pure and order-preserving, so it is
 * safe to re-derive across `continueAsNew`.
 */
export function selectChangedFiles<T extends { relativePath: string }>(
	allFiles: T[],
	changedFiles: string[],
): T[] {
	const changed = new Set(changedFiles);
	return allFiles.filter((file) => changed.has(file.relativePath));
}
