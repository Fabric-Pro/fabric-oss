/**
 * Attachment final-orphan reconciliation sweep activity.
 *
 * Reclaims R2 objects under the FINAL prefix `story-attachments/` that have no
 * owning StoryAttachment row (orphans), older than
 * FABRIC_ATTACHMENT_FINAL_ORPHAN_MAX_AGE_HOURS (default 24) + a 1h safety
 * margin. The final-prefix sibling of the temp-orphan sweep (#1747); closes the
 * deferred residual F2 from #1755 and reclaims any best-effort object delete
 * that failed on any deletion path. See
 * docs/superpowers/specs/2026-06-28-attachments-final-orphan-sweep-1702-design.md.
 *
 * Safety: an object's key IS its row's unique `storageKey`, and create
 * commits the row BEFORE copying the object (row-before-object), so under
 * read-committed any LIVE attachment's row is visible here — a no-row aged final
 * object is always a true orphan (crash window, failed best-effort delete, or a
 * mid-flight removeAttachment). The 1h margin clears any in-flight upload.
 *
 * Coverage/convergence: scans the ENTIRE prefix each run; MAX_PAGES is
 * only an infinite-loop guard. The destructive budget MAX_DELETIONS counts
 * SUCCESSFUL deletes, so failed deletes never consume budget or stop traversal.
 * Runs with maximumAttempts:1 (see the workflow) so the budget is the true
 * per-execution blast-radius bound and the daily schedule is the retry cadence.
 *
 * This sweep always runs on its configured schedule (schedules.ts) — there is
 * no enablement flag.
 */

import { config } from "@repo/config";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { deleteObjects, listObjects } from "@repo/storage";
import { safeHeartbeat } from "./lib/activity-liveness";

const FINAL_PREFIX = "story-attachments/";

/** Subtracted from the cutoff so the boundary clears any in-flight upload
 * regardless of worker/S3 clock skew. */
const SAFETY_MARGIN_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_AGE_HOURS = 24;
/** Clamp to avoid a Date overflow from an absurd operator value. */
const MAX_MAX_AGE_HOURS = 8_760 * 100; // 100 years
/** Infinite-loop guard, NOT a coverage cap. */
const MAX_PAGES = 100_000;
/** Per-execution destructive bound — counts SUCCESSFUL deletes. */
const MAX_DELETIONS = 2_000;
/** Bounds the logged error sample. */
const MAX_ERRORS = 500;

export interface SweepAttachmentFinalOrphansResult {
	scanned: number;
	keptLive: number;
	deleted: number;
	errorCount: number;
	errorsTruncated: boolean;
	pages: number;
	hitDeletionCap: boolean;
	hitRunawayGuard: boolean;
	cutoffAt: string;
	maxAgeHours: number;
}

/** Read FABRIC_ATTACHMENT_FINAL_ORPHAN_MAX_AGE_HOURS. Unset/NaN/<=0 -> 24. */
function readMaxAgeHours(): number {
	const raw =
		process.env.FABRIC_ATTACHMENT_FINAL_ORPHAN_MAX_AGE_HOURS ??
		String(DEFAULT_MAX_AGE_HOURS);
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_MAX_AGE_HOURS;
	}
	return Math.min(MAX_MAX_AGE_HOURS, parsed);
}

export async function sweepAttachmentFinalOrphansActivity(): Promise<SweepAttachmentFinalOrphansResult> {
	const bucket = config.storage.bucketNames.projectContexts;
	const maxAgeHours = readMaxAgeHours();
	const cutoff = new Date(
		Date.now() - maxAgeHours * 3_600_000 - SAFETY_MARGIN_MS,
	);

	logger.info(
		{
			event: "attachments.final_sweep.started",
			maxAgeHours,
			cutoffAt: cutoff.toISOString(),
		},
		"[AttachmentFinalSweep] Starting sweep run",
	);

	let scanned = 0;
	let keptLive = 0;
	let deleted = 0;
	let failedDeletes = 0;
	let remainingBudget = MAX_DELETIONS;
	let pages = 0;
	let hitDeletionCap = false;
	let hitRunawayGuard = false;
	let errorsTruncated = false;
	const errors: { key: string; message: string }[] = [];
	let continuationToken: string | undefined;

	while (true) {
		if (pages >= MAX_PAGES) {
			hitRunawayGuard = true;
			break;
		}

		let page: Awaited<ReturnType<typeof listObjects>>;
		try {
			page = await listObjects({
				bucket,
				prefix: FINAL_PREFIX,
				maxKeys: 1000,
				continuationToken,
			});
		} catch (err) {
			logger.error(
				{
					event: "attachments.final_sweep.list_error",
					err: err instanceof Error ? err.message : String(err),
				},
				"[AttachmentFinalSweep] listObjects failed — aborting run; recovered next scheduled run",
			);
			throw err;
		}
		pages += 1;

		const agedKeys: string[] = [];
		for (const obj of page.objects) {
			scanned += 1;
			if (obj.lastModified < cutoff) {
				agedKeys.push(obj.key);
			}
		}

		if (agedKeys.length > 0) {
			// Batched ownership lookup: one query per page. A failure
			// aborts the run — a systemic DB error must surface, not
			// silently no-op.
			let rows: { storageKey: string }[];
			try {
				rows = await db.storyAttachment.findMany({
					where: { storageKey: { in: agedKeys } },
					select: { storageKey: true },
				});
			} catch (err) {
				logger.error(
					{
						event: "attachments.final_sweep.lookup_error",
						err: err instanceof Error ? err.message : String(err),
					},
					"[AttachmentFinalSweep] findMany failed — aborting run; recovered next scheduled run",
				);
				throw err;
			}
			const present = new Set(rows.map((r) => r.storageKey));
			const orphanKeys = agedKeys.filter((k) => !present.has(k));
			keptLive += agedKeys.length - orphanKeys.length;

			if (orphanKeys.length > 0) {
				// Slice to the remaining budget so blast radius never exceeds
				// MAX_DELETIONS successful deletes.
				const slice = orphanKeys.slice(0, remainingBudget);
				const res = await deleteObjects(slice, { bucket }); // never throws
				deleted += res.deleted;
				remainingBudget -= res.deleted; // ONLY successes consume budget
				for (const e of res.errors) {
					failedDeletes += 1;
					if (errors.length < MAX_ERRORS) {
						errors.push(e);
					} else {
						errorsTruncated = true;
					}
				}
			}
		}

		safeHeartbeat();

		if (remainingBudget <= 0) {
			hitDeletionCap = true;
			break;
		}
		if (!page.nextContinuationToken) {
			break;
		}
		continuationToken = page.nextContinuationToken;
	}

	if (hitDeletionCap || hitRunawayGuard) {
		logger.warn(
			{
				event: "attachments.final_sweep.safety_cap_hit",
				pages,
				deleted,
				hitDeletionCap,
				hitRunawayGuard,
				maxDeletions: MAX_DELETIONS,
				maxPages: MAX_PAGES,
			},
			"[AttachmentFinalSweep] Safety cap hit; investigate orphan source — remaining handled next run",
		);
	}

	const result: SweepAttachmentFinalOrphansResult = {
		scanned,
		keptLive,
		deleted,
		errorCount: failedDeletes,
		errorsTruncated,
		pages,
		hitDeletionCap,
		hitRunawayGuard,
		cutoffAt: cutoff.toISOString(),
		maxAgeHours,
	};

	logger.info(
		{
			event: "attachments.final_sweep.completed",
			...result,
			// Surface a capped sample of which keys failed to delete.
			errorsSample: errors.slice(0, 10),
		},
		`[AttachmentFinalSweep] Swept ${deleted} orphan final objects (scanned ${scanned}, kept ${keptLive} live)`,
	);

	return result;
}
