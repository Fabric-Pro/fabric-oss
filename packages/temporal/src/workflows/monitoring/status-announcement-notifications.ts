/**
 * statusAnnouncementNotificationWorkflow.
 *
 * Periodic sweeper that pushes customer-facing status announcements to
 * organization owners/admins. Deliberately NOT a fan-out at publish time: that
 * would scale with tenant count inside a single request, and a retry would re-send
 * something that cannot be recalled.
 *
 * Body is intentionally thin — the `@repo/database` helper owns the logic — so
 * replay-validation stays stable. The helper keeps no "already notified" state; the
 * partial unique index on `(userId, dedupeKey)` makes a repeat run a no-op, which is
 * what makes it safe to run on a schedule.
 *
 * Inert until `FABRIC_STATUS_ANNOUNCEMENT_NOTIFICATIONS_ENABLED=true`; the activity
 * returns `skipped` without querying anything.
 *
 * **Corrected after a post-ship review.** An earlier version of this comment claimed
 * that when one sweep exceeds the activity timeout, "each attempt reaches further"
 * because already-notified recipients short-circuit on the unique index. That was
 * wrong twice over: a unique-violation INSERT costs about the same as a successful one
 * (same round trip, and it leaves a dead tuple), so a retry re-walked the same ground
 * at the same price and made little net progress; and without a heartbeat the timed-out
 * attempt kept running while the retry started, so the two passes competed rather than
 * handing over.
 *
 * Both causes are addressed rather than re-documented: writes are batched per page via
 * `createMany`, which collapses ~1,500 round trips into one statement, and the activity
 * heartbeats after every write batch AND checks `cancellationSignal.aborted`, so a
 * superseded attempt actually stops instead of racing its own retry — the signal check
 * is the load-bearing half, because heartbeating alone does not interrupt anything.
 * Retries are a
 * failure path again, not a coverage mechanism.
 *
 * `overlap: SKIP` on the schedule still prevents two scheduled sweeps overlapping.
 */
import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../../activities/monitoring";

const { dispatchStatusAnnouncementNotificationsActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "5m",
	// Set because the activity heartbeats after every write batch: it is what lets the
	// server detect a stalled attempt, and what makes the server willing to deliver
	// cancellation to that attempt at all.
	heartbeatTimeout: "60s",
	retry: { initialInterval: "10s", maximumAttempts: 3 },
});

export interface StatusAnnouncementNotificationInput {
	/** Optional ISO "now"; tests pass a fixed value. */
	nowIso?: string;
}

export async function statusAnnouncementNotificationWorkflow(
	input: StatusAnnouncementNotificationInput = {},
): Promise<void> {
	let result: Awaited<
		ReturnType<typeof dispatchStatusAnnouncementNotificationsActivity>
	>;
	try {
		result = await dispatchStatusAnnouncementNotificationsActivity({
			nowIso: input.nowIso,
		});
	} catch (error) {
		// The success log below is the only product-level signal this feature emits,
		// and it never ran on the failure path — so a sweep that exhausted its
		// retries was visible only as a Temporal workflow failure. Log before
		// rethrowing so "notifications stopped going out" is greppable.
		log.error("statusAnnouncementNotificationWorkflow failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}

	log.info("statusAnnouncementNotificationWorkflow swept", {
		announcementsConsidered: result.announcementsConsidered,
		announcementsNotified: result.announcementsNotified,
		recipientsNotified: result.recipientsNotified,
		organizationsScanned: result.organizationsScanned,
		// Zero in every normal run. Non-zero means the page backstop was hit and
		// some organizations were NOT notified — the sweeper is stateless, so the
		// next tick starts from the beginning rather than resuming.
		organizationsDeferred: result.organizationsDeferred,
		// Non-dedupe write failures. Zero is the normal state; a growing value
		// means the fan-out is failing while still reporting a clean run.
		writeFailures: result.writeFailures,
		skipped: result.skipped,
		skipReason: result.skipReason,
	});
}
