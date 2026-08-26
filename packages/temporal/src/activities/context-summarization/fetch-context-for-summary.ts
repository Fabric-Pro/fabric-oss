import { db, type SummaryTenancy } from "@repo/database";

export interface FetchContextForSummaryResult {
	projectName: string;
}

/**
 * Resolve the project name for the run. The heavy lifting (walking ALL eligible
 * raw context through bounded batches, plus its own eligible/processed counts)
 * lives in `generateSummaryActivity`, which paginates internally — so no unbounded
 * raw payload ever crosses the Temporal activity boundary. Kept as a distinct
 * workflow step so the activity sequence is unchanged (replay-safe).
 */
export async function fetchContextForSummaryActivity(input: {
	projectId: string;
	tenancy: SummaryTenancy;
	snapshotThrough: string;
}): Promise<FetchContextForSummaryResult> {
	const project = await db.project.findUnique({
		where: { id: input.projectId },
		select: { name: true },
	});
	return { projectName: project?.name ?? "Untitled project" };
}
