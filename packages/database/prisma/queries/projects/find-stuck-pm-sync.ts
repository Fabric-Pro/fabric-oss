/**
 * Find PM-sync items stuck in PENDING longer than the watchdog threshold.
 *
 * Background: every PM-sync enqueue stamps `lastPmSyncStatus = PENDING`
 * (with a fresh `lastPmSyncAttemptId`) immediately before starting its
 * workflow. The story workflow's `finally` (`clearPmSyncPendingIfLeaked`)
 * clears the row back to `null` if it doesn't terminate via a recorded
 * SUCCESS/FAILED/CONFLICT path, but only for its own attempt: a PENDING a
 * newer enqueue stamped meanwhile (an enqueue that attached to the running
 * workflow) is left for this watchdog to retry. After an orphaned create the
 * clear removes any PENDING, so the retry cannot create a second ticket.
 *
 * That's the happy-path guard. The holes it doesn't cover: the Temporal
 * worker is offline / dead / overloaded so the workflow never runs, or the
 * start's outcome was uncertain (it threw, and Temporal could not say whether
 * it went through) so the enqueue left the row PENDING on purpose. Neither
 * the success path nor the leaked-PENDING cleanup ever runs, and the row
 * stays "Syncing to PM Tool" forever.
 *
 * This query is the input to the stuck-sync watchdog
 * (`pmSyncStuckWatchdogWorkflow`, a Temporal schedule). It scans `UserStory`
 * and (live) `TestCase` rows with `lastPmSyncStatus = PENDING` AND
 * `lastPmSyncAttemptAt < cutoff` and returns them with the attempt id and
 * pending-since bound the watchdog needs to retry or give up on exactly the
 * attempt it saw. The writes are delegated to the caller.
 */
import { db, PmSyncStatus } from "../../client";

import type { PmSyncItemType } from "./pm-sync-resolve";

export interface StuckPmSyncItem {
	itemId: string;
	itemType: PmSyncItemType;
	lastPmSyncAttemptAt: Date;
	/** The attempt that stamped PENDING; null on rows stamped before attempt ids existed. */
	lastPmSyncAttemptId: string | null;
	/**
	 * When the current PENDING began: `pmSyncPendingSince`, or
	 * `lastPmSyncAttemptAt` for a row stamped before that column existed.
	 * The watchdog's give-up bound reads this.
	 */
	pendingSince: Date;
}

export interface FindStuckPmSyncInput {
	/**
	 * Anything with `lastPmSyncAttemptAt` strictly older than this cut-off and
	 * still in PENDING is treated as stuck. The watchdog runs every 5 minutes
	 * and the activity's worst-case (60s timeout × 5 retries = 5min) means a
	 * 10-minute cut-off leaves a comfortable margin where a healthy worker
	 * always finishes (either SUCCESS, FAILED, or workflow-finally-cleared)
	 * before the watchdog touches the row.
	 */
	olderThan: Date;
	/**
	 * Also return rows whose current PENDING began before this instant
	 * (`pmSyncPendingSince`, or `lastPmSyncAttemptAt` for a row stamped
	 * before that column existed), however recent their last attempt. These
	 * are the watchdog's give-up candidates; they come first in the result, so
	 * a full batch of retry candidates cannot push an overdue row out of the
	 * cap, and a row retried minutes ago is still found once its bound passes.
	 */
	pendingBefore?: Date;
	/**
	 * Cap on the number of items returned per call. Prevents a single watchdog
	 * tick from holding open hundreds of writes if the system has a big backlog
	 * (e.g. after a long worker outage). The watchdog re-fires on its schedule
	 * and drains the rest on subsequent ticks.
	 */
	limit?: number;
}

const STUCK_SELECT = {
	id: true,
	lastPmSyncAttemptAt: true,
	lastPmSyncAttemptId: true,
	pmSyncPendingSince: true,
} as const;

type StuckRow = {
	id: string;
	lastPmSyncAttemptAt: Date | null;
	lastPmSyncAttemptId: string | null;
	pmSyncPendingSince: Date | null;
};

function toItem(row: StuckRow, itemType: PmSyncItemType): StuckPmSyncItem[] {
	if (!row.lastPmSyncAttemptAt) {
		return [];
	}
	return [
		{
			itemId: row.id,
			itemType,
			lastPmSyncAttemptAt: row.lastPmSyncAttemptAt,
			lastPmSyncAttemptId: row.lastPmSyncAttemptId,
			pendingSince: row.pmSyncPendingSince ?? row.lastPmSyncAttemptAt,
		},
	];
}

/**
 * List `UserStory` and live `TestCase` rows currently stamped PENDING with
 * `lastPmSyncAttemptAt` older than `input.olderThan` (oldest first) and, when
 * `input.pendingBefore` is given, every PENDING row whose sync began before it
 * (listed first), at most `limit` in total and each row once. Stories are the
 * only work-item rows since the Epic/Feature folder tables were dropped.
 *
 * Returned items are paired with their `itemType` so the watchdog caller can
 * dispatch directly into `recordPmSyncFailure` without a second per-row table
 * lookup.
 */
export async function findStuckPmSyncItems(
	input: FindStuckPmSyncInput,
): Promise<StuckPmSyncItem[]> {
	const cap = input.limit ?? 200;
	const pending = { lastPmSyncStatus: PmSyncStatus.PENDING };
	const retryWhere = {
		...pending,
		lastPmSyncAttemptAt: { lt: input.olderThan },
	};
	const overdueWhere = input.pendingBefore
		? {
				...pending,
				OR: [
					{ pmSyncPendingSince: { lt: input.pendingBefore } },
					{
						pmSyncPendingSince: null,
						lastPmSyncAttemptAt: { lt: input.pendingBefore },
					},
				],
			}
		: null;
	// Oldest-first so the watchdog drains the most-stuck rows first when the
	// cap kicks in.
	const orderBy = { lastPmSyncAttemptAt: "asc" } as const;
	const storySelect = { ...STUCK_SELECT, kind: true } as const;
	// A deleted test case is out of every list; nothing would show it.
	const live = { deletedAt: null };
	const none = Promise.resolve([]);

	const [overdueStories, overdueCases, userStories, testCases] =
		await Promise.all([
			overdueWhere
				? db.userStory.findMany({
						where: overdueWhere,
						select: storySelect,
						orderBy,
						take: cap,
					})
				: none,
			overdueWhere
				? db.testCase.findMany({
						where: { ...overdueWhere, ...live },
						select: STUCK_SELECT,
						orderBy,
						take: cap,
					})
				: none,
			db.userStory.findMany({
				where: retryWhere,
				select: storySelect,
				orderBy,
				take: cap,
			}),
			db.testCase.findMany({
				where: { ...retryWhere, ...live },
				select: STUCK_SELECT,
				orderBy,
				take: cap,
			}),
		]);

	// `kind` is StoryKind; bugs share the UserStory table. Map BUG → "bug" so
	// the downstream `recordPmSyncFailure` dispatch picks the right
	// `entityType` enum value for the audit log (still STORY, since PmSyncLog
	// has no BUG variant — see `itemTypeToLogEntityType`), and so the watchdog
	// describes the same workflow id the enqueue used.
	const storyType = (row: { kind: string | null }): PmSyncItemType =>
		row.kind === "BUG" ? "bug" : "story";
	const byAttempt = (a: StuckPmSyncItem, b: StuckPmSyncItem) =>
		a.lastPmSyncAttemptAt.getTime() - b.lastPmSyncAttemptAt.getTime();

	const overdue = [
		...overdueStories.flatMap((row) => toItem(row, storyType(row))),
		...overdueCases.flatMap((row) => toItem(row, "testCase")),
	].sort(byAttempt);
	const retry = [
		...userStories.flatMap((row) => toItem(row, storyType(row))),
		...testCases.flatMap((row) => toItem(row, "testCase")),
	].sort(byAttempt);

	const seen = new Set<string>();
	const items: StuckPmSyncItem[] = [];
	for (const item of [...overdue, ...retry]) {
		const key = `${item.itemType === "testCase" ? "testCase" : "story"}:${item.itemId}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		items.push(item);
		if (items.length === cap) {
			break;
		}
	}
	return items;
}
