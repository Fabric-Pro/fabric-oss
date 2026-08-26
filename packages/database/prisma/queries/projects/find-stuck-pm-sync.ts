/**
 * Find PM-sync items stuck in PENDING longer than the watchdog threshold.
 *
 * Background: `enqueuePmSync` stamps `lastPmSyncStatus = PENDING` immediately
 * before starting `pmSyncSingleStoryWorkflow`. The workflow's `finally`
 * (`clearPmSyncPendingIfLeaked`) clears the row back to `null` if the workflow
 * doesn't terminate via a recorded SUCCESS/FAILED/CONFLICT path.
 *
 * That's the happy-path guard. The hole it doesn't cover: if the Temporal
 * worker is offline / dead / overloaded the workflow never starts at all, so
 * neither the success path nor the leaked-PENDING cleanup ever runs. The row
 * stays in PENDING forever — surfaced in the UI as a permanent
 * "Syncing to PM Tool. Click to disable." badge with no way to recover other
 * than disabling auto-sync.
 *
 * This query is the input to the `/api/cron/fail-stuck-pm-sync` watchdog. It
 * scans the `UserStory` table for rows
 * with `lastPmSyncStatus = PENDING` AND `lastPmSyncAttemptAt < cutoff` AND
 * returns them so the caller can flip them to FAILED with an actionable
 * "pending_timeout" error, surfacing the row in the existing Review Center
 * for manual retry. The actual write is delegated to the caller (typically
 * `recordPmSyncFailure` from `@repo/temporal/activities`) so the audit log
 * row + the row stamping happen through the same canonical path.
 */
import { db, PmSyncStatus } from "../../client";

import type { PmSyncItemType } from "./pm-sync-resolve";

export interface StuckPmSyncItem {
	itemId: string;
	itemType: PmSyncItemType;
	lastPmSyncAttemptAt: Date;
}

export interface FindStuckPmSyncInput {
	/**
	 * Anything with `lastPmSyncAttemptAt` strictly older than this cut-off and
	 * still in PENDING is treated as stuck. The cron schedules every 5 minutes
	 * and the activity's worst-case (60s timeout × 5 retries = 5min) means a
	 * 10-minute cut-off leaves a comfortable margin where a healthy worker
	 * always finishes (either SUCCESS, FAILED, or workflow-finally-cleared)
	 * before the watchdog touches the row.
	 */
	olderThan: Date;
	/**
	 * Cap on the number of items returned per call. Prevents a single watchdog
	 * tick from holding open hundreds of writes if the system has a big backlog
	 * (e.g. after a long worker outage). The cron re-fires on its schedule and
	 * drains the rest on subsequent ticks.
	 */
	limit?: number;
}

/**
 * List `UserStory` rows currently stamped PENDING with
 * `lastPmSyncAttemptAt` older than `input.olderThan`. Cheap, indexed read
 * (`lastPmSyncStatus` + `lastPmSyncAttemptAt` are both selectable scalars and
 * the WHERE+ORDER BY needs no joins). Stories are the only work-item rows
 * since the Epic/Feature folder tables were dropped.
 *
 * Returned items are paired with their `itemType` so the watchdog caller can
 * dispatch directly into `recordPmSyncFailure` without a second per-row table
 * lookup.
 */
export async function findStuckPmSyncItems(
	input: FindStuckPmSyncInput,
): Promise<StuckPmSyncItem[]> {
	const cap = input.limit ?? 200;

	const userStories = await db.userStory.findMany({
		where: {
			lastPmSyncStatus: PmSyncStatus.PENDING,
			lastPmSyncAttemptAt: { lt: input.olderThan },
		},
		select: {
			id: true,
			kind: true,
			lastPmSyncAttemptAt: true,
		},
		// Oldest-first so the watchdog drains the most-stuck rows first when
		// the cap kicks in.
		orderBy: { lastPmSyncAttemptAt: "asc" },
		take: cap,
	});

	const items: StuckPmSyncItem[] = [];
	for (const row of userStories) {
		if (!row.lastPmSyncAttemptAt) {
			continue;
		}
		// `kind` is StoryKind; bugs share the UserStory table. Map BUG → "bug"
		// so the downstream `recordPmSyncFailure` dispatch picks the right
		// `entityType` enum value for the audit log (still STORY, since
		// PmSyncLog has no BUG variant — see `itemTypeToLogEntityType`).
		const itemType: PmSyncItemType = row.kind === "BUG" ? "bug" : "story";
		items.push({
			itemId: row.id,
			itemType,
			lastPmSyncAttemptAt: row.lastPmSyncAttemptAt,
		});
	}

	return items;
}
