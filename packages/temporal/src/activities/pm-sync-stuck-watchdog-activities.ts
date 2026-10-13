/**
 * Stuck PM-sync watchdog activities.
 *
 * Every PM-sync enqueue stamps the item PENDING and then starts a workflow.
 * When that workflow never runs (the worker is down, or the start's outcome
 * was uncertain and the enqueue left the row PENDING on purpose), nothing
 * clears the stamp and the item shows "Syncing to PM Tool" forever. These
 * activities let `pmSyncStuckWatchdogWorkflow` find such rows, check whether a
 * sync is really running, re-enqueue story-family rows, and give up after a
 * fixed bound.
 *
 * The give-up bound is measured from `pmSyncPendingSince`, which a fresh
 * enqueue sets and a watchdog retry keeps, so the watchdog's own retries
 * (which refresh `lastPmSyncAttemptAt`) cannot postpone it. Every write is
 * scoped to the attempt the scan saw: a row that a run settled, or that a
 * newer enqueue stamped, since the scan is left alone.
 *
 * Test cases are given up on but not retried: their single-item sync resolves
 * its PM target through `@repo/api`'s `resolvePmTarget`, which this package
 * cannot import, and a retry there is one click in the UI.
 *
 * Activity boundary: every Prisma read/write, clock read and Temporal client
 * call lives here, so the workflow stays replay-safe.
 */

import { db, findStuckPmSyncItems } from "@repo/database";
import { getTemporalClient } from "../client";
import {
	type EnqueuePmSyncResult,
	enqueuePmSyncCore,
} from "../lib/enqueue-pm-sync-core";
import {
	describePmSyncWorkflow,
	type PmSyncWorkflowState,
	pmSyncWorkflowId,
} from "../lib/pm-sync-start";
import { recordPmSyncFailure } from "./pm-integration/record-pm-sync-state";

/** A row PENDING for longer than this since its last attempt is a candidate. */
const RETRY_AFTER_MINUTES = 10;
/** A row PENDING for longer than this since its sync began is given up on. */
const GIVE_UP_AFTER_MINUTES = 60;
const DEFAULT_BATCH_SIZE = 200;

const STUCK_STORY_ERROR_MESSAGE =
	"PM sync didn't complete within 60 minutes after multiple retry attempts — the sync worker may be offline. Click 'Retry sync' to push again, or contact support if this persists.";
const STUCK_TEST_CASE_ERROR_MESSAGE =
	"PM sync didn't complete within 60 minutes — the sync worker may be offline. Click 'Retry sync' to push again, or contact support if this persists.";

export type StuckPmSyncRowType = "story" | "bug" | "testCase";

export interface StuckPmSyncRow {
	itemId: string;
	itemType: StuckPmSyncRowType;
	/** The attempt the scan saw; null on rows stamped before attempt ids existed. */
	attemptId: string | null;
	/** The give-up bound's start, carried into a retry so it is kept. */
	pendingSinceMs: number;
	/**
	 * When the row passes its give-up bound. The workflow compares it with
	 * its own clock when it reaches the row, not once at scan time, so a row
	 * that becomes overdue while the tick runs is given up rather than retried.
	 */
	giveUpAtMs: number;
}

export interface FindStuckPmSyncRowsInput {
	batchSize: number;
}

export interface FindStuckPmSyncRowsOutput {
	rows: StuckPmSyncRow[];
}

export async function findStuckPmSyncRowsActivity(
	input: FindStuckPmSyncRowsInput,
): Promise<FindStuckPmSyncRowsOutput> {
	const now = Date.now();
	const stuck = await findStuckPmSyncItems({
		olderThan: new Date(now - RETRY_AFTER_MINUTES * 60_000),
		// Overdue rows are listed first and regardless of their last attempt,
		// so each tick sees every row its bound has passed.
		pendingBefore: new Date(now - GIVE_UP_AFTER_MINUTES * 60_000),
		limit: input.batchSize > 0 ? input.batchSize : DEFAULT_BATCH_SIZE,
	});
	return {
		rows: stuck.flatMap<StuckPmSyncRow>((item) => {
			if (
				item.itemType !== "story" &&
				item.itemType !== "bug" &&
				item.itemType !== "testCase"
			) {
				return [];
			}
			const pendingSinceMs = item.pendingSince.getTime();
			return [
				{
					itemId: item.itemId,
					itemType: item.itemType,
					attemptId: item.lastPmSyncAttemptId,
					pendingSinceMs,
					giveUpAtMs: pendingSinceMs + GIVE_UP_AFTER_MINUTES * 60_000,
				},
			];
		}),
	};
}

export interface ProbeStuckPmSyncInput {
	itemId: string;
	itemType: "story" | "bug";
}

/**
 * Describe the item's PM-sync workflow id (the one every story-family
 * enqueue uses), under the describe's RPC deadline
 * (`PM_SYNC_DESCRIBE_DEADLINE_MS`). `unknown` when the client cannot be built
 * or the describe fails for any reason other than a typed not-found.
 */
export async function probeStuckPmSyncActivity(
	input: ProbeStuckPmSyncInput,
): Promise<PmSyncWorkflowState> {
	let client: Awaited<ReturnType<typeof getTemporalClient>>;
	try {
		client = await getTemporalClient();
	} catch {
		return "unknown";
	}
	return describePmSyncWorkflow(
		client,
		pmSyncWorkflowId(input.itemType, input.itemId),
	);
}

export interface RetryStuckPmSyncInput {
	itemId: string;
	itemType: "story" | "bug";
	attemptId: string | null;
	pendingSinceMs: number;
}

/**
 * Re-enqueue a stuck story-family row as its project owner, through the same
 * enqueue (and MCP-config resolution) the API uses. The new PENDING stamp is
 * written only while the row is still PENDING for the scanned attempt, and it
 * keeps the scanned pending-since bound.
 */
export async function retryStuckPmSyncActivity(
	input: RetryStuckPmSyncInput,
): Promise<EnqueuePmSyncResult> {
	// The project owner drives the enqueue: its tenant resolution uses the
	// calling user's MCP config.
	const row = await db.userStory.findUnique({
		where: { id: input.itemId },
		select: { projectId: true, project: { select: { userId: true } } },
	});
	if (!row) {
		return { enqueued: false, reason: "item-not-found" };
	}
	return enqueuePmSyncCore({
		itemId: input.itemId,
		itemType: input.itemType,
		projectId: row.projectId,
		userId: row.project.userId,
		forceInitialPush: true,
		triggerSource: "retry",
		getTemporalClient,
		watchdogRetry: {
			expectedAttemptId: input.attemptId,
			pendingSince: new Date(input.pendingSinceMs),
		},
	});
}

export interface GiveUpStuckPmSyncInput {
	itemId: string;
	itemType: StuckPmSyncRowType;
	attemptId: string | null;
}

/**
 * Stamp the row FAILED (`pending_timeout`) with a PmSyncLog audit row, only
 * while it is still PENDING for the scanned attempt. Resolves whether it
 * wrote.
 */
export async function giveUpStuckPmSyncActivity(
	input: GiveUpStuckPmSyncInput,
): Promise<boolean> {
	return recordPmSyncFailure({
		itemId: input.itemId,
		itemType: input.itemType,
		errorMessage:
			input.itemType === "testCase"
				? STUCK_TEST_CASE_ERROR_MESSAGE
				: STUCK_STORY_ERROR_MESSAGE,
		errorClass: "pending_timeout",
		triggerSource: "retry",
		actorUserId: null,
		onlyIfPendingAttempt: { attemptId: input.attemptId },
	});
}
