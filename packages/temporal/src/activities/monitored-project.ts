/**
 * Lifecycle check for polling monitors whose project has nothing linked.
 */

import { db } from "@repo/database";

/**
 * Whether the project a polling monitor serves still has a row. Deleting a
 * project cascades its links away and leaves the monitor polling an empty list,
 * so an empty list alone cannot tell a quiet project from a deleted one. A
 * soft-deleted project keeps its row because it can still be restored. A database
 * failure throws, so it can never read as a missing project.
 */
export async function monitoredProjectExistsActivity(input: {
	projectId: string;
}): Promise<boolean> {
	const project = await db.project.findUnique({
		where: { id: input.projectId },
		select: { id: true },
	});
	return project !== null;
}
