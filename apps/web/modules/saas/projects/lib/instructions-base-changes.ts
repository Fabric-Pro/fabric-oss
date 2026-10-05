/**
 * What the published version changed relative to the version it was edited
 * from, as `projects.instructions.compare` answers it. Only the paths are read
 * here: the tree marks them, the status strip counts them.
 */
export type BaseComparison = {
	from: { version: number };
	added: ReadonlyArray<{ path: string }>;
	removed: ReadonlyArray<{ path: string }>;
	changed: ReadonlyArray<{ path: string }>;
};

/** How a file of the published tree differs from the base: it is new, or its bytes changed. */
export type ChangeMark = "added" | "changed";

export function comparisonHasChanges(comparison: BaseComparison): boolean {
	return (
		comparison.added.length > 0 ||
		comparison.removed.length > 0 ||
		comparison.changed.length > 0
	);
}

/**
 * The marker of every file the tree can show. A removed file is not in the
 * published tree, so it has no row to mark and is left out.
 */
export function changeMarks(
	comparison: BaseComparison | undefined,
): ReadonlyMap<string, ChangeMark> {
	const marks = new Map<string, ChangeMark>();
	for (const file of comparison?.changed ?? []) {
		marks.set(file.path, "changed");
	}
	for (const file of comparison?.added ?? []) {
		marks.set(file.path, "added");
	}
	return marks;
}
