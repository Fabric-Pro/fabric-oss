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
