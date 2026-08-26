/**
 * PM State Poll Activation Activity
 *
 * Called after a successful ADO push/pull to enable state polling for the project.
 */
import { db } from "@repo/database";
import { logger } from "@repo/logs";

/**
 * Activate ADO state polling for a project.
 *
 * Sets `adoStatePollActive = true` on the project. Does not overwrite
 * `lastAdoStatePollAt` if already set (preserves the backfill anchor).
 *
 * Idempotent — safe to call multiple times.
 */
export async function activateAdoStatePoll(projectId: string): Promise<void> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { adoStatePollActive: true, lastAdoStatePollAt: true },
	});

	if (!project) {
		logger.warn("[PM Poll Activation] Project not found", { projectId });
		return;
	}

	if (project.adoStatePollActive) {
		return;
	}

	await db.project.update({
		where: { id: projectId },
		data: { adoStatePollActive: true },
	});

	logger.info("[PM Poll Activation] Activated PM state polling", {
		projectId,
	});
}
