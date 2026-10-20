/**
 * Delete Proposal exports that have outlived their retention window (Fizzy
 * #2946), on a daily schedule.
 *
 * An export is a file someone downloads once, minutes after asking for it;
 * the status read stops handing out download URLs for an export older than
 * the window, so nothing can reach an older file and it is deleted. Every
 * object under `proposal-exports/` is an export (nothing else writes there),
 * so age alone decides; an hour of margin keeps an upload in flight safe
 * from clock skew. Deletion of a whole project's exports is the project
 * deletion sweep's job, not this one's.
 *
 * Runs once per schedule tick (`maximumAttempts: 1`), so the deletion budget
 * is the real bound per run, and the next day's run picks up anything a
 * failed delete or the budget left behind.
 */

import { config } from "@repo/config";
import { logger } from "@repo/logs";
import { deleteObjects, listObjects } from "@repo/storage";
import {
	PROPOSAL_EXPORT_RETENTION_MS,
	PROPOSAL_EXPORT_STORAGE_PREFIX,
} from "../../lib/proposal-export/types";
import { safeHeartbeat } from "../lib/activity-liveness";

/** Clears an upload in flight whatever the worker and storage clocks say. */
const SAFETY_MARGIN_MS = 60 * 60 * 1000;
/** Infinite-loop guard, not a coverage cap. */
const MAX_LIST_PAGES = 10_000;
/** Most objects one run deletes. */
const MAX_DELETIONS = 5_000;

export interface CleanupProposalExportsResult {
	scanned: number;
	deleted: number;
	errorCount: number;
	pages: number;
	hitDeletionCap: boolean;
	cutoffAt: string;
}

export async function cleanupExpiredProposalExportsActivity(): Promise<CleanupProposalExportsResult> {
	const bucket = config.storage.bucketNames.projectContexts;
	const cutoff = new Date(
		Date.now() - PROPOSAL_EXPORT_RETENTION_MS - SAFETY_MARGIN_MS,
	);

	let scanned = 0;
	let deleted = 0;
	let errorCount = 0;
	let pages = 0;
	let hitDeletionCap = false;
	let continuationToken: string | undefined;

	while (pages < MAX_LIST_PAGES) {
		const page = await listObjects({
			bucket,
			prefix: PROPOSAL_EXPORT_STORAGE_PREFIX,
			maxKeys: 1000,
			continuationToken,
		});
		pages += 1;

		const expired: string[] = [];
		for (const object of page.objects) {
			scanned += 1;
			if (object.lastModified < cutoff) {
				expired.push(object.key);
			}
		}
		const allowed = expired.slice(0, MAX_DELETIONS - deleted);
		if (allowed.length < expired.length) {
			hitDeletionCap = true;
		}
		if (allowed.length > 0) {
			const result = await deleteObjects(allowed, { bucket });
			deleted += result.deleted;
			errorCount += result.errors.length;
		}
		safeHeartbeat({ pages, deleted });

		if (hitDeletionCap || !page.nextContinuationToken) {
			break;
		}
		continuationToken = page.nextContinuationToken;
	}

	const result: CleanupProposalExportsResult = {
		scanned,
		deleted,
		errorCount,
		pages,
		hitDeletionCap,
		cutoffAt: cutoff.toISOString(),
	};
	logger.info(
		{ event: "proposal_exports.cleanup.completed", ...result },
		"[ProposalExportCleanup] Sweep finished",
	);
	return result;
}
