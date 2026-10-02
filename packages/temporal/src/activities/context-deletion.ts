/**
 * Context Deletion Activities
 *
 * Activities for deleting project contexts (Notion pages, uploaded files, etc.)
 * from Qdrant and database. Provides durable deletion with retries.
 *
 * Also deletes an organization's company context sources (Fizzy #2719) when
 * the input names a company owner. A missing owner is the project owner,
 * unchanged.
 */

import {
	companyContextStoragePrefix,
	deleteUnmanagedContextRow,
	getContextById,
} from "@repo/database";
import {
	deleteCompanyContextSourcePoints,
	deleteProjectContext,
	deleteUrlSourceChunks,
} from "@repo/rag";
import { deleteFile } from "@repo/storage";
import { getScheduleClient, getTemporalClient } from "../client";
import { startContextEmbeddingWorkflow } from "../lib/context-embedding-start";
import {
	type CompanyContextOwner,
	type ContextOwner,
	resolveContextOwner,
} from "../lib/context-owner";
import { companyContextRowStore } from "../lib/context-row-store";
import { deleteUrlSourceSchedule } from "../schedules/url-source-schedule";
import { activityLogger } from "./lib/activity-logger";

export interface DeleteSingleContextInput {
	contextId: string;
	/** The context's project; absent for a company source. */
	projectId?: string;
	userId: string;
	organizationId?: string;
	qdrantId?: string;
	/** Who owns the row; absent is the project owner (`../lib/context-owner`). */
	owner?: ContextOwner;
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
	const owner = resolveContextOwner(input);
	if (owner.kind === "company") {
		return deleteCompanySource(input.contextId, owner);
	}

	const { contextId, userId, organizationId, qdrantId } = input;
	const { projectId } = owner;

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

/**
 * Delete a company context source (Fizzy #2719): its vectors, then its stored
 * file, then its row — in that order, so a failure at any step leaves the row,
 * and with it every id a retry needs — then its vectors once more, for what
 * an embed in flight wrote meanwhile.
 *
 * A website source first loses its refresh schedule, so it cannot fire again
 * against a source being deleted, and the crawl the row records is
 * cancelled. Both are best-effort and safe to repeat: a schedule or crawl
 * already gone is what the delete needs, and one that could not be stopped
 * does not keep the source. A schedule left behind is removed by the
 * URL-source schedule reconciler once the row is gone; a crawl left running
 * finds its source gone and writes nothing that stays.
 *
 * The vectors are every point whose `originalContextId` is the source — its
 * own chunks and every crawled page's, including those of an embed that
 * stopped partway — in the organization's company collection, resolved by
 * name and never created: an organization that never embedded anything has
 * none, which is a success. The file is deleted only from under the
 * organization's own company-context prefix.
 *
 * Throws on a Qdrant or storage failure so Temporal retries; every step is
 * safe to repeat. A source already gone still has its points removed.
 */
async function deleteCompanySource(
	contextId: string,
	owner: CompanyContextOwner,
): Promise<DeleteSingleContextOutput> {
	const { organizationId } = owner;
	const rows = companyContextRowStore(owner);

	activityLogger.info("Deleting company context source", {
		contextId,
		organizationId,
	});

	const source = await rows.loadSource(contextId);

	if (source?.type === "LINK") {
		await stopCompanySourceCrawls(source);
	}

	const { collectionExists } = await deleteCompanyContextSourcePoints({
		organizationId,
		sourceId: contextId,
	});

	if (!source) {
		activityLogger.info(
			"Company context source not found, may have been deleted already",
			{ contextId },
		);
		return {
			success: true,
			qdrantDeleted: collectionExists,
			dbDeleted: false,
		};
	}

	if (source.s3Path) {
		if (
			source.s3Bucket &&
			source.s3Path.startsWith(
				companyContextStoragePrefix(organizationId),
			)
		) {
			await deleteFile(source.s3Path, { bucket: source.s3Bucket });
		} else {
			// No bucket to address it in, or not a key this organization's
			// company context owns: leave it. Organization deletion sweeps
			// the organization's prefix.
			activityLogger.warn(
				"Company context file has no bucket or is outside its organization's prefix; not deleting it",
				{ contextId },
			);
		}
	}

	const deleted = await rows.deleteSource(contextId);

	// An embed already running when the vectors above were removed can still
	// write points and mark the row embedded before the row delete, leaving
	// them orphaned. Sweep once more now the row is gone (an embed finishing
	// after this finds no row and removes its own points). Retrieval keeps
	// only hits whose source row is ready, so orphans never surface: this is
	// storage hygiene. A failure throws, and the retry takes the row-gone
	// path above, which sweeps again.
	await deleteCompanyContextSourcePoints({
		organizationId,
		sourceId: contextId,
	});

	activityLogger.info(
		deleted
			? "Company context source deleted"
			: "Company context source row already deleted",
		{ contextId, qdrantDeleted: collectionExists },
	);
	return {
		success: true,
		qdrantDeleted: collectionExists,
		dbDeleted: deleted !== null,
	};
}

/**
 * Delete a website source's refresh schedule and cancel the crawl its row
 * records, each best-effort: not-found is success, and any other failure is
 * logged, not thrown, so it never keeps a source its owner deleted.
 */
async function stopCompanySourceCrawls(source: {
	id: string;
	urlScheduleId: string | null;
	urlActiveWorkflowId: string | null;
}): Promise<void> {
	if (source.urlScheduleId) {
		try {
			await deleteUrlSourceSchedule(
				{ scheduleId: source.urlScheduleId },
				await getScheduleClient(),
			);
		} catch (error) {
			activityLogger.warn(
				"Failed to delete a company website source's refresh schedule; the reconciler removes it",
				{
					contextId: source.id,
					scheduleId: source.urlScheduleId,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
		}
	}

	if (source.urlActiveWorkflowId) {
		try {
			const client = await getTemporalClient();
			await client.workflow
				.getHandle(source.urlActiveWorkflowId)
				.cancel();
		} catch (error) {
			// Not found: the crawl already finished.
			if (
				!(
					error instanceof Error &&
					error.name === "WorkflowNotFoundError"
				)
			) {
				activityLogger.warn(
					"Failed to cancel a company website source's crawl",
					{
						contextId: source.id,
						workflowId: source.urlActiveWorkflowId,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
			}
		}
	}
}
