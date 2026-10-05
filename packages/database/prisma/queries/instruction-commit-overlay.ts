/**
 * What Fabric knows about a page of a branch's commits (Fizzy #2878 §10): the
 * overlay the History tab lays over the provider's own commit list. Read-only,
 * tenant-scoped, and bounded by the page it is asked about.
 *
 * - `published`: the version of the READY snapshot of that commit (a sync's
 *   copy of it, or a direct commit's), the highest when a commit was copied
 *   more than once.
 * - `refused`: a sync run evaluated that commit and the secret scan refused its
 *   tree (`TREE_REFUSED`): Fabric holds no copy of it and serves nothing from
 *   it.
 */
import { db } from "../client";

export type InstructionCommitOverlay = {
	/** Commit sha to the version of Fabric's READY copy of it. */
	published: Map<string, number>;
	/** Commits a sync run refused. */
	refused: Set<string>;
};

export async function getInstructionCommitOverlay(input: {
	projectId: string;
	organizationId: string;
	shas: readonly string[];
}): Promise<InstructionCommitOverlay> {
	if (input.shas.length === 0) {
		return { published: new Map(), refused: new Set() };
	}
	const [snapshots, runs] = await Promise.all([
		db.projectInstructionSnapshot.findMany({
			where: {
				projectId: input.projectId,
				organizationId: input.organizationId,
				source: "REPOSITORY",
				status: "READY",
				sourceCommitSha: { in: [...input.shas] },
			},
			select: { sourceCommitSha: true, version: true },
		}),
		db.projectInstructionRepositorySyncRun.findMany({
			where: {
				projectId: input.projectId,
				organizationId: input.organizationId,
				error: "TREE_REFUSED",
				commitSha: { in: [...input.shas] },
			},
			select: { commitSha: true },
		}),
	]);
	const published = new Map<string, number>();
	for (const snapshot of snapshots) {
		if (snapshot.sourceCommitSha === null) {
			continue;
		}
		const seen = published.get(snapshot.sourceCommitSha);
		if (seen === undefined || snapshot.version > seen) {
			published.set(snapshot.sourceCommitSha, snapshot.version);
		}
	}
	const refused = new Set<string>();
	for (const run of runs) {
		if (run.commitSha !== null) {
			refused.add(run.commitSha);
		}
	}
	return { published, refused };
}
