/**
 * Branch-relative Coding Instructions changes.
 *
 * A member's proposal branch can hold files the published version does not
 * have: a file they proposed that is not merged yet. A native proposal may
 * delete or edit such a file only where Fabric's established journal on the
 * member's OWN accepting branch proves Fabric wrote it there. This read
 * answers that, per path, with the blob and mode Fabric wrote, so the entry
 * can freeze what it targets. It never looks at another member's branch.
 */
import {
	getAcceptingBranchForMember,
	listEstablishedBranchOps,
	projectEntries,
} from "./instruction-proposal-branches";

/** One path Fabric wrote on the member's accepting branch. */
export type MemberBranchWrittenPath = {
	path: string;
	branchId: string;
	/** The blob Fabric wrote there. */
	objectId: string;
	/** Its Git file mode as a number: `0o100644` or `0o100755`. */
	mode: number;
	sha256: string | null;
};

/**
 * Of `paths`, those the member's accepting branch holds as `written`, each
 * a regular file Fabric wrote. A member with no accepting branch, and any
 * path the branch does not hold that way, are simply absent from the map.
 */
export async function readMemberBranchWrittenPaths(i: {
	projectId: string;
	userId: string;
	organizationId: string;
	paths: readonly string[];
}): Promise<Map<string, MemberBranchWrittenPath>> {
	const written = new Map<string, MemberBranchWrittenPath>();
	if (i.paths.length === 0) {
		return written;
	}
	const branch = await getAcceptingBranchForMember({
		projectId: i.projectId,
		userId: i.userId,
		organizationId: i.organizationId,
	});
	if (!branch || branch.userId !== i.userId) {
		return written;
	}
	const projected = new Map(
		projectEntries(
			await listEstablishedBranchOps({
				branchId: branch.id,
				organizationId: i.organizationId,
			}),
		).map((entry) => [entry.path, entry]),
	);
	for (const path of i.paths) {
		const entry = projected.get(path);
		if (
			entry?.state !== "written" ||
			entry.objectId === null ||
			(entry.mode !== "100644" && entry.mode !== "100755")
		) {
			continue;
		}
		written.set(path, {
			path,
			branchId: branch.id,
			objectId: entry.objectId,
			mode: Number.parseInt(entry.mode, 8),
			sha256: entry.sha256,
		});
	}
	return written;
}
