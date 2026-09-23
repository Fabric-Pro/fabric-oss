/**
 * What a finished PM story sync tells the viewer, and when the poll may stop
 * (Fizzy #2204, FR44).
 *
 * Pure, so the copy the Roadmap has always shown stays pinned by tests while
 * the "no new work items" result is added beside it.
 *
 * `jobStatus` is the durable job row the workflow closes in its `finally`.
 * It is the only proof a pull really completed: `syncProgress` invents a
 * `completed` when the workflow has been evicted, and the row can lag the
 * progress by a poll or two.
 */

export type SyncJobStatus = "RUNNING" | "COMPLETED" | "FAILED" | null;

export interface SyncProgressSnapshot {
	status: string;
	syncedCount: number;
	failedCount?: number;
	conflictedCount?: number;
	message: string;
	/** The run's failure count from its job row; `failedCount` can be synthesized. */
	jobFailedCount?: number | null;
}

interface SyncToastSpec {
	tone: "success" | "error" | "warning" | "info";
	title: string;
	description?: string;
	/** Offer the Review Center, for items that drifted in the PM tool. */
	reviewConflicts?: boolean;
	duration?: number;
}

/**
 * How many extra polls to spend waiting for the job row to close once the
 * progress is already terminal. At one poll a second this bounds the wait to
 * ten seconds; after that the outcome resolves as unknown.
 */
export const MAX_JOB_CLOSE_GRACE_POLLS = 10;

export function isTerminalSyncStatus(status: string): boolean {
	return (
		status === "completed" || status === "failed" || status === "cancelled"
	);
}

/**
 * Keep polling after a terminal progress only while a completed run's row has
 * not closed yet. A failed or cancelled run needs no confirmation — nothing
 * continues from it either way.
 */
export function shouldAwaitJobClose(
	progress: SyncProgressSnapshot,
	jobStatus: SyncJobStatus,
	gracePollsUsed: number,
): boolean {
	return (
		progress.status === "completed" &&
		jobStatus !== "COMPLETED" &&
		jobStatus !== "FAILED" &&
		gracePollsUsed < MAX_JOB_CLOSE_GRACE_POLLS
	);
}

export function describeSyncOutcome(args: {
	progress: SyncProgressSnapshot;
	jobStatus: SyncJobStatus;
	direction: "push" | "pull" | null;
	pmToolName: string;
}): SyncToastSpec {
	const { progress, jobStatus, direction, pmToolName } = args;

	if (progress.status === "cancelled") {
		return { tone: "info", title: "Sync cancelled" };
	}
	if (progress.status !== "completed") {
		return {
			tone: "error",
			title: "Sync failed",
			description: progress.message,
		};
	}

	const conflicted = progress.conflictedCount ?? 0;
	const failed = progress.failedCount ?? 0;
	const synced = progress.syncedCount;

	if (conflicted > 0) {
		// Items that drifted in the PM tool went to the Review Center instead
		// of being overwritten.
		const parts: string[] = [];
		if (synced > 0) {
			parts.push(`${synced} synced`);
		}
		parts.push(`${conflicted} need review`);
		if (failed > 0) {
			parts.push(`${failed} failed`);
		}
		return {
			tone: "warning",
			title: `Sync finished — ${parts.join(" · ")}`,
			description: `${conflicted} item${
				conflicted === 1 ? "" : "s"
			} changed in ${pmToolName} since the last sync. Choose which version to keep in the Review Center.`,
			reviewConflicts: true,
			duration: 10000,
		};
	}
	if (failed > 0) {
		// A partial failure is not a success, however many items made it.
		const parts: string[] = [];
		if (synced > 0) {
			parts.push(`${synced} synced`);
		}
		parts.push(`${failed} failed`);
		return {
			tone: "error",
			title: `Sync finished — ${parts.join(" · ")}`,
			description: progress.message,
		};
	}
	if (synced > 0) {
		const prep = direction === "pull" ? "from" : "to";
		return {
			tone: "success",
			title: `Synced ${synced} stories ${prep} ${pmToolName}`,
		};
	}
	// FR44: a confirmed pull that found nothing new is a result, not an error.
	// Only on the job row's word — an invented "completed" stays generic.
	if (direction === "pull" && jobStatus === "COMPLETED") {
		return {
			tone: "success",
			title: "No new work items",
			description: `Your Roadmap already has everything from ${pmToolName}.`,
		};
	}
	return { tone: "success", title: "Sync finished" };
}
