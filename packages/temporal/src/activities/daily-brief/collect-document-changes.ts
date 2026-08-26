/**
 * Daily Brief — Document Changes Collector Activity
 *
 * Reads DocumentVersion rows (joined with ProjectDocument for project
 * filtering) that were created inside the given time window. Each version
 * row represents a persisted content change or newly-generated document
 * snapshot.
 *
 * DB-local: no LLM, no external HTTP.
 */

import { type DocumentChangeItem, db } from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";

// =============================================================================
// Types
// =============================================================================

export interface CollectDocumentChangesInput {
	projectId: string;
	organizationId: string | null;
	timeWindowStart: Date | string;
	timeWindowEnd: Date | string;
}

export type CollectDocumentChangesOutput = DocumentChangeItem[];

// =============================================================================
// Activity
// =============================================================================

/**
 * Collect document version events for the Daily Brief.
 *
 * Classification:
 *   - DocumentVersion.version === 1      -> "created"
 *   - DocumentVersion.version > 1        -> "version_added"
 *
 * `kind: "updated"` in the shared schema is reserved for non-versioned edits
 * that may be wired in later; today every persisted change produces a new
 * DocumentVersion, so we map to created/version_added.
 */
export async function collectDocumentChanges(
	input: CollectDocumentChangesInput,
): Promise<CollectDocumentChangesOutput> {
	const { projectId, organizationId } = input;
	const timeWindowStart = new Date(input.timeWindowStart);
	const timeWindowEnd = new Date(input.timeWindowEnd);

	heartbeat("collectDocumentChanges: starting");

	logger.info("[DailyBrief/collectDocumentChanges] Starting", {
		projectId,
		organizationId,
		timeWindowStart: timeWindowStart.toISOString(),
		timeWindowEnd: timeWindowEnd.toISOString(),
	});

	const versions = await db.documentVersion.findMany({
		where: {
			createdAt: { gte: timeWindowStart, lte: timeWindowEnd },
			document: {
				projectId,
				project: { organizationId },
			},
		},
		select: {
			id: true,
			version: true,
			changeDescription: true,
			changedBy: true,
			createdAt: true,
			document: {
				select: {
					id: true,
					title: true,
					type: true,
				},
			},
		},
		orderBy: { createdAt: "desc" },
	});

	const items: DocumentChangeItem[] = versions.map((v) => ({
		kind: v.version <= 1 ? "created" : "version_added",
		occurredAt: v.createdAt,
		title: v.document.title,
		documentCuid: v.document.id,
		documentType: String(v.document.type),
		version: v.version,
		changeDescription: v.changeDescription ?? undefined,
		changedByUserId: v.changedBy ?? undefined,
	}));

	logger.info("[DailyBrief/collectDocumentChanges] Complete", {
		projectId,
		documentChangeCount: items.length,
	});

	return items;
}
