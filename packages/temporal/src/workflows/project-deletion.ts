/**
 * Workflows for Project Soft Delete and Permanent Deletion
 *
 * Two workflows:
 * 1. projectPermanentDeleteWorkflow - Called for manual permanent delete by user
 * 2. projectDeleteCleanupWorkflow - Scheduled daily to clean up expired projects
 *
 * Both workflows share the same activities for Qdrant and DB deletion.
 */

import {
	ApplicationFailure,
	log,
	patched,
	proxyActivities,
} from "@temporalio/workflow";
import type * as activities from "../activities";

// Configure activities with retry policies
const {
	deleteProjectFromQdrantActivity,
	permanentDeleteProjectFromDbActivity,
	captureProjectDocumentIdsActivity,
	getExpiredProjectsActivity,
	getProjectsNeedingReminderActivity,
	sendProjectDeletionReminderActivity,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "5m",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
		maximumInterval: "1m",
	},
});

// Attachment storage cleanup gets MORE retries than the default (the project
// row is already gone, so we want durable transient recovery before giving up).
const {
	deleteProjectAttachmentsFromStorageActivity,
	deleteProjectDocumentBlobsFromStorageActivity,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "10m",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 10,
		maximumInterval: "2m",
	},
});

// ============================================================================
// Types
// ============================================================================

export interface ProjectPermanentDeleteWorkflowInput {
	/** The project to permanently delete */
	projectId: string;
	/** The user who initiated the delete (for audit) */
	userId: string;
	/** Organization context (if org project) */
	organizationId?: string;
}

export interface ProjectPermanentDeleteWorkflowOutput {
	/** Whether the permanent delete completed successfully */
	success: boolean;
	/** The deleted project ID */
	projectId: string;
	/** Whether Qdrant vectors were deleted */
	qdrantDeleted: boolean;
	/** Whether DB record was deleted */
	dbDeleted: boolean;
	/** Any error message */
	error?: string;
	/** Duration of the workflow in milliseconds */
	durationMs: number;
}

export interface ProjectDeleteCleanupWorkflowInput {
	/** Maximum number of projects to process in one run */
	batchSize?: number;
}

export interface ProjectDeleteCleanupWorkflowOutput {
	/** Whether the cleanup completed successfully */
	success: boolean;
	/** Number of reminder emails sent */
	remindersSent: number;
	/** Number of projects permanently deleted */
	projectsDeleted: number;
	/** IDs of projects that failed to delete */
	failedProjectIds: string[];
	/** Duration of the workflow in milliseconds */
	durationMs: number;
}

// ============================================================================
// Workflow: Manual Permanent Delete
// ============================================================================

/**
 * Permanently delete a project (manual user action)
 *
 * This workflow is triggered when a user clicks "Delete Permanently" on a
 * soft-deleted project. It:
 * 1. Deletes all project vectors from Qdrant
 * 2. Hard deletes the project from PostgreSQL (cascades to related data)
 */
export async function projectPermanentDeleteWorkflow(
	input: ProjectPermanentDeleteWorkflowInput,
): Promise<ProjectPermanentDeleteWorkflowOutput> {
	const startTime = Date.now();
	const { projectId, userId, organizationId } = input;

	log.info("Starting project permanent delete workflow", {
		projectId,
		userId,
		organizationId,
	});

	let qdrantDeleted = false;
	let dbDeleted = false;

	try {
		// Step 1: Hard delete from PostgreSQL FIRST
		// This has a soft-delete guard (deletedAt must be set) to prevent race condition
		// where user restores a project after cleanup workflow fetches it
		log.info("Step 1: Permanently deleting project from database", {
			projectId,
		});

		// Step 0: capture ProjectDocument ids BEFORE the cascade — their blobs are
		// keyed by document id in a separate bucket, so the ids must be recorded
		// while the rows exist and the objects purged after (SOC 2 C1.2). Gated
		// for replay determinism.
		let documentIds: string[] = [];
		if (patched("project-document-blob-cleanup-on-delete")) {
			documentIds = (
				await captureProjectDocumentIdsActivity({ projectId })
			).documentIds;
		}

		const dbResult = await permanentDeleteProjectFromDbActivity({
			projectId,
		});

		dbDeleted = dbResult.success;
		if (!dbResult.success) {
			// If DB delete fails (project was restored or already deleted), skip Qdrant
			// This prevents deleting vectors for a restored project
			log.info("DB delete skipped or failed, skipping Qdrant deletion", {
				projectId,
				error: dbResult.error,
			});
			throw new Error(dbResult.error || "Failed to delete from database");
		}

		// Step 2: Delete from Qdrant (only after DB delete succeeds)
		// This order prevents the race condition where a restored project loses its vectors
		log.info("Step 2: Deleting project vectors from Qdrant", { projectId });

		const qdrantResult = await deleteProjectFromQdrantActivity({
			projectId,
			organizationId,
		});

		qdrantDeleted = qdrantResult.success;
		if (!qdrantResult.success) {
			// Escalated to error (SOC 2 C1.2): the DB row is gone but vectors are
			// orphaned with no automatic recovery — surface durably for alerting /
			// manual cleanup. The DB-delete-first ordering is deliberate, unchanged.
			log.error(
				"Qdrant deletion failed — project vectors ORPHANED, manual cleanup required",
				{
					projectId,
					organizationId,
					event: "project.deletion.qdrant_orphaned",
					error: qdrantResult.error,
				},
			);
		}

		// Step 3: Best-effort attachment object cleanup (gated for replay determinism).
		if (patched("attachment-r2-cleanup-on-project-delete")) {
			try {
				await deleteProjectAttachmentsFromStorageActivity({
					projectId,
				});
			} catch (err) {
				// Activity exhausted its retries. The project IS deleted — do NOT fail
				// the workflow. Log loudly so the orphaned prefix is actionable.
				log.error(
					"Attachment storage cleanup failed after retries (objects orphaned)",
					{
						projectId,
						error: err instanceof Error ? err.message : String(err),
					},
				);
			}
		}

		// Step 4: Best-effort document-blob cleanup (gated for replay determinism).
		if (
			patched("project-document-blob-cleanup-on-delete") &&
			documentIds.length > 0
		) {
			try {
				await deleteProjectDocumentBlobsFromStorageActivity({
					projectId,
					documentIds,
				});
			} catch (err) {
				log.error(
					"Document blob cleanup failed after retries (objects orphaned)",
					{
						projectId,
						error: err instanceof Error ? err.message : String(err),
					},
				);
			}
		}

		const durationMs = Date.now() - startTime;

		log.info("Project permanent delete completed successfully", {
			projectId,
			qdrantDeleted,
			dbDeleted,
			durationMs,
		});

		return {
			success: true,
			projectId,
			qdrantDeleted,
			dbDeleted,
			durationMs,
		};
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		const durationMs = Date.now() - startTime;
		const errorMsg =
			error instanceof Error ? error.message : "Unknown error";

		log.error("Project permanent delete failed", {
			projectId,
			error: errorMsg,
			qdrantDeleted,
			dbDeleted,
			durationMs,
		});

		throw ApplicationFailure.nonRetryable(
			errorMsg,
			"PROJECT_DELETION_FAILED",
		);
	}
}

// ============================================================================
// Workflow: Scheduled Cleanup
// ============================================================================

/**
 * Scheduled cleanup workflow for soft-deleted projects
 *
 * This workflow runs daily (typically at 3 AM) via Temporal Schedule and:
 * 1. Sends reminder emails for projects expiring in ~24 hours
 * 2. Permanently deletes projects past their retention period
 *
 * Each project is processed independently so failures don't block others.
 */
export async function projectDeleteCleanupWorkflow(
	input: ProjectDeleteCleanupWorkflowInput = {},
): Promise<ProjectDeleteCleanupWorkflowOutput> {
	const startTime = Date.now();
	const { batchSize = 100 } = input;

	log.info("Starting project delete cleanup workflow", { batchSize });

	let remindersSent = 0;
	let projectsDeleted = 0;
	const failedProjectIds: string[] = [];

	try {
		// Step 1: Send reminder emails for projects expiring soon
		log.info("Step 1: Processing deletion reminders");

		const projectsNeedingReminder =
			await getProjectsNeedingReminderActivity({
				batchSize,
			});

		log.info(
			`Found ${projectsNeedingReminder.length} projects needing reminder`,
		);

		for (const project of projectsNeedingReminder) {
			try {
				const result = await sendProjectDeletionReminderActivity({
					projectId: project.id,
					projectName: project.name,
					userEmail: project.userEmail,
					userName: project.userName ?? undefined,
					userId: project.userId,
					organizationId: project.organizationId ?? undefined,
					deletionDate: project.scheduledPermanentDeleteAt,
				});

				if (result.sent) {
					remindersSent++;
					log.info(
						`Sent deletion reminder for project ${project.id}`,
					);
				} else {
					log.warn(
						`Failed to send reminder for project ${project.id}`,
						{
							error: result.error,
						},
					);
				}
			} catch (error) {
				log.error(`Error sending reminder for project ${project.id}`, {
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				});
			}
		}

		// Step 2: Permanently delete expired projects
		log.info("Step 2: Processing expired projects");

		const expiredProjects = await getExpiredProjectsActivity({ batchSize });

		log.info(`Found ${expiredProjects.length} expired projects to delete`);

		for (const project of expiredProjects) {
			try {
				// Capture ProjectDocument ids BEFORE the cascade (SOC 2 C1.2), gated
				// for replay determinism.
				let documentIds: string[] = [];
				if (patched("project-document-blob-cleanup-on-delete")) {
					documentIds = (
						await captureProjectDocumentIdsActivity({
							projectId: project.id,
						})
					).documentIds;
				}

				// Delete from database FIRST (has soft-delete guard to prevent race condition)
				// If user restored the project after we fetched expired list, this will fail
				const dbResult = await permanentDeleteProjectFromDbActivity({
					projectId: project.id,
				});

				if (!dbResult.success) {
					// Project may have been restored or already deleted - skip Qdrant
					log.info(
						`DB delete skipped for project ${project.id} (may have been restored)`,
						{
							error: dbResult.error,
						},
					);
					// Don't count as failure - project was likely restored by user
					continue;
				}

				// Delete from Qdrant only AFTER DB delete succeeds
				// This prevents deleting vectors for a restored project
				const qdrantResult = await deleteProjectFromQdrantActivity({
					projectId: project.id,
					organizationId: project.organizationId ?? undefined,
				});

				if (!qdrantResult.success) {
					// Escalated to error (SOC 2 C1.2): vectors orphaned, no auto-recovery.
					log.error(
						`Qdrant deletion failed for project ${project.id} — vectors ORPHANED, manual cleanup required`,
						{
							event: "project.deletion.qdrant_orphaned",
							projectId: project.id,
							error: qdrantResult.error,
						},
					);
				}

				// Best-effort attachment object cleanup (gated for replay determinism).
				if (patched("attachment-r2-cleanup-on-project-delete")) {
					try {
						await deleteProjectAttachmentsFromStorageActivity({
							projectId: project.id,
						});
					} catch (err) {
						log.error(
							`Attachment storage cleanup failed after retries for project ${project.id} (objects orphaned)`,
							{
								error:
									err instanceof Error
										? err.message
										: String(err),
							},
						);
					}
				}

				// Best-effort document-blob cleanup (gated for replay determinism).
				if (
					patched("project-document-blob-cleanup-on-delete") &&
					documentIds.length > 0
				) {
					try {
						await deleteProjectDocumentBlobsFromStorageActivity({
							projectId: project.id,
							documentIds,
						});
					} catch (err) {
						log.error(
							`Document blob cleanup failed after retries for project ${project.id} (objects orphaned)`,
							{
								error:
									err instanceof Error
										? err.message
										: String(err),
							},
						);
					}
				}

				projectsDeleted++;
				log.info(
					`Permanently deleted project ${project.id} (${project.name})`,
				);
			} catch (error) {
				failedProjectIds.push(project.id);
				log.error(`Error deleting project ${project.id}`, {
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				});
			}
		}

		const durationMs = Date.now() - startTime;
		const success = failedProjectIds.length === 0;

		if (success) {
			log.info("Project delete cleanup completed successfully", {
				remindersSent,
				projectsDeleted,
				durationMs,
			});
		} else {
			log.warn("Project delete cleanup completed with some failures", {
				remindersSent,
				projectsDeleted,
				failedCount: failedProjectIds.length,
				failedProjectIds,
				durationMs,
			});
		}

		return {
			success,
			remindersSent,
			projectsDeleted,
			failedProjectIds,
			durationMs,
		};
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		const durationMs = Date.now() - startTime;
		const errorMsg =
			error instanceof Error ? error.message : "Unknown error";

		log.error("Project delete cleanup workflow failed", {
			error: errorMsg,
			remindersSent,
			projectsDeleted,
			durationMs,
		});

		throw ApplicationFailure.nonRetryable(
			errorMsg,
			"PROJECT_DELETION_FAILED",
		);
	}
}
