/**
 * Activities for Project Soft Delete and Permanent Deletion
 *
 * These activities support:
 * - Manual permanent deletion (user-triggered via workflow)
 * - Scheduled cleanup (automatic deletion after 7-day retention)
 * - Deletion reminder emails (sent 24-48 hours before permanent deletion)
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "@repo/config";
import {
	db,
	getProjectsNeedingDeletionReminder,
	getProjectsReadyForPermanentDeletion,
	markDeletionReminderSent,
	permanentDeleteProject,
} from "@repo/database";
import { logger } from "@repo/logs";
import { withProviderBreaker } from "@repo/observability";
import {
	collectionExistsUncached,
	getCollectionName,
	PROJECT_CONTEXTS_BASE_COLLECTION,
} from "@repo/rag/lib/collection-manager";
import { deleteObjects, listObjects } from "@repo/storage";
import { heartbeat } from "@temporalio/activity";
import { Resend } from "resend";

const qdrant = new QdrantClient({
	url: process.env.QDRANT_URL || "http://localhost:6333",
	apiKey: process.env.QDRANT_API_KEY,
});

// ============================================================================
// Types
// ============================================================================

export interface DeleteProjectFromQdrantInput {
	projectId: string;
	organizationId?: string;
}

export interface DeleteProjectFromQdrantOutput {
	success: boolean;
	error?: string;
}

export interface PermanentDeleteProjectFromDbInput {
	projectId: string;
}

export interface PermanentDeleteProjectFromDbOutput {
	success: boolean;
	error?: string;
}

export interface DeleteProjectAttachmentsFromStorageInput {
	projectId: string;
}

export interface DeleteProjectAttachmentsFromStorageOutput {
	deleted: number;
	pages: number;
}

export interface CaptureProjectDocumentIdsInput {
	projectId: string;
}

export interface CaptureProjectDocumentIdsOutput {
	documentIds: string[];
}

export interface DeleteProjectDocumentBlobsFromStorageInput {
	projectId: string;
	documentIds: string[];
}

export interface DeleteProjectDocumentBlobsFromStorageOutput {
	deleted: number;
	pages: number;
}

export interface GetExpiredProjectsInput {
	batchSize?: number;
}

export interface ExpiredProject {
	id: string;
	name: string;
	userId: string;
	organizationId: string | null;
}

export interface SendProjectDeletionReminderInput {
	projectId: string;
	projectName: string;
	userEmail: string;
	userName?: string;
	userId: string;
	organizationId?: string;
	deletionDate: Date;
}

export interface SendProjectDeletionReminderOutput {
	sent: boolean;
	error?: string;
}

export interface ProjectNeedingReminder {
	id: string;
	name: string;
	userId: string;
	organizationId: string | null;
	scheduledPermanentDeleteAt: Date;
	userEmail: string;
	userName: string | null;
}

// ============================================================================
// Activities
// ============================================================================

/**
 * Delete all project contexts from Qdrant
 *
 * Shared activity used by both:
 * - Manual permanent delete workflow
 * - Scheduled cleanup workflow
 */
export async function deleteProjectFromQdrantActivity(
	input: DeleteProjectFromQdrantInput,
): Promise<DeleteProjectFromQdrantOutput> {
	const { projectId, organizationId } = input;

	// Resolve the collection that actually holds this tenant's vectors — an
	// organization's project contexts are written to a dedicated collection,
	// not to the personal one.
	const collectionName = getCollectionName(
		PROJECT_CONTEXTS_BASE_COLLECTION,
		organizationId,
	);

	logger.info(
		`[ProjectDeletion] Deleting Qdrant vectors for project ${projectId} from collection ${collectionName}`,
	);

	// A collection that was never created is a success, not a failure:
	// per-organization collections are created lazily on first write, so an
	// organization that never embedded a project context legitimately has none.
	// Failing here would stall project deletion — and the scheduled 7-day
	// cleanup behind it — on exactly the projects with nothing to delete.
	if (!(await collectionExistsUncached(collectionName))) {
		logger.info(
			`[ProjectDeletion] Collection ${collectionName} does not exist — no vectors to delete for project ${projectId}`,
		);
		return { success: true };
	}

	// Both filter keys are indexed payload fields on the project-contexts
	// collection; Qdrant rejects delete-by-filter on an unindexed key with 400.
	const filter: {
		must: Array<{ key: string; match: { value: string } }>;
	} = {
		must: [
			{
				key: "projectId",
				match: { value: projectId },
			},
		],
	};

	if (organizationId) {
		filter.must.push({
			key: "organizationId",
			match: { value: organizationId },
		});
	}

	try {
		// Delete all points matching the filter
		await qdrant.delete(collectionName, {
			wait: true,
			filter,
		});

		logger.info(
			`[ProjectDeletion] Deleted Qdrant vectors for project ${projectId} from collection ${collectionName}`,
		);

		return { success: true };
	} catch (error) {
		const errorMsg =
			error instanceof Error ? error.message : "Unknown error";

		// The collection was confirmed to exist immediately above, so nothing
		// reaching here is a "nothing to delete" — a not-found message no
		// longer earns a success. Every failure is surfaced so Temporal
		// retries; if the collection really was dropped in between, the retry's
		// existence check reports success without touching the vector store.
		logger.error(
			`[ProjectDeletion] Failed deleting Qdrant vectors for project ${projectId} from collection ${collectionName}: ${errorMsg}`,
		);
		throw error;
	}
}

/**
 * Permanently delete a project from PostgreSQL (hard delete)
 *
 * Shared activity used by both:
 * - Manual permanent delete workflow
 * - Scheduled cleanup workflow
 *
 * Note: This deletes the project and all related data via cascade.
 */
export async function permanentDeleteProjectFromDbActivity(
	input: PermanentDeleteProjectFromDbInput,
): Promise<PermanentDeleteProjectFromDbOutput> {
	const { projectId } = input;

	logger.info(
		`[ProjectDeletion] Permanently deleting project ${projectId} from database`,
	);

	try {
		await permanentDeleteProject(projectId);

		logger.info(
			`[ProjectDeletion] Permanently deleted project ${projectId} from database`,
		);

		return { success: true };
	} catch (error) {
		const errorMsg =
			error instanceof Error ? error.message : "Unknown error";

		// Distinguish between "project not found/already deleted" and transient DB failures
		// Prisma P2025 means record not found - that's OK, goal is achieved
		const isNotFoundError =
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "P2025";

		if (isNotFoundError) {
			logger.info(
				`[ProjectDeletion] Project ${projectId} not found (already deleted or restored)`,
			);
			return { success: true };
		}

		// Transient failures (connection issues, deadlocks, etc.) should throw
		// so Temporal can retry the activity
		logger.error(
			`[ProjectDeletion] Transient failure deleting project ${projectId}: ${errorMsg}`,
		);
		throw error;
	}
}

/**
 * Get projects ready for permanent deletion
 *
 * Returns projects where scheduledPermanentDeleteAt <= now
 */
export async function getExpiredProjectsActivity(
	input: GetExpiredProjectsInput,
): Promise<ExpiredProject[]> {
	const { batchSize = 100 } = input;

	logger.info(
		`[ProjectDeletion] Fetching expired projects (batch size: ${batchSize})`,
	);

	try {
		const projects = await getProjectsReadyForPermanentDeletion(batchSize);

		logger.info(
			`[ProjectDeletion] Found ${projects.length} expired projects ready for deletion`,
		);

		return projects;
	} catch (error) {
		const errorMsg =
			error instanceof Error ? error.message : "Unknown error";
		logger.error(
			`[ProjectDeletion] Failed to fetch expired projects: ${errorMsg}`,
		);

		// Re-throw to allow Temporal to retry on transient DB failures
		// This ensures operators can detect systemic issues with the expiration query
		throw error;
	}
}

/**
 * Get projects that need a deletion reminder
 *
 * Returns projects expiring within 24-48 hours that haven't received a reminder
 */
export async function getProjectsNeedingReminderActivity(input: {
	batchSize?: number;
}): Promise<ProjectNeedingReminder[]> {
	const { batchSize = 100 } = input;

	logger.info(
		`[ProjectDeletion] Fetching projects needing deletion reminder (batch size: ${batchSize})`,
	);

	try {
		const projects = await getProjectsNeedingDeletionReminder(batchSize);

		logger.info(
			`[ProjectDeletion] Found ${projects.length} projects needing deletion reminder`,
		);

		return projects.map((p) => ({
			id: p.id,
			name: p.name,
			userId: p.userId,
			organizationId: p.organizationId,
			// scheduledPermanentDeleteAt is guaranteed to be set by the query filter
			scheduledPermanentDeleteAt:
				p.scheduledPermanentDeleteAt ?? new Date(),
			userEmail: p.user.email,
			userName: p.user.name,
		}));
	} catch (error) {
		const errorMsg =
			error instanceof Error ? error.message : "Unknown error";
		logger.error(
			`[ProjectDeletion] Failed to fetch projects needing reminder: ${errorMsg}`,
		);

		// Re-throw to allow Temporal to retry on transient DB failures
		// This ensures operators can detect when reminders are failing to send
		throw error;
	}
}

/**
 * Send deletion reminder email
 *
 * Sends an email to the project owner warning them that their project
 * will be permanently deleted soon.
 */
export async function sendProjectDeletionReminderActivity(
	input: SendProjectDeletionReminderInput,
): Promise<SendProjectDeletionReminderOutput> {
	const { projectId, projectName, userEmail, userName, deletionDate } = input;

	logger.info(
		`[ProjectDeletion] Sending deletion reminder for project ${projectId} to ${userEmail}`,
	);

	try {
		// Format deletion date with full datetime (toLocaleString, not toLocaleDateString)
		const formattedDate = deletionDate.toLocaleString("en-US", {
			weekday: "long",
			year: "numeric",
			month: "long",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
			timeZoneName: "short",
		});

		// Create a simple HTML email
		const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Project Deletion Reminder</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Project Deletion Reminder</h1>
  </div>

  <div style="background: #f9fafb; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 10px 10px;">
    <p>Hi${userName ? ` ${userName}` : ""},</p>

    <p>This is a reminder that your project <strong>"${projectName}"</strong> is scheduled to be permanently deleted on:</p>

    <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 15px; margin: 20px 0;">
      <p style="margin: 0; color: #991b1b; font-weight: 600;">
        🗓️ ${formattedDate}
      </p>
    </div>

    <p>Once deleted, this action cannot be undone. All project data, documents, and contexts will be permanently removed.</p>

    <div style="margin: 25px 0;">
      <p><strong>Want to keep this project?</strong></p>
      <p>Log in to Fabric and restore your project from the "Deleted" tab before the scheduled deletion date.</p>
    </div>

    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 25px 0;">

    <p style="color: #6b7280; font-size: 14px;">
      This is an automated message from Fabric. If you have any questions, please contact support.
    </p>
  </div>
</body>
</html>
`;

		// Send the email using Resend
		const resendApiKey = process.env.RESEND_API_KEY;
		if (!resendApiKey) {
			logger.warn(
				"[ProjectDeletion] RESEND_API_KEY not set, skipping email",
			);
			return { sent: false, error: "Email service not configured" };
		}

		const resend = new Resend(resendApiKey);
		const fromEmail = config.mails.from;

		await withProviderBreaker("resend", "email_send", () =>
			resend.emails.send({
				from: fromEmail,
				to: [userEmail],
				subject: `⚠️ Project "${projectName}" will be deleted soon`,
				html: emailHtml,
			}),
		);

		// Mark reminder as sent
		await markDeletionReminderSent(projectId);

		logger.info(
			`[ProjectDeletion] Sent deletion reminder for project ${projectId}`,
		);

		return { sent: true };
	} catch (error) {
		const errorMsg =
			error instanceof Error ? error.message : "Unknown error";
		logger.error(
			`[ProjectDeletion] Failed to send deletion reminder for project ${projectId}: ${errorMsg}`,
		);

		return { sent: false, error: errorMsg };
	}
}

const ATTACHMENT_FINAL_PREFIX = "story-attachments/";
/** Infinite-loop guard only — NOT a silent partial cap; exceeding it throws so
 * a pathological prefix surfaces as a failure (and Temporal retries) rather
 * than a silently incomplete cleanup. */
const ATTACHMENT_PAGE_SANITY_LIMIT = 10_000;

/** Heartbeat that is a no-op outside an activity context (unit tests). */
function safeAttachmentHeartbeat(): void {
	try {
		heartbeat();
	} catch {
		// not running inside a Temporal activity
	}
}

/**
 * Best-effort-but-durable cleanup of a permanently-deleted project's attachment
 * objects. Lists everything under `story-attachments/{projectId}/` and
 * batch-deletes it, paging until the prefix is exhausted (NO silent deletion
 * cap — the project row is already gone, so a cap would strand objects with no
 * discoverable retry). Idempotent: re-running deletes whatever remains.
 *
 * Throws on a systemic `listObjects` failure or if any `deleteObjects` errors
 * remain after the full pass, so Temporal retries the whole activity. The
 * workflow swallows the final (post-retry) failure and logs it — the project is
 * deleted regardless.
 */
export async function deleteProjectAttachmentsFromStorageActivity(
	input: DeleteProjectAttachmentsFromStorageInput,
): Promise<DeleteProjectAttachmentsFromStorageOutput> {
	const { projectId } = input;

	// Restore-race guard: this runs AFTER permanentDeleteProjectFromDbActivity,
	// which returns success on Prisma P2025 — which ALSO fires when the guarded
	// delete missed because a restore cleared `deletedAt`. If the project row
	// still exists, it was restored: skip (deleting its prefix would wipe a live
	// project's attachments).
	const stillExists = await db.project.findUnique({
		where: { id: projectId },
		select: { id: true },
	});
	if (stillExists) {
		logger.info(
			`[ProjectDeletion] Project ${projectId} still exists (restored) — skipping attachment cleanup`,
		);
		return { deleted: 0, pages: 0 };
	}

	const bucket = config.storage.bucketNames.projectContexts;
	const prefix = `${ATTACHMENT_FINAL_PREFIX}${projectId}/`;

	let deleted = 0;
	let pages = 0;
	const errors: { key: string; message: string }[] = [];
	let continuationToken: string | undefined;

	while (true) {
		if (pages >= ATTACHMENT_PAGE_SANITY_LIMIT) {
			throw new Error(
				`[ProjectDeletion] attachment cleanup exceeded ${ATTACHMENT_PAGE_SANITY_LIMIT} pages for project ${projectId}`,
			);
		}
		const page = await listObjects({
			bucket,
			prefix,
			continuationToken,
			maxKeys: 1000,
		});
		pages += 1;

		const keys = page.objects.map((o) => o.key);
		if (keys.length > 0) {
			const res = await deleteObjects(keys, { bucket });
			deleted += res.deleted;
			errors.push(...res.errors);
		}

		safeAttachmentHeartbeat();

		if (!page.nextContinuationToken) {
			break;
		}
		continuationToken = page.nextContinuationToken;
	}

	if (errors.length > 0) {
		logger.error(
			`[ProjectDeletion] attachment cleanup left ${errors.length} object(s) for project ${projectId}; sample: ${errors
				.slice(0, 5)
				.map((e) => `${e.key}: ${e.message}`)
				.join("; ")}`,
		);
		throw new Error(
			`[ProjectDeletion] attachment cleanup failed for ${errors.length} object(s) (project ${projectId})`,
		);
	}

	logger.info(
		`[ProjectDeletion] Deleted ${deleted} attachment object(s) for project ${projectId} across ${pages} page(s)`,
	);
	return { deleted, pages };
}

/** Storage prefix for project-document assets (keyed by document id). */
const PROJECT_DOCUMENT_PREFIX = "projectDocuments/";

/**
 * Capture the project's `ProjectDocument` ids BEFORE the DB cascade deletes
 * them (SOC 2 C1.2). Document assets live under
 * `projectDocuments/{documentId}/{assetId}/...` in the
 * `projectDocumentAssets` bucket — keyed by DOCUMENT id, not project id — so the
 * `story-attachments/{projectId}/` prefix sweep never touches them and the ids
 * must be recorded while the rows still exist.
 * `deleteProjectDocumentBlobsFromStorageActivity` deletes the objects after the
 * DB delete using these ids.
 */
export async function captureProjectDocumentIdsActivity(
	input: CaptureProjectDocumentIdsInput,
): Promise<CaptureProjectDocumentIdsOutput> {
	const docs = await db.projectDocument.findMany({
		where: { projectId: input.projectId },
		select: { id: true },
	});
	return { documentIds: docs.map((d) => d.id) };
}

/**
 * Delete the storage objects for a project's documents. Runs AFTER the DB
 * delete, using the ids captured before the cascade. Restore-race safe (mirrors
 * the attachment activity): if the project row still exists — it was restored —
 * skip. Throws on any residual delete error so Temporal retries; the project row
 * is already gone, so a failure only orphans objects, never blocks the delete.
 */
export async function deleteProjectDocumentBlobsFromStorageActivity(
	input: DeleteProjectDocumentBlobsFromStorageInput,
): Promise<DeleteProjectDocumentBlobsFromStorageOutput> {
	const { projectId, documentIds } = input;
	if (documentIds.length === 0) {
		return { deleted: 0, pages: 0 };
	}

	const stillExists = await db.project.findUnique({
		where: { id: projectId },
		select: { id: true },
	});
	if (stillExists) {
		logger.info(
			`[ProjectDeletion] Project ${projectId} still exists (restored) — skipping document blob cleanup`,
		);
		return { deleted: 0, pages: 0 };
	}

	const bucket = config.storage.bucketNames.projectDocumentAssets;
	let deleted = 0;
	let pages = 0;
	const errors: { key: string; message: string }[] = [];

	for (const documentId of documentIds) {
		const prefix = `${PROJECT_DOCUMENT_PREFIX}${documentId}/`;
		let continuationToken: string | undefined;
		while (true) {
			if (pages >= ATTACHMENT_PAGE_SANITY_LIMIT) {
				throw new Error(
					`[ProjectDeletion] document blob cleanup exceeded ${ATTACHMENT_PAGE_SANITY_LIMIT} pages for project ${projectId}`,
				);
			}
			const page = await listObjects({
				bucket,
				prefix,
				continuationToken,
				maxKeys: 1000,
			});
			pages += 1;

			const keys = page.objects.map((o) => o.key);
			if (keys.length > 0) {
				const res = await deleteObjects(keys, { bucket });
				deleted += res.deleted;
				errors.push(...res.errors);
			}

			safeAttachmentHeartbeat();

			if (!page.nextContinuationToken) {
				break;
			}
			continuationToken = page.nextContinuationToken;
		}
	}

	if (errors.length > 0) {
		logger.error(
			`[ProjectDeletion] document blob cleanup left ${errors.length} object(s) for project ${projectId}; sample: ${errors
				.slice(0, 5)
				.map((e) => `${e.key}: ${e.message}`)
				.join("; ")}`,
		);
		throw new Error(
			`[ProjectDeletion] document blob cleanup failed for ${errors.length} object(s) (project ${projectId})`,
		);
	}

	logger.info(
		`[ProjectDeletion] Deleted ${deleted} document object(s) for project ${projectId} across ${pages} page(s) for ${documentIds.length} document(s)`,
	);
	return { deleted, pages };
}
