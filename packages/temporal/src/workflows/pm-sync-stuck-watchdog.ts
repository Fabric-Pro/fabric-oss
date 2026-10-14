/**
 * Stuck PM-sync watchdog workflow.
 *
 * Schedule-driven (every 5 minutes, `registerPmSyncStuckWatchdogSchedule`)
 * safety net for PM-sync rows left PENDING by a workflow that never ran. It
 * runs on a Temporal worker, so it covers every deployment, not only those
 * with a web cron trigger.
 *
 * Each tick scans the rows past their give-up bound plus those PENDING longer
 * than the retry threshold, then:
 *   1. gives up (FAILED, `pending_timeout`, scoped to the scanned attempt) on
 *      every row already past its bound, before any probe runs. This applies
 *      even while the workflow id is still running: a healthy sync settles in
 *      minutes, so one still running after the bound is not being processed,
 *      and if it does finish later its own terminal write replaces the FAILED;
 *   2. works through the rest. Each row is re-checked against its bound when
 *      it is reached, so one that became overdue during the tick is given up
 *      rather than retried. Test cases inside the bound are left alone (given
 *      up on, never retried). A story-family row has its workflow id
 *      described: running, or a describe that cannot answer, skips it;
 *      otherwise it is re-enqueued as the project owner, unless it became
 *      overdue while the describe ran.
 *
 * A tick is bounded so a stalled Temporal or database cannot hold the
 * schedule: rows are processed `CONCURRENCY` at a time, no row is started
 * once `TICK_BUDGET_MS` has elapsed (the rest wait for the next tick, which
 * gives up overdue rows first), and every activity has a schedule-to-close
 * timeout, so time spent queued for a worker slot counts too (a start-to-close
 * timeout alone starts only when a worker picks the task up). With overlap
 * SKIP, a run that stays under the 5-minute interval never makes the schedule
 * skip a tick: budget (3 min) plus the longest single row (a probe's 30 s
 * followed by a retry's 40 s or a give-up's 60 s) stays under it, and
 * `pm-sync-stuck-watchdog-bounds.test.ts` checks that sum against the options
 * actually passed to `proxyActivities`.
 *
 * Workflow `Date.now()` is Temporal's deterministic workflow clock, which
 * advances as activities complete.
 *
 * Mirrors `documentGenerationWatchdogWorkflow`.
 */

import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import type { StuckPmSyncRow } from "../activities";

/** No row is started after this much of a tick has elapsed. */
const TICK_BUDGET_MS = 3 * 60_000;
/** Rows in flight at once. */
const CONCURRENCY = 10;

const { findStuckPmSyncRowsActivity, giveUpStuckPmSyncActivity } =
	proxyActivities<typeof activities>({
		startToCloseTimeout: "30 seconds",
		// Caps queue wait plus every attempt; retries stop when it runs out.
		scheduleToCloseTimeout: "60 seconds",
		retry: {
			initialInterval: "1s",
			backoffCoefficient: 2,
			maximumInterval: "5s",
			maximumAttempts: 3,
		},
	});

// One attempt each: a stalled describe or start is `unknown` for this tick
// and is looked at again on the next one. The describe itself runs under a
// 10 s RPC deadline (`PM_SYNC_DESCRIBE_DEADLINE_MS`). A retry is fenced on the
// scanned attempt, so a timed-out retry that did stamp is `superseded` next
// tick, never doubled.
const { probeStuckPmSyncActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "20 seconds",
	scheduleToCloseTimeout: "30 seconds",
	retry: { maximumAttempts: 1 },
});
const { retryStuckPmSyncActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "30 seconds",
	scheduleToCloseTimeout: "40 seconds",
	retry: { maximumAttempts: 1 },
});

export interface PmSyncStuckWatchdogInput {
	/** Max rows per tick — keeps each run bounded. Defaults to 200. */
	batchSize?: number;
}

export interface PmSyncStuckWatchdogOutput {
	scanned: number;
	retried: number;
	failed: number;
	/** Running, or Temporal could not say: not retried this tick. */
	skippedLive: number;
	/** Test cases inside the give-up bound: waiting, never retried. */
	waitingTestCases: number;
	/** The row moved on (settled or re-stamped) between scan and write. */
	superseded: number;
	/** Not started before the tick's budget ran out; next tick takes them. */
	deferred: number;
}

export async function pmSyncStuckWatchdogWorkflow(
	input: PmSyncStuckWatchdogInput = {},
): Promise<PmSyncStuckWatchdogOutput> {
	const startedAt = Date.now();
	const batchSize =
		input.batchSize && input.batchSize > 0 ? input.batchSize : 200;
	const { rows } = await findStuckPmSyncRowsActivity({ batchSize });

	const out: PmSyncStuckWatchdogOutput = {
		scanned: rows.length,
		retried: 0,
		failed: 0,
		skippedLive: 0,
		waitingTestCases: 0,
		superseded: 0,
		deferred: 0,
	};
	const overBudget = () => Date.now() - startedAt >= TICK_BUDGET_MS;
	const isOverdue = (row: StuckPmSyncRow) => Date.now() >= row.giveUpAtMs;

	async function giveUp(row: StuckPmSyncRow): Promise<void> {
		const wrote = await giveUpStuckPmSyncActivity({
			itemId: row.itemId,
			itemType: row.itemType,
			attemptId: row.attemptId,
		});
		if (wrote) {
			out.failed++;
		} else {
			out.superseded++;
		}
	}

	async function processRow(row: StuckPmSyncRow): Promise<void> {
		if (isOverdue(row)) {
			await giveUp(row);
			return;
		}
		if (row.itemType === "testCase") {
			out.waitingTestCases++;
			return;
		}
		const state = await probeStuckPmSyncActivity({
			itemId: row.itemId,
			itemType: row.itemType,
		});
		if (isOverdue(row)) {
			// The bound passed while the describe ran: give up, do not re-arm.
			await giveUp(row);
			return;
		}
		if (state === "running" || state === "unknown") {
			out.skippedLive++;
			return;
		}
		const result = await retryStuckPmSyncActivity({
			itemId: row.itemId,
			itemType: row.itemType,
			attemptId: row.attemptId,
			pendingSinceMs: row.pendingSinceMs,
		});
		if (result.reason === "superseded") {
			out.superseded++;
		} else {
			out.retried++;
		}
	}

	/** Runs `work` over `items`, `CONCURRENCY` at a time, within the budget. */
	async function drain(
		items: StuckPmSyncRow[],
		work: (row: StuckPmSyncRow) => Promise<void>,
	): Promise<void> {
		let next = 0;
		const worker = async () => {
			while (next < items.length) {
				if (overBudget()) {
					out.deferred += items.length - next;
					next = items.length;
					return;
				}
				const row = items[next++] as StuckPmSyncRow;
				try {
					await work(row);
				} catch (err) {
					log.error("pm_sync_stuck_watchdog_row_failed", {
						itemId: row.itemId,
						itemType: row.itemType,
						error: err instanceof Error ? err.message : String(err),
					});
					// Continue — one bad row must not stop the sweep.
				}
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker),
		);
	}

	// Give-ups never wait behind probes.
	const overdue = rows.filter(isOverdue);
	const rest = rows.filter((row) => !overdue.includes(row));
	await drain(overdue, giveUp);
	await drain(rest, processRow);

	log.info("pm_sync_stuck_watchdog_completed", {
		...out,
		batchSize,
		elapsedMs: Date.now() - startedAt,
	});
	return out;
}
