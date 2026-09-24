import type { listInstructionRepositorySyncRuns } from "@repo/database";

type SyncRunRow = Awaited<
	ReturnType<typeof listInstructionRepositorySyncRuns>
>[number];

/**
 * A run as the tab and History render it: the member as a display name,
 * never an id. `fromCurrentConfiguration` is false for a run of a sync that
 * was switched off (or switched off and set up again), whose receipt
 * outlives it (Fizzy #2672); the sync id it compares stays on the server.
 */
export function toSyncRunView(run: SyncRunRow, currentSyncId: string | null) {
	return {
		id: run.id,
		trigger: run.trigger,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		status: run.status,
		error: run.error,
		note: run.note,
		commitSha: run.commitSha,
		snapshotId: run.snapshotId,
		snapshotVersion: run.snapshotVersion,
		userName: run.user.name,
		fromCurrentConfiguration: run.syncId === currentSyncId,
	};
}
