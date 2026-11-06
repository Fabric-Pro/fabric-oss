/**
 * Branch-relative Coding Instructions changes.
 *
 * A member's proposal branch can hold files the published version does not
 * have, and bytes of a published file that are not merged yet. A native
 * proposal may delete or edit a file only the branch holds, where Fabric's
 * established journal on the member's OWN accepting branch proves Fabric wrote
 * it there. These reads answer that, per path, with the blob and mode Fabric
 * wrote, or that it deleted the path, so the entry can freeze what it targets
 * and a reviewer sees the change against what the branch held. They never look
 * at another member's branch.
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

type MemberBranchQuery = {
	projectId: string;
	userId: string;
	organizationId: string;
	paths: readonly string[];
};

/**
 * What the member's OWN accepting branch holds per path. Null when no path
 * was asked about, or the member has no accepting branch.
 */
async function projectMemberBranch(i: MemberBranchQuery) {
	if (i.paths.length === 0) {
		return null;
	}
	const branch = await getAcceptingBranchForMember({
		projectId: i.projectId,
		userId: i.userId,
		organizationId: i.organizationId,
	});
	if (!branch || branch.userId !== i.userId) {
		return null;
	}
	const projected = new Map(
		projectEntries(
			await listEstablishedBranchOps({
				branchId: branch.id,
				organizationId: i.organizationId,
			}),
		).map((entry) => [entry.path, entry]),
	);
	return { branchId: branch.id, projected };
}

/**
 * Of `paths`, those the member's accepting branch holds as `written`, each
 * a regular file Fabric wrote. A member with no accepting branch, and any
 * path the branch does not hold that way, are simply absent from the map.
 */
export async function readMemberBranchWrittenPaths(
	i: MemberBranchQuery,
): Promise<Map<string, MemberBranchWrittenPath>> {
	const written = new Map<string, MemberBranchWrittenPath>();
	const branch = await projectMemberBranch(i);
	if (!branch) {
		return written;
	}
	for (const path of i.paths) {
		const entry = branch.projected.get(path);
		if (
			entry?.state !== "written" ||
			entry.objectId === null ||
			(entry.mode !== "100644" && entry.mode !== "100755")
		) {
			continue;
		}
		written.set(path, {
			path,
			branchId: branch.branchId,
			objectId: entry.objectId,
			mode: Number.parseInt(entry.mode, 8),
			sha256: entry.sha256,
		});
	}
	return written;
}

/**
 * Of `paths`, those an established operation deleted on the member's
 * accepting branch: the branch holds no blob at them. Empty for a member with
 * no accepting branch.
 */
export async function readMemberBranchDeletedPaths(
	i: MemberBranchQuery,
): Promise<Set<string>> {
	const branch = await projectMemberBranch(i);
	return new Set(
		branch
			? i.paths.filter(
					(path) => branch.projected.get(path)?.state === "deleted",
				)
			: [],
	);
}

/** Which stored proposal file Fabric wrote as one blob on a member's branch. */
export type MemberBranchBlobSource = {
	/** The proposal whose stored file at the path Fabric wrote. */
	snapshotId: string;
	/** The hash Fabric recorded for the write, when it recorded one. */
	sha256: string | null;
};

/**
 * Where Fabric wrote blob `objectId` at `path` on the member's accepting
 * branch: the newest established write of exactly that blob, by an append or
 * by a revert that restored bytes Fabric holds. The "before" side of a
 * branch-relative entry, which froze that blob when it was submitted; the
 * branch's CURRENT state is not the answer, because the entry's own proposal
 * may have been appended over it since. Null when the member has no
 * accepting branch or no such write there.
 */
export async function findMemberBranchWrite(i: {
	projectId: string;
	userId: string;
	organizationId: string;
	path: string;
	objectId: string;
}): Promise<MemberBranchBlobSource | null> {
	const branch = await getAcceptingBranchForMember({
		projectId: i.projectId,
		userId: i.userId,
		organizationId: i.organizationId,
	});
	if (!branch || branch.userId !== i.userId) {
		return null;
	}
	const ops = await listEstablishedBranchOps({
		branchId: branch.id,
		organizationId: i.organizationId,
	});
	for (const op of [...ops].sort((a, b) => b.executionSeq - a.executionSeq)) {
		for (const e of op.entries) {
			if (e.path !== i.path) {
				continue;
			}
			const [entry, source, sha256] =
				op.kind === "APPEND"
					? [e.after, e.afterSource, e.afterSha256]
					: [e.before, e.beforeSource, null];
			if (entry?.oid === i.objectId && source !== null) {
				return { snapshotId: source, sha256 };
			}
		}
	}
	return null;
}
