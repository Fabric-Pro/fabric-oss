import { config } from "@repo/config";
import {
	deleteDiscardedNewsletterSendImages,
	getNewsletterProjectTenant,
} from "@repo/database";
import { deleteNewsletterSendFolder } from "@repo/database/prisma/queries/projects/newsletter-image-publish";
import { logger } from "@repo/logs";
import { deleteObjects } from "@repo/storage";

/**
 * Delete what is left in a finished send's review folder: review copies of a
 * delivered send, and uploads a reviewer started but never added. Published
 * copies are elsewhere and stay. Best-effort, never throws.
 */
export async function clearNewsletterSendFolder(
	projectId: string,
	sendId: string,
): Promise<void> {
	try {
		const tenant = await getNewsletterProjectTenant(projectId);
		if (tenant) {
			await deleteNewsletterSendFolder(tenant, sendId);
		}
	} catch (error) {
		logger.warn("[Newsletter] send folder not cleared", {
			sendId,
			error: error instanceof Error ? error.name : "unknown",
		});
	}
}

/**
 * Remove the review images of a held draft the stale-review reclaim expired,
 * or of a send that ended failed or skipped: the rows, then the objects they
 * held, including a public copy published before delivery failed, then the
 * rest of the send's review folder. The send will never go out, so neither
 * will its images. Best-effort — a failure is logged and never fails the
 * dispatch or the finalize it follows.
 */
export async function discardExpiredReviewImages(
	projectId: string,
	sendId: string,
): Promise<void> {
	try {
		const keys = await deleteDiscardedNewsletterSendImages(
			projectId,
			sendId,
		);
		if (keys.length > 0) {
			const result = await deleteObjects(keys, {
				bucket: config.storage.bucketNames.projectContexts,
			});
			if (result.errors.length > 0) {
				logger.warn("[Newsletter] expired draft's image objects left", {
					sendId,
					count: result.errors.length,
				});
			}
		}
	} catch (error) {
		logger.warn("[Newsletter] expired draft's images not removed", {
			sendId,
			error: error instanceof Error ? error.name : "unknown",
		});
	}
	await clearNewsletterSendFolder(projectId, sendId);
}
