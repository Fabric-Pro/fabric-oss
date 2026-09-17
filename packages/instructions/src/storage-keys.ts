const PREFIX = "projects";

export function stagingPrefix(projectId: string, snapshotId: string): string {
	return `${PREFIX}/${projectId}/instructions/staging/${snapshotId}/`;
}

export function stagingKey(
	projectId: string,
	snapshotId: string,
	fileId: string,
): string {
	return `${stagingPrefix(projectId, snapshotId)}${fileId}`;
}

export function snapshotPrefix(projectId: string, snapshotId: string): string {
	return `${PREFIX}/${projectId}/instructions/snapshots/${snapshotId}/`;
}

export function snapshotKey(
	projectId: string,
	snapshotId: string,
	fileId: string,
): string {
	return `${snapshotPrefix(projectId, snapshotId)}${fileId}`;
}

/**
 * Every export object a snapshot can have, as a listable prefix.
 *
 * Deleting a snapshot has to delete its exports too, and the file rows only
 * know their own `storageKey` — nothing records which zips were built from
 * them. The prefix is the link: it is derived from the snapshot id alone, so
 * it finds every export regardless of what stamp built it, including the
 * `Date.now()`-stamped ones an earlier build wrote.
 */
export function exportKeyPrefix(projectId: string, snapshotId: string): string {
	return `${PREFIX}/${projectId}/instructions/exports/${snapshotId}-`;
}

/**
 * `stamp` must be a value that is CONSTANT for a given snapshot's content —
 * callers pass its digest. With a varying stamp (a wall clock was the
 * original) every download and every `fabric_get_project_instruction_bundle`
 * call writes a fresh full copy of the tree, and an agent that polls the
 * bundle at session start accumulates one per session per developer,
 * forever. Keyed on the digest, a rebuild overwrites one object per snapshot.
 */
export function exportKey(
	projectId: string,
	snapshotId: string,
	stamp: string,
): string {
	return `${exportKeyPrefix(projectId, snapshotId)}${stamp}.zip`;
}

export function isStagingKey(key: string): boolean {
	return key.includes("/instructions/staging/");
}

/**
 * Whether an object key belongs to THIS snapshot — the only keys any code
 * path may delete on this snapshot's behalf.
 *
 * A derived snapshot inherits unchanged files from the READY snapshot it was
 * edited from, and an inherited file row carries the BASE's immutable
 * promoted key until promotion rewrites it. Until then the row is a pointer
 * into another snapshot's storage, and every code path that deletes objects
 * by row key — the delete procedure, the retention prune — would take the
 * base's bytes with it: the published version of a project's coding
 * instructions, destroyed by cleaning up an edit that never finished.
 *
 * So a delete set built from row keys is filtered through this. It answers
 * the question by PREFIX, not by parsing, and the three prefixes are exactly
 * the ones this snapshot's own writes ever produce: its staging objects, its
 * promoted objects, and its export zips. Anything else is another snapshot's
 * (or another project's) and is left alone — fail-closed, because leaving an
 * unreferenced object for the bucket lifecycle rule is recoverable and
 * deleting a live one is not.
 */
export function isKeyOwnedBySnapshot(
	key: string,
	projectId: string,
	snapshotId: string,
): boolean {
	return (
		key.startsWith(stagingPrefix(projectId, snapshotId)) ||
		key.startsWith(snapshotPrefix(projectId, snapshotId)) ||
		key.startsWith(exportKeyPrefix(projectId, snapshotId))
	);
}
