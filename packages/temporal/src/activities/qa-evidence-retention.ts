/**
 * Delete QA run screenshots older than their project's retention window.
 *
 * Before this existed nothing ever deleted run evidence. Storage grew without
 * bound, and deleting a run, a case or a whole project left its objects behind
 * for good — "delete" quietly did not.
 *
 * ## Object first, then the row
 *
 * The one inversion of the system-wide row-before-object rule, matching
 * `attachment-retention-purge`: delete each page's objects, then delete only the
 * rows whose object delete actually succeeded. A row whose delete errored keeps
 * its ledger entry and is retried on the next run, so the sweep can never
 * produce an orphan it has no record of — which is the exact failure the ledger
 * exists to prevent.
 *
 * ## Per-project windows, not one cutoff
 *
 * Each project sets its own `evidenceRetentionDays`, and `0` means keep
 * indefinitely, so "expired" is arithmetic per project rather than a single
 * `capturedAt <` predicate. Projects that have never saved their QA settings
 * have no row at all and take the 90-day default — which is why this resolves
 * windows in code instead of joining. A join would silently skip every project
 * still on defaults, and that is most of them.
 *
 * ## Keyset pagination
 *
 * `id > lastId`, for the reason the attachment purge documents: rows are left
 * behind on purpose when their object delete fails, so deletion cannot be relied
 * on to advance the window, and a Prisma cursor would often point at a row this
 * page just deleted. Comparing values terminates even when an entire page
 * errors.
 */

import {
	countRunEvidence,
	deleteEvidenceRows,
	listEvidencePage,
	resolveRetentionDays,
} from "@repo/database";
import { logger } from "@repo/logs";
import { deleteObjects } from "@repo/storage";
import { isTestCasesEnabled } from "@repo/utils/feature-flag";
import { safeHeartbeat } from "./lib/activity-liveness";

/** What a project gets when it has never saved its QA settings. */
const DEFAULT_RETENTION_DAYS = 90;
const PAGE_SIZE = 500;
/** Runaway guard. Far above any real ledger; a loop bug hits this, not prod. */
const MAX_PAGES = 100_000;
/** Per-run destructive bound, counting confirmed object deletes. */
const MAX_DELETIONS = 2_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PurgeExpiredRunEvidenceResult {
	/** False when the QA feature flag is off — nothing was examined. */
	ran: boolean;
	scanned: number;
	deletedObjects: number;
	deletedRows: number;
	objectErrors: number;
	pages: number;
	hitDeletionCap: boolean;
	hitRunawayGuard: boolean;
	ledgerSize: number;
}

/**
 * Whether one object has outlived its project's window.
 *
 * Exported for its own tests: `0 = keep forever` is the branch that turns a
 * retention sweep into a data-loss incident if it is ever read as "expire
 * immediately".
 */
export function hasExpired(input: {
	capturedAt: Date;
	retentionDays: number;
	now: number;
}): boolean {
	// Zero means keep indefinitely, and a negative value is nonsense that must
	// fail the same safe way rather than making every row instantly expired.
	if (input.retentionDays <= 0) {
		return false;
	}
	return (
		input.now - input.capturedAt.getTime() >
		input.retentionDays * MS_PER_DAY
	);
}

/**
 * Activity: one pass over the evidence ledger.
 *
 * The feature gate lives HERE rather than on the schedule, matching every other
 * sweep in this package: the schedule stays registered, so turning the flag on
 * takes effect on the next tick with no redeploy. With the flag off this returns
 * immediately having examined nothing.
 */
export async function purgeExpiredRunEvidenceActivity(): Promise<PurgeExpiredRunEvidenceResult> {
	const empty: PurgeExpiredRunEvidenceResult = {
		ran: false,
		scanned: 0,
		deletedObjects: 0,
		deletedRows: 0,
		objectErrors: 0,
		pages: 0,
		hitDeletionCap: false,
		hitRunawayGuard: false,
		ledgerSize: 0,
	};
	if (!isTestCasesEnabled()) {
		return empty;
	}

	const now = Date.now();
	let afterId: string | null = null;
	let scanned = 0;
	let deletedObjects = 0;
	let deletedRows = 0;
	let objectErrors = 0;
	let pages = 0;
	let hitDeletionCap = false;
	let hitRunawayGuard = false;

	while (pages < MAX_PAGES) {
		const page = await listEvidencePage({ afterId, limit: PAGE_SIZE });
		if (page.length === 0) {
			break;
		}
		pages++;
		scanned += page.length;
		// Advance on the page's LAST row whatever happens to it below, so a page
		// whose deletes all fail still moves the window rather than looping.
		afterId = page[page.length - 1]?.id ?? afterId;

		const windows = await resolveRetentionDays([
			...new Set(page.map((r) => r.projectId)),
		]);
		const expired = page.filter((row) =>
			hasExpired({
				capturedAt: row.capturedAt,
				retentionDays:
					windows.get(row.projectId) ?? DEFAULT_RETENTION_DAYS,
				now,
			}),
		);
		if (expired.length === 0) {
			await safeHeartbeat({ phase: "qa-evidence-retention", pages });
			continue;
		}

		if (deletedObjects + expired.length > MAX_DELETIONS) {
			hitDeletionCap = true;
			break;
		}

		// Grouped by bucket: `deleteObjects` takes one bucket per call, and the
		// column exists precisely so a bucket rename does not strand old rows.
		const byBucket = new Map<string, typeof expired>();
		for (const row of expired) {
			const list = byBucket.get(row.bucket) ?? [];
			list.push(row);
			byBucket.set(row.bucket, list);
		}

		const confirmed: string[] = [];
		for (const [bucket, rows] of byBucket) {
			const result = await deleteObjects(
				rows.map((r) => r.storageKey),
				{ bucket },
			);
			const failed = new Set(result.errors?.map((e) => e.key) ?? []);
			objectErrors += failed.size;
			// Only rows whose object is positively gone lose their ledger entry.
			// Anything ambiguous keeps its row and is retried next run — a second
			// delete of an absent object is harmless, an untracked object is not.
			for (const row of rows) {
				if (!failed.has(row.storageKey)) {
					confirmed.push(row.id);
					deletedObjects++;
				}
			}
		}

		deletedRows += await deleteEvidenceRows(confirmed);
		await safeHeartbeat({ phase: "qa-evidence-retention", pages });
	}

	if (pages >= MAX_PAGES) {
		hitRunawayGuard = true;
	}

	const result: PurgeExpiredRunEvidenceResult = {
		ran: true,
		scanned,
		deletedObjects,
		deletedRows,
		objectErrors,
		pages,
		hitDeletionCap,
		hitRunawayGuard,
		ledgerSize: await countRunEvidence(),
	};

	// Always logged, including a no-op pass: "the sweep ran and deleted nothing"
	// and "the sweep never ran" look identical in a storage bill, and only one of
	// them is a problem.
	logger.info("qa.evidence_retention.swept", result);
	if (hitDeletionCap || hitRunawayGuard) {
		logger.warn("qa.evidence_retention.bounded", {
			hitDeletionCap,
			hitRunawayGuard,
			deletedObjects,
			pages,
		});
	}
	return result;
}
