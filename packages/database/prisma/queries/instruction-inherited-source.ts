/**
 * The rule for when a derived row may stand on another snapshot's file, with
 * no database access so the activity that checks it and the transaction that
 * creates the row cannot drift apart.
 */

/**
 * The facts about a file row an inherited row names as its source
 * (`inheritedFromFileId`), read from the SOURCE row and its snapshot rather
 * than inferred from the derived snapshot's `baseSnapshotId`, which is a
 * `SetNull` column that the retention prune can clear.
 */
export type InheritedInstructionSource = {
	id: string;
	snapshotId: string;
	storageKey: string;
	sha256: string;
	size: number;
	/** Classification metadata of the source, which an inherited row carries unchanged. */
	name: string | null;
	description: string | null;
	snapshotStatus: string;
	/** The rule-set version that cleared every file of the source's snapshot, or null. */
	scanRulesVersion: string | null;
};

/**
 * Whether `source` is a legitimate origin for a derived row that claims it.
 *
 * Every condition is a statement about immutable promoted bytes: the source
 * snapshot is READY (so its objects were promoted and hashed), the source row
 * sits at the deterministic promoted key of ITS OWN snapshot
 * (`expectedSourceKey`, built by the caller from ids, never read from a
 * column), and the derived row describes exactly those bytes. A row failing
 * any of them is treated as not inherited at all.
 */
export function isAcceptableInheritedSource(
	source: InheritedInstructionSource,
	derived: { storageKey: string; sha256: string; size: number },
	expectedSourceKey: string,
): boolean {
	return (
		source.snapshotStatus === "READY" &&
		source.storageKey === expectedSourceKey &&
		derived.storageKey === expectedSourceKey &&
		derived.sha256 === source.sha256 &&
		derived.size === source.size
	);
}
