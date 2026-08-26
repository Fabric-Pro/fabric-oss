/**
 * Context Deletion Activities
 *
 * Activities for deleting project contexts (Notion pages, uploaded files, etc.)
 * from Qdrant and database. Provides durable deletion with retries.
 */

import { deleteContext, getContextById } from "@repo/database";
import { deleteProjectContext, deleteUrlSourceChunks } from "@repo/rag";
import { activityLogger } from "./lib/activity-logger";

export interface DeleteSingleContextInput {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
	qdrantId?: string;
}

export interface DeleteSingleContextOutput {
	success: boolean;
	error?: string;
	qdrantDeleted: boolean;
	dbDeleted: boolean;
}

/**
 * Delete a single project context from Qdrant and database
 *
 * This activity handles:
 * 1. Deleting vectors from Qdrant (all chunks for the context)
 * 2. Deleting the context record from the database
 *
 * Designed to be called from the contextDeletionWorkflow.
 */
export async function deleteSingleContextActivity(
	input: DeleteSingleContextInput,
): Promise<DeleteSingleContextOutput> {
	const { contextId, projectId, userId, organizationId, qdrantId } = input;

	activityLogger.info("Deleting project context", {
		contextId,
		projectId,
		userId,
		hasQdrantId: !!qdrantId,
	});

	let qdrantDeleted = false;
	let dbDeleted = false;

	try {
		// Step 1: Get context to verify it exists and get qdrantId if not provided
		const context = await getContextById(contextId);

		if (!context) {
			activityLogger.warn(
				"Context not found, may have been deleted already",
				{
					contextId,
					hasQdrantId: !!qdrantId,
				},
			);

			// DB row is gone, but if qdrantId was provided we still need to
			// clean up the vectors (the caller deleted the row before us)
			if (qdrantId) {
				try {
					await deleteProjectContext(
						contextId,
						organizationId,
						qdrantId,
					);
					activityLogger.info(
						"Deleted orphaned Qdrant vectors for already-deleted context",
						{ contextId, qdrantId },
					);
					return {
						success: true,
						qdrantDeleted: true,
						dbDeleted: false,
					};
				} catch (qdrantError) {
					activityLogger.warn(
						"Failed to delete orphaned Qdrant vectors",
						{
							contextId,
							qdrantId,
							error:
								qdrantError instanceof Error
									? qdrantError.message
									: "Unknown error",
						},
					);
				}
			}

			return {
				success: true,
				qdrantDeleted: false,
				dbDeleted: false,
			};
		}

		// Verify project ownership
		if (context.projectId !== projectId) {
			activityLogger.error("Context project mismatch", null, {
				contextId,
				expectedProjectId: projectId,
				actualProjectId: context.projectId,
			});
			return {
				success: false,
				error: "Context does not belong to the specified project",
				qdrantDeleted: false,
				dbDeleted: false,
			};
		}

		const effectiveQdrantId = qdrantId || context.qdrantId;

		// Step 1b: URL Context Sources (LINK + PATH_PREFIX) store one Qdrant
		// point per scraped page, each chunk's payload carrying
		// `parentContextId` = this context's id. The standard `deleteProjectContext`
		// filter (originalContextId / contextId match the parent id) misses
		// those per-page chunks because they carry per-article ids in those
		// fields. Without this step those chunks become orphans after the
		// Postgres cascade-delete fires — wasting storage and search compute.
		// `getRetrievableContextById` filters them out at retrieval time so
		// they never reach the LLM, but cleanup here keeps the vector store
		// honest. Safe + cheap for non-LINK contexts (filter matches zero).
		if (context.type === "LINK") {
			try {
				await deleteUrlSourceChunks(contextId, organizationId);
				activityLogger.info("Deleted URL-source per-page chunks", {
					contextId,
				});
			} catch (chunkError) {
				activityLogger.warn(
					"Failed to delete URL-source per-page chunks, continuing",
					{
						contextId,
						error:
							chunkError instanceof Error
								? chunkError.message
								: "Unknown error",
					},
				);
			}
		}

		// Step 2: Delete from Qdrant if qdrantId exists
		if (effectiveQdrantId) {
			try {
				await deleteProjectContext(
					contextId,
					organizationId,
					effectiveQdrantId,
				);
				qdrantDeleted = true;
				activityLogger.info("Deleted context from Qdrant", {
					contextId,
					qdrantId: effectiveQdrantId,
				});
			} catch (qdrantError) {
				// Log but don't fail - Qdrant deletion is best-effort
				// The context may not have been embedded yet
				activityLogger.warn(
					"Failed to delete from Qdrant, continuing with DB deletion",
					{
						contextId,
						error:
							qdrantError instanceof Error
								? qdrantError.message
								: "Unknown error",
					},
				);
			}
		} else {
			activityLogger.info("No qdrantId, skipping Qdrant deletion", {
				contextId,
			});
		}

		// Step 3: Delete from database
		await deleteContext(contextId);
		dbDeleted = true;

		activityLogger.info("Context deleted successfully", {
			contextId,
			qdrantDeleted,
			dbDeleted,
		});

		return {
			success: true,
			qdrantDeleted,
			dbDeleted,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		activityLogger.error("Failed to delete context", error, {
			contextId,
			qdrantDeleted,
			dbDeleted,
		});

		return {
			success: false,
			error: errorMessage,
			qdrantDeleted,
			dbDeleted,
		};
	}
}
