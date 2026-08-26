/**
 * Activity wrapper for the status-announcement notification sweeper.
 *
 * Thin on purpose — the helper in `@repo/database` owns the logic, so
 * replay-validation stays stable and the behaviour is unit-testable without a
 * worker. Same shape as `dispatchProjectServiceAlertDigestActivity`.
 */

import { dispatchStatusAnnouncementNotifications } from "@repo/database/prisma/queries/status-announcement-notifications";
import { CancelledFailure, Context } from "@temporalio/activity";

export interface DispatchStatusAnnouncementNotificationsInput {
	/** Optional ISO "now", so a test can pin the lookback window. */
	nowIso?: string;
}

export interface DispatchStatusAnnouncementNotificationsActivityOutput {
	announcementsConsidered: number;
	announcementsNotified: number;
	recipientsNotified: number;
	organizationsScanned: number;
	organizationsDeferred: number;
	writeFailures: number;
	skipped: boolean;
	skipReason?: string;
}

export async function dispatchStatusAnnouncementNotificationsActivity(
	input: DispatchStatusAnnouncementNotificationsInput = {},
): Promise<DispatchStatusAnnouncementNotificationsActivityOutput> {
	const now = input.nowIso ? new Date(input.nowIso) : new Date();
	// Heartbeat, and report whether this attempt has been superseded.
	//
	// Both halves are required, and an earlier version had only the first.
	// Heartbeating is what makes the server willing to deliver cancellation at all
	// ("Activities must heartbeat in order to receive Cancellation"), but it does not
	// interrupt anything by itself — `heartbeat()`'s own type doc carries the warning
	// "Cancellation is not propagated from this function, use `cancelled` or
	// `cancellationSignal`". So without the signal check, a timed-out attempt kept
	// writing to natural completion while its retry ran concurrently: exactly the
	// failure the heartbeat was added to prevent.
	//
	// Returning `false` asks the sweep to stop at the next batch boundary.
	const result = await dispatchStatusAnnouncementNotifications(
		now,
		(progress) => {
			const context = Context.current();
			context.heartbeat(progress);
			return !context.cancellationSignal.aborted;
		},
	);

	// A cancelled attempt must not report success. Returning normally would have
	// Temporal record this attempt as a completed sweep, when it stopped early.
	if (Context.current().cancellationSignal.aborted) {
		throw new CancelledFailure(
			"statusAnnouncementNotifications cancelled mid-sweep",
		);
	}
	return {
		announcementsConsidered: result.announcementsConsidered,
		announcementsNotified: result.announcementsNotified,
		recipientsNotified: result.recipientsNotified,
		organizationsScanned: result.organizationsScanned,
		organizationsDeferred: result.organizationsDeferred,
		writeFailures: result.writeFailures,
		skipped: result.skipped,
		skipReason: result.skipReason,
	};
}
