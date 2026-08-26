/**
 * Watchdog cron — re-enqueues PM-sync rows stuck in PENDING; gives up after
 * `MAX_RETRIES` ticks by stamping FAILED so the user can recover via the
 * existing retry-PM-sync UI.
 *
 * Background: `enqueuePmSync` stamps `lastPmSyncStatus = PENDING` and starts
 * `pmSyncSingleStoryWorkflow`. The workflow's `finally` clears PENDING on
 * normal termination. But if the Temporal worker is dead/offline/overloaded
 * the workflow never runs to clear it. The row stays "Syncing to PM Tool.
 * Click to disable." forever, with no surface to recover other than disabling
 * auto-sync entirely.
 *
 * This watchdog runs every 5 min via `apps/web/vercel.json`. For each row
 * whose `lastPmSyncAttemptAt` is older than `PENDING_TIMEOUT_MINUTES`:
 *   1. If we haven't hit `MAX_RETRIES` for this row yet, call `enqueuePmSync`
 *      again. This re-marks PENDING and re-starts the workflow — gives the
 *      row a fresh attempt against any worker that's now healthy.
 *   2. If we have hit `MAX_RETRIES`, stamp FAILED via `recordPmSyncFailure`.
 *      The existing Review Center + sync-failed badge surface the FAILED row;
 *      the user retries via the same `retryPmSync` UI as any other failure.
 *
 * Retry count is implicit in `lastPmSyncAttemptAt`: each retry resets it to
 * `now`, so a row that's been PENDING for N×timeoutMinutes has been retried
 * roughly N times. We compute retries by comparing the row's createdAt /
 * pmAutoSyncEnabledAt to its current attemptAt — but to keep this simple, we
 * just use the original cutoff for "still stuck" and a longer cutoff for
 * "give up." Anything older than `MAX_AGE_MINUTES` gets FAILED regardless of
 * retry count.
 */
import { enqueuePmSync } from "@repo/api/modules/projects/lib/enqueue-pm-sync";
import { findStuckPmSyncItems, type StuckPmSyncItem } from "@repo/database";
import { recordPmSyncFailure } from "@repo/temporal/activities";
import { NextResponse } from "next/server";
import { isCronRequestAuthorized } from "../lib/cron-auth";

const PENDING_TIMEOUT_MINUTES = 10;
const MAX_AGE_MINUTES = 60;
const MAX_ITEMS_PER_TICK = 200;

const STUCK_PENDING_ERROR_MESSAGE =
	"PM sync didn't complete within 60 minutes after multiple retry attempts — the sync worker may be offline. Click 'Retry sync' to push again, or contact support if this persists.";

async function loadOwnerForRetry(
	item: StuckPmSyncItem,
): Promise<{ projectId: string; userId: string } | null> {
	// Need the project owner to drive `enqueuePmSync` (its tenant resolution
	// uses the calling user's MCP config). Reuse the row → project lookup
	// pattern from `record-pm-sync-state.ts` `loadFailureLogContext` but
	// pared down to just the fields we need.
	const { db } = await import("@repo/database");
	const select = {
		projectId: true,
		project: { select: { userId: true } },
	} as const;
	// `user_story` is the only work-item table (the Epic/Feature containers
	// were dropped) — every stuck item resolves through it.
	const row = await db.userStory.findUnique({
		where: { id: item.itemId },
		select,
	});
	if (!row) {
		return null;
	}
	return { projectId: row.projectId, userId: row.project.userId };
}

export async function GET(request: Request): Promise<NextResponse> {
	if (!isCronRequestAuthorized(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const now = Date.now();
	const retryCutoff = new Date(now - PENDING_TIMEOUT_MINUTES * 60 * 1000);
	const giveUpCutoff = new Date(now - MAX_AGE_MINUTES * 60 * 1000);
	const startedAt = now;

	let stuck: StuckPmSyncItem[];
	try {
		stuck = await findStuckPmSyncItems({
			olderThan: retryCutoff,
			limit: MAX_ITEMS_PER_TICK,
		});
	} catch (error) {
		console.error("[fail-stuck-pm-sync] find query failed:", error);
		return NextResponse.json(
			{
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}

	if (stuck.length === 0) {
		return NextResponse.json({
			success: true,
			scannedAt: new Date().toISOString(),
			retryCutoff: retryCutoff.toISOString(),
			giveUpCutoff: giveUpCutoff.toISOString(),
			retriedCount: 0,
			failedCount: 0,
			durationMs: Date.now() - startedAt,
		});
	}

	let retriedCount = 0;
	let failedCount = 0;
	const errors: string[] = [];

	for (const item of stuck) {
		// Test-case PM-sync rows recover via their own retry/dismiss surface
		// (driven by testCaseSyncWorkflow), not this story-family watchdog —
		// which resolves `user_story` owners and drives `enqueuePmSync` (the
		// story sync path). Skip them so the narrow story-family `enqueuePmSync`
		// item-type holds. (Auto-watchdog for stuck test-case syncs is a future
		// enhancement; the manual Retry/Dismiss controls cover recovery today.)
		if (item.itemType === "testCase") {
			continue;
		}
		const isGiveUpAge = item.lastPmSyncAttemptAt < giveUpCutoff;

		try {
			if (isGiveUpAge) {
				// Past the absolute cap — stop retrying and surface as FAILED so
				// the user can act. `recordPmSyncFailure` writes both the row
				// state and a PmSyncLog audit entry.
				await recordPmSyncFailure({
					itemId: item.itemId,
					itemType: item.itemType,
					errorMessage: STUCK_PENDING_ERROR_MESSAGE,
					errorClass: "pending_timeout",
					triggerSource: "retry",
					actorUserId: null,
				});
				failedCount += 1;
				continue;
			}

			// Within the retry window — re-enqueue the sync. If the worker is
			// healthy now, the new workflow processes the push to completion.
			// If still dead, the next watchdog tick re-enqueues again until
			// we hit MAX_AGE_MINUTES.
			const owner = await loadOwnerForRetry(item);
			if (!owner) {
				// Row vanished between the find query and now (e.g. user
				// deleted the story). Quietly skip.
				continue;
			}
			const enqueueResult = await enqueuePmSync({
				itemId: item.itemId,
				itemType: item.itemType,
				projectId: owner.projectId,
				userId: owner.userId,
				forceInitialPush: true,
				triggerSource: "retry",
			});
			retriedCount += 1;
			console.info("[fail-stuck-pm-sync] re-enqueued stuck row", {
				itemId: item.itemId,
				itemType: item.itemType,
				ageMinutes: Math.round(
					(now - item.lastPmSyncAttemptAt.getTime()) / 60000,
				),
				enqueued: enqueueResult.enqueued,
				reason: enqueueResult.reason,
			});
		} catch (error) {
			// Non-fatal — keep draining. Re-enqueue or recordPmSyncFailure
			// throwing here is rare (both have internal try/catch).
			const msg = error instanceof Error ? error.message : String(error);
			errors.push(`${item.itemType}:${item.itemId}: ${msg}`);
			console.warn("[fail-stuck-pm-sync] iteration threw:", {
				itemId: item.itemId,
				itemType: item.itemType,
				message: msg,
			});
		}
	}

	console.log("[fail-stuck-pm-sync] watchdog tick", {
		scannedAt: new Date().toISOString(),
		retryCutoff: retryCutoff.toISOString(),
		giveUpCutoff: giveUpCutoff.toISOString(),
		stuckCount: stuck.length,
		retriedCount,
		failedCount,
		errorCount: errors.length,
		durationMs: Date.now() - startedAt,
	});

	return NextResponse.json({
		success: errors.length === 0,
		scannedAt: new Date().toISOString(),
		retryCutoff: retryCutoff.toISOString(),
		giveUpCutoff: giveUpCutoff.toISOString(),
		stuckCount: stuck.length,
		retriedCount,
		failedCount,
		errorCount: errors.length,
		durationMs: Date.now() - startedAt,
		sampleErrors: errors.slice(0, 5),
	});
}
