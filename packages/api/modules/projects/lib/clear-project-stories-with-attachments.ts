import { config } from "@repo/config";
import { clearProjectStories } from "@repo/database";
import { deleteObjects } from "@repo/storage";

/**
 * Clear pipeline stories (via the race-safe `clearProjectStories`) and
 * best-effort delete their attachment objects from R2. The DB delete is the
 * source of truth; an object-store failure logs the exact keys (recoverable)
 * and never blocks the clear. Shared by both bulk-clear callers
 * (clear-stories + push-to-kanban) so cleanup ownership lives at one boundary.
 */
export async function clearProjectStoriesAndAttachments(
	projectId: string,
	clearPipelineOnly = true,
): Promise<{ count: number }> {
	const { count, attachmentKeys } = await clearProjectStories(
		projectId,
		clearPipelineOnly,
	);
	if (attachmentKeys.length > 0) {
		try {
			const { errors } = await deleteObjects(attachmentKeys, {
				bucket: config.storage.bucketNames.projectContexts,
			});
			if (errors.length > 0) {
				console.warn(
					`[attachments] orphaned ${errors.length} object(s) after bulk story-clear (project ${projectId})`,
					errors.slice(0, 20),
				);
			}
		} catch (err) {
			console.warn(
				`[attachments] deleteObjects threw during bulk story-clear (project ${projectId}); objects may be orphaned`,
				err,
			);
		}
	}
	return { count };
}
