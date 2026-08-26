/**
 * Activities for cleaning up expired wizard temp contexts
 */

import {
	deleteExpiredWizardTempContexts,
	getExpiredWizardTempContexts,
} from "@repo/database";
import { logger } from "@repo/logs";
import { deleteAllWizardContextsForSession } from "@repo/rag";
import { getStorageProvider } from "@repo/storage";

export interface CleanupWizardTempContextsInput {
	/** Optional: batch size for deletion (default: 100) */
	batchSize?: number;
}

export interface CleanupWizardTempContextsOutput {
	deletedCount: number;
	deletedIds: string[];
	qdrantDeletedCount: number;
	errors: string[];
}

/**
 * Clean up expired wizard temp contexts
 * - Deletes associated S3 files
 * - Deletes embeddings from Qdrant
 * - Removes database records
 */
export async function cleanupWizardTempContextsActivity(
	input: CleanupWizardTempContextsInput = {},
): Promise<CleanupWizardTempContextsOutput> {
	const { batchSize = 100 } = input;

	const errors: string[] = [];
	const deletedIds: string[] = [];
	let qdrantDeletedCount = 0;

	try {
		// Get expired contexts
		const expiredContexts = await getExpiredWizardTempContexts(batchSize);

		if (expiredContexts.length === 0) {
			logger.info("[WizardCleanup] No expired contexts found");
			return {
				deletedCount: 0,
				deletedIds: [],
				qdrantDeletedCount: 0,
				errors: [],
			};
		}

		logger.info(
			`[WizardCleanup] Found ${expiredContexts.length} expired contexts to clean up`,
		);

		const storageProvider = getStorageProvider();

		// Group contexts by sessionId for efficient Qdrant deletion
		const sessionIds = new Set<string>();
		const sessionOrgMapping = new Map<
			string,
			{ userId: string; organizationId?: string | null }
		>();

		// Delete S3 files for each context and collect session info
		for (const ctx of expiredContexts) {
			// Track session IDs for Qdrant cleanup
			sessionIds.add(ctx.sessionId);
			if (!sessionOrgMapping.has(ctx.sessionId)) {
				sessionOrgMapping.set(ctx.sessionId, {
					userId: ctx.userId,
					organizationId: ctx.organizationId,
				});
			}

			// Delete S3 file
			if (ctx.s3Path && ctx.s3Bucket) {
				try {
					await storageProvider.deleteFile(ctx.s3Path, {
						bucket: ctx.s3Bucket,
					});
					logger.debug(
						`[WizardCleanup] Deleted S3 file: ${ctx.s3Path}`,
					);
				} catch (error) {
					const errorMsg = `Failed to delete S3 file ${ctx.s3Path}: ${error instanceof Error ? error.message : "Unknown error"}`;
					logger.warn(`[WizardCleanup] ${errorMsg}`);
					errors.push(errorMsg);
					// Continue with deletion - file may not exist
				}
			}

			deletedIds.push(ctx.id);
		}

		// Delete Qdrant embeddings for each session
		for (const sessionId of sessionIds) {
			const sessionInfo = sessionOrgMapping.get(sessionId);
			if (!sessionInfo) {
				continue;
			}

			try {
				const deleted = await deleteAllWizardContextsForSession({
					sessionId,
					userId: sessionInfo.userId,
					organizationId: sessionInfo.organizationId ?? undefined,
				});

				qdrantDeletedCount += deleted;
				logger.info(
					`[WizardCleanup] Deleted ${deleted} Qdrant embeddings for session ${sessionId}`,
				);
			} catch (error) {
				const errorMsg = `Failed to delete Qdrant embeddings for session ${sessionId}: ${error instanceof Error ? error.message : "Unknown error"}`;
				logger.warn(`[WizardCleanup] ${errorMsg}`);
				errors.push(errorMsg);
				// Continue with other sessions
			}
		}

		// Delete database records
		const result = await deleteExpiredWizardTempContexts();

		logger.info(
			`[WizardCleanup] Deleted ${result.deletedCount} expired wizard temp contexts, ${qdrantDeletedCount} Qdrant embeddings`,
		);

		return {
			deletedCount: result.deletedCount,
			deletedIds,
			qdrantDeletedCount,
			errors,
		};
	} catch (error) {
		const errorMsg = `Cleanup failed: ${error instanceof Error ? error.message : "Unknown error"}`;
		logger.error(`[WizardCleanup] ${errorMsg}`);
		errors.push(errorMsg);

		return {
			deletedCount: deletedIds.length,
			deletedIds,
			qdrantDeletedCount,
			errors,
		};
	}
}
