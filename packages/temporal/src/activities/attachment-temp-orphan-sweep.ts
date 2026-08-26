/**
 * Attachment temp-orphan sweep activity.
 *
 * Reclaims abandoned `story-attachments-tmp/` objects (uploads that were never
 * promoted to a final `story-attachments/` key) older than
 * FABRIC_ATTACHMENT_TEMP_ORPHAN_MAX_AGE_HOURS (default 24) + a 1h safety
 * margin. See docs/superpowers/specs/2026-06-26-attachments-temp-orphan-sweep-1702-design.md.
 *
 * Safety interlock — never delete bytes still backing an in-flight or
 * broken promotion. For each aged temp we derive the final key and look up the
 * StoryAttachment row:
 *   - no row                        -> delete (abandoned; no promotion in flight)
 *   - row + final object present     -> delete (redundant leftover after success)
 *   - row + final object MISSING     -> skip + warn (recovery bytes; preserve)
 *   - row + HEAD throws (transient)  -> skip this run
 *
 * `findUnique` is by the globally-unique `storageKey`, so no tenant context is
 * needed. Idempotent: re-running deletes whatever is currently past the cutoff.
 *
 * This sweep always runs on its configured schedule (see schedules.ts) — there
 * is no enablement flag. Unset/invalid MAX_AGE_HOURS defaults to 24 (the
 * OPPOSITE of audit-log-retention's opt-in unset->0 short-circuit).
 */

import { config } from "@repo/config";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { deleteFile, getFileMetadata, listObjects } from "@repo/storage";
import { heartbeat } from "@temporalio/activity";

const TEMP_PREFIX = "story-attachments-tmp/";
const FINAL_PREFIX = "story-attachments/";

/** Subtracted from the cutoff so the deletion boundary clears any in-flight
 * upload regardless of worker/S3 clock skew. */
const SAFETY_MARGIN_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_AGE_HOURS = 24;
/** Clamp to avoid a Date overflow from an absurd operator value. */
const MAX_MAX_AGE_HOURS = 8_760 * 100; // 100 years
/** Per-run safety caps. */
const MAX_PAGES = 50;
const MAX_DELETIONS = 2_000;
const MAX_ERRORS = 500;

export interface SweepAttachmentTempOrphansResult {
	scanned: number;
	deleted: number;
	skippedOrphanRows: number;
	errorCount: number;
	errorsTruncated: boolean;
	pages: number;
	hitSafetyCap: boolean;
	cutoffAt: string;
	maxAgeHours: number;
}

/** Read FABRIC_ATTACHMENT_TEMP_ORPHAN_MAX_AGE_HOURS. Unset/NaN/<=0 -> 24. */
function readMaxAgeHours(): number {
	const raw =
		process.env.FABRIC_ATTACHMENT_TEMP_ORPHAN_MAX_AGE_HOURS ??
		String(DEFAULT_MAX_AGE_HOURS);
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_MAX_AGE_HOURS;
	}
	return Math.min(MAX_MAX_AGE_HOURS, parsed);
}

/** Heartbeat that is a no-op outside an activity context (unit tests). */
function safeHeartbeat(): void {
	try {
		heartbeat();
	} catch {
		// not running inside a Temporal activity
	}
}

export async function sweepAttachmentTempOrphansActivity(): Promise<SweepAttachmentTempOrphansResult> {
	const bucket = config.storage.bucketNames.projectContexts;
	const maxAgeHours = readMaxAgeHours();
	const cutoff = new Date(
		Date.now() - maxAgeHours * 3_600_000 - SAFETY_MARGIN_MS,
	);

	logger.info(
		{
			event: "attachments.temp_sweep.started",
			maxAgeHours,
			cutoffAt: cutoff.toISOString(),
		},
		"[AttachmentTempSweep] Starting sweep run",
	);

	let scanned = 0;
	let deleted = 0;
	let deleteAttempts = 0;
	let failedDeletes = 0;
	let skippedOrphanRows = 0;
	let pages = 0;
	let hitSafetyCap = false;
	let errorsTruncated = false;
	const errors: { key: string; message: string }[] = [];
	let continuationToken: string | undefined;

	while (true) {
		if (pages >= MAX_PAGES) {
			hitSafetyCap = true;
			break;
		}

		let page: Awaited<ReturnType<typeof listObjects>>;
		try {
			page = await listObjects({
				bucket,
				prefix: TEMP_PREFIX,
				maxKeys: 1000,
				continuationToken,
			});
		} catch (err) {
			logger.error(
				{
					event: "attachments.temp_sweep.list_error",
					err: err instanceof Error ? err.message : String(err),
				},
				"[AttachmentTempSweep] listObjects failed — aborting run; Temporal will retry",
			);
			throw err;
		}
		pages += 1;

		for (const obj of page.objects) {
			scanned += 1;
			if (obj.lastModified >= cutoff) {
				continue; // too recent — not yet provably abandoned
			}

			const finalKey = FINAL_PREFIX + obj.key.slice(TEMP_PREFIX.length);

			// §3 interlock.
			const row = await db.storyAttachment.findUnique({
				where: { storageKey: finalKey },
				select: { id: true },
			});
			if (row) {
				let finalMeta: Awaited<ReturnType<typeof getFileMetadata>>;
				try {
					finalMeta = await getFileMetadata(finalKey, { bucket });
				} catch {
					continue; // transient HEAD failure — never delete on uncertainty
				}
				if (finalMeta === null) {
					skippedOrphanRows += 1;
					logger.warn(
						{
							event: "attachments.temp_sweep.skipped_orphan_row",
							tempKey: obj.key,
							finalKey,
						},
						"[AttachmentTempSweep] temp kept: final-key row exists but final object is missing (recovery bytes)",
					);
					continue;
				}
				// final object exists (and row exists) -> redundant temp;
				// fall through to the delete below.
			}

			// Destructive op — bound by ATTEMPTS (not successes), so persistent
			// delete failures under degraded storage still stop at the cap
			// instead of attempting a delete for every aged object on all pages.
			if (deleteAttempts >= MAX_DELETIONS) {
				hitSafetyCap = true;
				break;
			}
			deleteAttempts += 1;
			try {
				await deleteFile(obj.key, { bucket });
				deleted += 1;
			} catch (err) {
				failedDeletes += 1;
				if (errors.length < MAX_ERRORS) {
					errors.push({
						key: obj.key,
						message:
							err instanceof Error ? err.message : String(err),
					});
				} else {
					errorsTruncated = true;
				}
			}
		}

		safeHeartbeat();

		if (hitSafetyCap) {
			break;
		}
		if (!page.nextContinuationToken) {
			break;
		}
		continuationToken = page.nextContinuationToken;
	}

	if (hitSafetyCap) {
		logger.warn(
			{
				event: "attachments.temp_sweep.safety_cap_hit",
				pages,
				deleted,
				maxPages: MAX_PAGES,
				maxDeletions: MAX_DELETIONS,
			},
			"[AttachmentTempSweep] Safety cap hit; remaining orphans handled next run",
		);
	}

	const result: SweepAttachmentTempOrphansResult = {
		scanned,
		deleted,
		skippedOrphanRows,
		errorCount: failedDeletes,
		errorsTruncated,
		pages,
		hitSafetyCap,
		cutoffAt: cutoff.toISOString(),
		maxAgeHours,
	};

	logger.info(
		{
			event: "attachments.temp_sweep.completed",
			...result,
			// Surface a capped sample of which keys failed to delete so
			// `errorCount`/`errorsTruncated` are actionable, not just numbers.
			errorsSample: errors.slice(0, 10),
		},
		`[AttachmentTempSweep] Swept ${deleted} orphan temp objects (scanned ${scanned}, kept ${skippedOrphanRows} with recovery rows)`,
	);

	return result;
}
