/**
 * Stranded Living Memory repository-sync receipts: the twin of the Coding
 * Instructions reaper's sync-receipt pass (Fizzy #2672), for Fizzy #2784.
 *
 * A run's receipt is completed by the workflow's `record`, which runs in a
 * non-cancellable `finally` and completes the receipt the run began. That is
 * the fast path, and it cannot be the only one. A receipt `record` never
 * reaches stays open, and unaudited, until the next "Sync now" happens to
 * reconcile it, which a project that is never synced again never does:
 *
 *  - a `begin` attempt that outlives its start-to-close is abandoned by
 *    Temporal, but its code keeps running, and its receipt insert can commit
 *    after the retry has begun the run and `record` has swept;
 *  - a terminated workflow never runs `record` at all.
 *
 * Each tick claims unfinished receipts older than
 * `STRANDED_SYNC_RECEIPT_AGE_MS`, asks Temporal about each one's EXACT
 * execution (the starter's workflow id plus the run id in the receipt's key),
 * and completes a receipt only when that execution has ended or Temporal has
 * no such execution. A running execution is left to its own `record`, and an
 * unanswered describe is never read as closed. The claim stamps every receipt
 * it takes and takes the least recently checked first, so a full batch of
 * receipts whose runs stay open cannot starve a later one that has ended
 * (`claimStrandedContextSyncRunReceipts`).
 *
 * A completion takes the same locks `record` takes, in the same order (the
 * configuration when it still exists, then the run), and completes a receipt
 * at most once: the audit row is written by the call that completed it, so a
 * retried attempt, an overlapping `record` or the next tick writes nothing
 * twice. FAILED with CONFIGURATION_CHANGED when the receipt's configuration is
 * gone or has moved to another generation; otherwise INTERRUPTED (it stopped
 * before it finished), the verdict `begin`'s reconciliation gives the same
 * receipt. The configuration's schedule has moved on since the run ended, so
 * there is no scheduling effect; its run key is released if it still holds it.
 *
 * Bounded twice: `MAX_STRANDED_SYNC_RECEIPTS_PER_RUN` candidates, and a wall
 * clock checked between receipts. What is left unclaimed is the next tick's
 * work. The activities barrel re-exports only the activity from this module.
 */

import {
	claimStrandedContextSyncRunReceipts,
	db,
	getContextRepositorySyncForUpdate,
	getContextRepositorySyncRunForUpdate,
	releaseContextRepositorySyncRunKey,
} from "@repo/database";
import { contextRepositorySyncWorkflowId } from "@repo/instructions/workflow-ids";
import { logger } from "@repo/logs";
import type { Client } from "@temporalio/client";
import { getTemporalClient } from "../client";
import { safeHeartbeat } from "./lib/activity-liveness";
import { completeInterruptedContextSyncRun } from "./lib/context-sync-record";
import {
	describeExecution,
	workflowRunIdOf,
} from "./lib/stranded-sync-receipts";
import {
	MAX_STRANDED_SYNC_RECEIPTS_PER_RUN,
	STRANDED_SYNC_RECEIPT_AGE_MS,
	STRANDED_SYNC_RECEIPT_DESCRIBE_TIMEOUT_MS,
	STRANDED_SYNC_RECEIPT_RECHECK_MS,
	type StrandedSyncReceiptReapResult,
} from "./project-instruction-sync-receipt-reaper";

/** Wall clock for one pass, inside the activity's five-minute start-to-close. */
const RUN_TIME_BUDGET_MS = 4 * 60 * 1000;
/** The record activity's transaction bound: two row locks and a few writes. */
const COMPLETION_TRANSACTION_TIMEOUT_MS = 30_000;

type StrandedReceipt = {
	id: string;
	syncId: string;
	projectId: string;
	organizationId: string;
	generation: number;
};

/**
 * Completes one receipt under the record activity's locks. `false` when the
 * run was already finished, or is not this tenant's.
 */
async function completeStrandedReceipt(
	receipt: StrandedReceipt,
): Promise<boolean> {
	return db.$transaction(
		async (tx) => {
			const sync = await getContextRepositorySyncForUpdate(
				tx,
				receipt.syncId,
				{
					projectId: receipt.projectId,
					organizationId: receipt.organizationId,
				},
			);
			const lock = await getContextRepositorySyncRunForUpdate(
				tx,
				receipt.id,
			);
			if (
				lock.status !== "ok" ||
				lock.run.syncId !== receipt.syncId ||
				lock.run.projectId !== receipt.projectId ||
				lock.run.organizationId !== receipt.organizationId
			) {
				return false;
			}
			// Decided under the locks, not from what the claim read: a
			// configuration re-saved since is another generation's.
			const current =
				sync !== null && sync.generation === lock.run.generation;
			const completed = await completeInterruptedContextSyncRun(tx, {
				run: lock.run,
				error: current ? "INTERRUPTED" : "CONFIGURATION_CHANGED",
				...(sync?.now ? { now: sync.now } : {}),
			});
			if (completed && sync && sync.activeRunKey === lock.run.id) {
				await releaseContextRepositorySyncRunKey(
					tx,
					sync.id,
					lock.run.id,
				);
			}
			return completed;
		},
		{ timeout: COMPLETION_TRANSACTION_TIMEOUT_MS },
	);
}

export async function reapStrandedContextSyncReceipts(): Promise<StrandedSyncReceiptReapResult> {
	const startedAtMs = Date.now();
	const receipts = await claimStrandedContextSyncRunReceipts({
		startedBefore: new Date(startedAtMs - STRANDED_SYNC_RECEIPT_AGE_MS),
		checkedBefore: new Date(startedAtMs - STRANDED_SYNC_RECEIPT_RECHECK_MS),
		checkedAt: new Date(startedAtMs),
		limit: MAX_STRANDED_SYNC_RECEIPTS_PER_RUN,
	});
	const result: StrandedSyncReceiptReapResult = {
		candidates: receipts.length,
		completed: 0,
		alreadyFinished: 0,
		stillRunning: 0,
		unknown: 0,
		errorCount: 0,
		hitCap: receipts.length >= MAX_STRANDED_SYNC_RECEIPTS_PER_RUN,
	};
	if (receipts.length === 0) {
		return result;
	}

	// A client that will not construct proves nothing: every candidate is
	// left for the next tick, exactly as an unanswered describe would be.
	let client: Pick<Client, "workflow">;
	try {
		client = await getTemporalClient();
	} catch (error) {
		logger.warn(
			{
				event: "context.reaper.sync_receipts.temporal_unavailable",
				candidates: receipts.length,
				errorName: error instanceof Error ? error.name : typeof error,
			},
			"[ContextSyncReaper] Temporal client unavailable; no sync receipt can be proven stranded this run",
		);
		result.unknown = receipts.length;
		return result;
	}

	for (const [index, receipt] of receipts.entries()) {
		if (Date.now() - startedAtMs > RUN_TIME_BUDGET_MS) {
			result.unknown += receipts.length - index;
			break;
		}
		safeHeartbeat({ phase: "context-sync-receipts", index });
		const runId = workflowRunIdOf(receipt);
		if (runId === null) {
			result.unknown++;
			continue;
		}
		const state = await describeExecution(
			client,
			contextRepositorySyncWorkflowId(receipt.projectId),
			runId,
			STRANDED_SYNC_RECEIPT_DESCRIBE_TIMEOUT_MS,
		);
		if (state === "running") {
			result.stillRunning++;
			continue;
		}
		if (state === "unknown") {
			result.unknown++;
			continue;
		}
		try {
			if (await completeStrandedReceipt(receipt)) {
				result.completed++;
			} else {
				result.alreadyFinished++;
			}
		} catch (error) {
			// Each receipt belongs to a different tenant: one failed write
			// must not stop the others. The receipt stays a candidate.
			result.errorCount++;
			logger.warn(
				{
					event: "context.reaper.sync_receipts.complete_failed",
					projectId: receipt.projectId,
					organizationId: receipt.organizationId,
					errorName:
						error instanceof Error ? error.name : typeof error,
				},
				"[ContextSyncReaper] Could not complete a stranded sync receipt; it is retried next run",
			);
		}
	}

	logger.info(
		{ event: "context.reaper.sync_receipts.completed", ...result },
		`[ContextSyncReaper] Completed ${result.completed} stranded sync receipt(s)`,
	);
	return result;
}
