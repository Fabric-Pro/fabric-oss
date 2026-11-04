import { classifyPath } from "@repo/instructions";

/**
 * What the member's own proposal branch does to one path, against the
 * published version: a file only the branch holds, a published file the
 * branch deletes, or a published file whose bytes differ on the branch.
 */
export type BranchMarker = "branchOnly" | "deletedOnBranch" | "changedOnBranch";

/** One entry of `proposals.myBranch`'s projection. */
export type BranchProjectionFile = {
	path: string;
	state: "written" | "deleted" | "restored_unavailable";
	objectId: string | null;
};

type PublishedFile = {
	path: string;
	kind: string;
	name?: string | null;
	description?: string | null;
	/** The published Git blob; compared with the branch's to tell a real change. */
	blobId?: string;
};

export type BranchTreeFile = Omit<PublishedFile, "blobId"> & {
	branch?: BranchMarker;
};

/**
 * The marker for a path, or null when the branch leaves it as published. A
 * branch file whose blob equals the published one is not a change. A path
 * the branch deleted that was never published, and a start version Fabric
 * never stored that is not published, are not files of the member's branch
 * view at all.
 */
export function branchMarkerOf(
	published: Pick<PublishedFile, "blobId"> | undefined,
	entry: BranchProjectionFile,
): BranchMarker | null {
	if (published === undefined) {
		return entry.state === "written" ? "branchOnly" : null;
	}
	if (entry.state === "deleted") {
		return "deletedOnBranch";
	}
	return entry.objectId !== null && entry.objectId === published.blobId
		? null
		: "changedOnBranch";
}

/**
 * The published files with the member's branch merged in: each published
 * file marked with what the branch does to it, then every file only the
 * branch holds, with the `branchOnly` marker.
 */
export function withBranchFiles(
	published: readonly PublishedFile[],
	branch: readonly BranchProjectionFile[],
): BranchTreeFile[] {
	const byPath = new Map(branch.map((entry) => [entry.path, entry]));
	const publishedPaths = new Set(published.map((file) => file.path));
	const files: BranchTreeFile[] = published.map(({ blobId, ...file }) => {
		const entry = byPath.get(file.path);
		const marker = entry ? branchMarkerOf({ blobId }, entry) : null;
		return marker ? { ...file, branch: marker } : file;
	});
	for (const entry of branch) {
		if (
			!publishedPaths.has(entry.path) &&
			branchMarkerOf(undefined, entry) === "branchOnly"
		) {
			files.push({
				path: entry.path,
				kind: classifyPath(entry.path),
				branch: "branchOnly",
			});
		}
	}
	return files;
}
