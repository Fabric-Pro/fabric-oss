/**
 * Context Deletion Activities
 *
 * Activities for deleting project contexts (Notion pages, uploaded files, etc.)
 * from Qdrant and database. Provides durable deletion with retries.
 */

import { deleteUnmanagedContextRow, getContextById } from "@repo/database";
import { deleteProjectContext, deleteUrlSourceChunks } from "@repo/rag";
import { getTemporalClient } from "../client";
import { startContextEmbeddingWorkflow } from "../lib/context-embedding-start";
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
	/**
	 * Why the row was not deleted, when `dbDeleted` is false for a reason
	 * other than an operational failure. `repository-managed`: a Living
	 * Memory repository sync owns the row (it adopted it, possibly after this
	 * activity read it), so it is kept; `changed`: the guarded delete matched
	 * nothing although the row is still there. Optional, so the workflow's
	 * handling of the result is unchanged.
	 */
	dbSkippedReason?: "repository-managed" | "changed";
	/**
	 * A kept row whose points this activity had already removed was marked
	 * unindexed, and an embedding start was requested for it (`true`) or the
	 * start failed and was logged (`false`; the row's `embeddedAt = NULL`
	 * remains the durable repair obligation).
	 */
	reembedRequested?: boolean;
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

		// The tenant the input carries, when it carries one: a row under
		// another organization is not this deletion's to touch, and its
		// points are not in this organization's collection. Some starters
		// pass `null` for "none" (the type says string | undefined, the
		// history says otherwise), so only a string counts as carried.
		const tenantOrganizationId =
			typeof organizationId === "string" ? organizationId : undefined;
		// A row with no organization of its own (written before rows were
		// stamped, or by a writer that left it off) is judged by its project
		// alone: the mismatch that matters is two organizations disagreeing.
		if (
			tenantOrganizationId !== undefined &&
			context.organizationId !== null &&
			context.organizationId !== tenantOrganizationId
		) {
			activityLogger.error("Context organization mismatch", null, {
				contextId,
				projectId,
			});
			return {
				success: false,
				error: "Context does not belong to the specified organization",
				qdrantDeleted: false,
				dbDeleted: false,
			};
		}

		// A row a Living Memory repository sync manages is the sync's alone
		// to delete (design 2026-09-23 §6). This workflow is no longer
		// started for synced files, but an execution open at deploy time
		// replays here; a row adopted since it started is left, points and
		// all.
		if (context.repositorySyncId !== null) {
			activityLogger.info(
				"Context is managed by a repository sync; not deleting it",
				{ contextId, projectId },
			);
			return {
				success: true,
				qdrantDeleted: false,
				dbDeleted: false,
				dbSkippedReason: "repository-managed",
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

		// Step 3: Delete from database — guarded, so a row a repository sync
		// adopted between the read above and here survives (design
		// 2026-09-23 §4.3, §6). The points of that row are gone by now, so
		// the guarded delete leaves it unindexed and it is re-embedded.
		const removed = await deleteUnmanagedContextRow({
			contextId,
			projectId,
			// Scoped by organization only when the row carries one (checked
			// equal above); a null-organization row is scoped by project.
			...(tenantOrganizationId !== undefined &&
			context.organizationId !== null
				? { organizationId: tenantOrganizationId }
				: {}),
		});

		if (removed.status === "deleted" || removed.status === "absent") {
			dbDeleted = removed.status === "deleted";
			activityLogger.info(
				dbDeleted
					? "Context deleted successfully"
					: "Context row already deleted",
				{ contextId, qdrantDeleted, dbDeleted },
			);
			return {
				success: true,
				qdrantDeleted,
				dbDeleted,
			};
		}

		activityLogger.warn(
			"Context row survived its guarded delete; kept and queued for re-indexing",
			{ contextId, projectId, reason: removed.status },
		);
		const reembedRequested = await requestReembed(removed.context, userId);
		return removed.status === "repository-managed"
			? {
					success: true,
					qdrantDeleted,
					dbDeleted: false,
					dbSkippedReason: "repository-managed",
					reembedRequested,
				}
			: {
					success: false,
					error: "Context changed during deletion; it was kept",
					qdrantDeleted,
					dbDeleted: false,
					dbSkippedReason: "changed",
					reembedRequested,
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

/**
 * Ask for a re-embed of a row the guarded delete kept after its points were
 * removed. Its `embeddedAt` is already NULL — the durable obligation a later
 * re-embed or repository sync run picks up — so a failed start is logged,
 * not thrown: the deletion workflow is finishing either way.
 */
async function requestReembed(
	context: {
		id: string;
		projectId: string;
		organizationId: string | null;
		sourcePath: string | null;
		title: string;
	},
	userId: string,
): Promise<boolean> {
	if (context.sourcePath === null || context.organizationId === null) {
		// Only a synced file (a path) in an organization can be managed or
		// adopted; anything else has no embedding start of this shape.
		activityLogger.warn("Kept context has no re-embed target", {
			contextId: context.id,
		});
		return false;
	}
	try {
		const client = await getTemporalClient();
		await startContextEmbeddingWorkflow(client, {
			contextId: context.id,
			projectId: context.projectId,
			userId,
			organizationId: context.organizationId,
			sourcePath: context.sourcePath,
			title: context.title,
			reembed: true,
		});
		return true;
	} catch (error) {
		activityLogger.warn("Could not start re-embedding of a kept context", {
			contextId: context.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
