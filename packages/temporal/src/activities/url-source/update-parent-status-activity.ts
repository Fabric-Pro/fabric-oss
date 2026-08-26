/**
 * Update Parent ProjectContext Status Activity (URL Context Sources)
 *
 * Single-purpose finalizer. The workflow calls this at the end of every
 * branch (COMPLETED happy path or FAILED catch path) so the UI can
 * transition the LINK card off the EXTRACTING pill.
 *
 * The error path is best-effort by design.
 *
 * Notification side effect: after the parent
 * row is written, on COMPLETED or FAILED terminal status we also insert a
 * `CONTEXT_INDEXING_COMPLETED` notification. CANCELLED is silent.
 * The notification helper lives at `./lib/emit-completion-notification.ts`
 * — co-located with the activity per `fabric/standards/backend/temporal.md`
 * ("side effects live in activities, never in workflow code").
 */
import type { ExtractionStatus } from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { activityLogger } from "../lib/activity-logger";
import { emitCompletionNotification } from "./lib/emit-completion-notification";

export interface UpdateParentStatusActivityInput {
	contextId: string;
	extractionStatus: ExtractionStatus;
	extractionError?: string | null;
	urlLastSyncedAt?: Date | null;
	urlNextRefreshAt?: Date | null;
	/** Single-page content lives directly on the parent row; multi-page leaves it null. */
	content?: string;
	// --- Notification-emit fields. All optional so legacy
	// callers (and any in-flight workflows that started before this code
	// shipped) keep their existing call shapes. When projectId or sourceUrl
	// is missing the notification emit is silently skipped — the row status
	// update still happens unconditionally.
	projectId?: string;
	userId?: string | null;
	organizationId?: string | null;
	sourceUrl?: string;
	pagesIndexed?: number;
}

export interface UpdateParentStatusActivityOutput {
	success: boolean;
}

export async function updateParentStatusActivity(
	input: UpdateParentStatusActivityInput,
): Promise<UpdateParentStatusActivityOutput> {
	const {
		contextId,
		extractionStatus,
		extractionError,
		urlLastSyncedAt,
		urlNextRefreshAt,
		content,
		projectId,
		userId,
		organizationId,
		sourceUrl,
		pagesIndexed,
	} = input;

	activityLogger.info("Update parent status activity start", {
		contextId,
		extractionStatus,
	});

	await db.projectContext.update({
		where: { id: contextId },
		data: {
			extractionStatus,
			extractionError: extractionError ?? null,
			...(urlLastSyncedAt !== undefined ? { urlLastSyncedAt } : {}),
			...(urlNextRefreshAt !== undefined ? { urlNextRefreshAt } : {}),
			...(content !== undefined ? { content } : {}),
			// Clear the in-flight workflowId on every finalize. Set by
			// resync-url-source / process-context-link when starting the
			// crawl; read by cancel-url-source-crawl to look up the handle.
			// We clear unconditionally so a workflow that finalizes via the
			// FAILED branch (or partial-success after cancellation) still
			// frees the slot for the next re-sync.
			urlActiveWorkflowId: null,
		},
	});

	activityLogger.info("Update parent status activity success", {
		contextId,
		extractionStatus,
	});

	// Emit the persistent CONTEXT_INDEXING_COMPLETED notification.
	// The helper is idempotent + dedup-aware (P2002 on
	// the partial unique index coalesces into the existing unread row);
	// CANCELLED is silently skipped. Skip entirely when the caller
	// didn't supply the notification context (e.g., legacy workflow runs).
	if (projectId && sourceUrl) {
		await emitCompletionNotification({
			contextId,
			projectId,
			userId: userId ?? null,
			organizationId: organizationId ?? null,
			sourceUrl,
			extractionStatus,
			pagesIndexed,
			extractionError,
		});
	}

	return { success: true };
}
