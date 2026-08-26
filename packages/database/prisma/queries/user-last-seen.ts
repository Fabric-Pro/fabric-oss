/**
 * "Last active" recency writer for the User Activity dashboard.
 *
 * The dashboard's original recency signal was `auth.login.success` audit
 * rows, but sessions last 30 days with Better Auth's rolling refresh
 * (`packages/auth/auth.ts` session.expiresIn, `config/index.ts`
 * sessionCookieMaxAge), so a user who opens Fabric every day never
 * re-authenticates and reads as dormant. This module records real
 * authenticated traffic instead.
 *
 * Called un-awaited from `touchLastSeenMiddleware` on every authenticated
 * oRPC call, so it has two hard contracts:
 *
 *   1. It never throws. A failure here must not surface anywhere near a
 *      user request — it is telemetry, not business logic.
 *   2. It is cheap. An in-process throttle skips most calls outright, and
 *      the write that does happen is a single conditional UPDATE on the
 *      primary key. On Vercel the in-process throttle map is NOT a
 *      reliable multi-instance bound — instance count is elastic and the
 *      map resets on every cold start. The actual bound on ROW WRITES is
 *      the `WHERE lastSeenAt IS NULL OR lastSeenAt < cutoff` clause
 *      itself: whichever instance's write lands first moves the cutoff
 *      forward, so every other instance's write for the same user in the
 *      same window matches zero rows. That caps writes at one per user
 *      per window regardless of how many instances are running.
 */

import { logger } from "@repo/logs";
import { db } from "../client";

/** Recency granularity. Fifteen minutes is well inside any "is this user
 *  active this week" reading of the dashboard, and bounds write volume to
 *  ~4 rows per active user per hour per instance. */
export const LAST_SEEN_THROTTLE_MS = 15 * 60 * 1000;

/**
 * Backoff applied after a failed write, instead of clearing the throttle
 * outright. A transient failure (one bad connection) and a PERSISTENT
 * failure (e.g. `db.user.updateMany` throwing P2022 because the
 * `lastSeenAt` column migration — run manually via the
 * `Database Migrate and Seed` workflow, see `.changeset/user-activity-last-active.md`
 * — has not landed yet on this environment, or an ongoing database
 * incident) look identical from in here: both are just "the write
 * failed". Clearing the throttle entry handles the transient case fine
 * but is catastrophic for the persistent one: every subsequent request
 * from every user immediately re-enters the write path, each one a
 * doomed round trip to the database plus a log line, completely
 * unthrottled. Arming a bounded backoff instead means a persistent
 * failure still costs at most one attempt per user per minute — cheap
 * enough to ride out a deploy-ordering mistake or a database incident
 * without amplifying it.
 */
export const FAILURE_BACKOFF_MS = 60_000;

/** userId -> epoch millis of the last write attempt by THIS process.
 *  Bounded by concurrently-active users; stale entries are swept on write. */
const lastWriteByUser = new Map<string, number>();

/** Test-only: clear the throttle between cases. */
export function __resetLastSeenThrottle(): void {
	lastWriteByUser.clear();
}

/** Test-only: assert the map does not grow without bound. */
export function __lastSeenThrottleSize(): number {
	return lastWriteByUser.size;
}

function pruneStaleEntries(nowMs: number): void {
	for (const [userId, writtenAtMs] of lastWriteByUser) {
		if (nowMs - writtenAtMs >= LAST_SEEN_THROTTLE_MS) {
			lastWriteByUser.delete(userId);
		}
	}
}

export async function touchLastSeen(
	userId: string,
	now: Date = new Date(),
): Promise<void> {
	const nowMs = now.getTime();
	const writtenAtMs = lastWriteByUser.get(userId);
	if (
		writtenAtMs !== undefined &&
		nowMs - writtenAtMs < LAST_SEEN_THROTTLE_MS
	) {
		return;
	}

	pruneStaleEntries(nowMs);
	lastWriteByUser.set(userId, nowMs);

	try {
		await db.user.updateMany({
			where: {
				id: userId,
				OR: [
					{ lastSeenAt: null },
					{
						lastSeenAt: {
							lt: new Date(nowMs - LAST_SEEN_THROTTLE_MS),
						},
					},
				],
			},
			data: { lastSeenAt: now },
		});
	} catch (error) {
		// Arm a short backoff instead of clearing the throttle outright.
		// Clearing it would make a PERSISTENT failure (missing column,
		// database incident) unthrottled — every subsequent request from
		// every user would immediately retry the write. Setting the entry
		// to `nowMs - LAST_SEEN_THROTTLE_MS + FAILURE_BACKOFF_MS` reuses
		// the same `nowMs - writtenAtMs < LAST_SEEN_THROTTLE_MS` check
		// above to mean "retry in FAILURE_BACKOFF_MS" rather than "retry
		// in LAST_SEEN_THROTTLE_MS": the next call sees an elapsed time of
		// only `FAILURE_BACKOFF_MS` short of the full window, so it skips
		// until FAILURE_BACKOFF_MS has actually passed since this failure.
		//
		// This same backoff is what stops the log flood: because no call
		// can reach this `catch` again for this user until the backoff
		// elapses, `logger.warn` below is *structurally* rate-limited to
		// at most one line per user per `FAILURE_BACKOFF_MS` window — a
		// persistent failure logs at a steady ~1/user/minute instead of
		// once per request.
		lastWriteByUser.set(
			userId,
			nowMs - LAST_SEEN_THROTTLE_MS + FAILURE_BACKOFF_MS,
		);

		// Object-first, message-second — matches the consola call convention
		// used elsewhere in this directory (see feature-flags.ts,
		// audit-log.ts), not the string-first form.
		logger.warn(
			{
				event: "user_last_seen.write_failed",
				userId,
				err: {
					message:
						error instanceof Error ? error.message : String(error),
					name: error instanceof Error ? error.name : "UnknownError",
				},
			},
			"Failed to record user last-seen",
		);
	}
}
