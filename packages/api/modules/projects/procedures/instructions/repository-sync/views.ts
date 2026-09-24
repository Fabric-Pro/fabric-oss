import type { listInstructionRepositorySyncRuns } from "@repo/database";

type SyncRunRow = Awaited<
	ReturnType<typeof listInstructionRepositorySyncRuns>
>[number];

/** A run as the tab and History render it: the member as a display name, never an id. */
export function toSyncRunView(run: SyncRunRow) {
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
	};
}
