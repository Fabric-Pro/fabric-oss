/**
 * A repository snapshot may bypass the upload content scanner only when the
 * row itself proves it came from a repository-sync acquisition. `source` on
 * its own is insufficient: a sync receipt is the unique run identity created
 * by that acquisition and is absent from uploads, proposals, and direct
 * commits.
 */
export function isRepositorySyncSnapshot(snapshot: {
	source: string;
	syncRunKey: string | null;
}): boolean {
	return snapshot.source === "REPOSITORY" && snapshot.syncRunKey !== null;
}
