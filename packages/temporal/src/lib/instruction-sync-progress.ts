import { recordInstructionSyncRunProgress } from "@repo/database";
import {
	createProgressCounter,
	logProgressWriteFailure,
	type ProgressCounter,
} from "./instruction-progress";

type SyncRunTarget = {
	runKey: string;
	projectId: string;
	organizationId: string;
};

export type SyncRunProgress = {
	/** A phase that has no count to give: fetching, preparing. */
	phase: (phase: "FETCHING" | "PREPARING") => Promise<void>;
	/** The copy into storage, counted in files uploaded out of `total`. */
	copying: (total: number) => ProgressCounter;
};

/**
 * Reports where an open repository sync run has got, onto the run's receipt.
 *
 * Only the copy has a number, because only the copy knows how many files it
 * has to move; the clone and the preparation before it report their phase and
 * nothing else, so no count is ever made up. The write is conditional on the
 * run still being the open one (`recordInstructionSyncRunProgress`) and, like
 * the snapshot's reporter, is awaited and cannot fail the activity.
 */
export function createSyncRunProgress(source: SyncRunTarget): SyncRunProgress {
	// Named out of `source`, which is the run's whole context: nothing but the
	// run's identity reaches the write or the log.
	const target = {
		runKey: source.runKey,
		projectId: source.projectId,
		organizationId: source.organizationId,
	};
	const logContext = target;
	return {
		phase: async (phase) => {
			try {
				await recordInstructionSyncRunProgress({
					...target,
					phase,
					done: null,
					total: null,
				});
			} catch (error) {
				logProgressWriteFailure(logContext, error);
			}
		},
		copying: (total) =>
			createProgressCounter({
				total,
				logContext,
				write: (done) =>
					recordInstructionSyncRunProgress({
						...target,
						phase: "COPYING",
						done,
						total,
					}),
			}),
	};
}
