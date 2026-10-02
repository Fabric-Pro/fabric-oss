import {
	type InstructionSnapshotProgressPhase,
	recordInstructionSnapshotProgress,
} from "@repo/database";
import { logger } from "@repo/logs";

/**
 * At most one progress write per second, however fast files are decided. The
 * final count is always written, so a pass never ends on a stale number.
 */
const MIN_WRITE_INTERVAL_MS = 1000;

/** The class of a failed progress write, never its message. */
export function logProgressWriteFailure(
	logContext: Record<string, string>,
	error: unknown,
): void {
	logger.warn(
		{
			event: "project.instructions.progress_write_failed",
			...logContext,
			failure:
				error instanceof Error ? error.constructor.name : "unknown",
		},
		"[CodingInstructions] Could not record check progress",
	);
}

export type ProgressCounter = {
	/** Writes the pass's start: zero files decided out of `total`. */
	begin: () => Promise<void>;
	/** Reports how many files the pass has fully decided. */
	advance: (done: number) => Promise<void>;
};

/**
 * The throttle both progress reporters share: a write at the start, then at
 * most one a second, and always the write that reaches `total`.
 *
 * Every write is awaited, never fired and forgotten, so none outlives the
 * activity that made it. A write that throws is logged by error class and
 * swallowed: progress is a courtesy, and a database hiccup must not fail a
 * check that is otherwise sound. The log carries the class only, never the
 * message, which can quote a host or a statement.
 *
 * Not an activity, and it lives outside an activities module for that
 * reason: every export from one becomes an activity.
 */
export function createProgressCounter(input: {
	total: number;
	write: (done: number) => Promise<unknown>;
	logContext: Record<string, string>;
	now?: () => number;
}): ProgressCounter {
	const now = input.now ?? Date.now;
	let lastWriteAt: number | null = null;
	let lastDone: number | null = null;
	// Writes are issued one after another, so two reports made at nearly the
	// same moment (the copy's workers finish files concurrently) cannot reach
	// the database in the opposite order and leave an older count standing.
	let queue: Promise<void> = Promise.resolve();
	const write = (done: number): Promise<void> => {
		lastWriteAt = now();
		lastDone = done;
		queue = queue.then(async () => {
			try {
				await input.write(done);
			} catch (error) {
				logProgressWriteFailure(input.logContext, error);
			}
		});
		return queue;
	};
	return {
		begin: () => write(0),
		advance: async (done) => {
			if (done === lastDone) {
				return;
			}
			const due =
				lastWriteAt === null ||
				now() - lastWriteAt >= MIN_WRITE_INTERVAL_MS;
			if (done >= input.total || due) {
				await write(done);
			}
		},
	};
}

type ProgressTarget = {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	validationAttemptId?: string;
};

/**
 * Reports one check pass's progress onto its snapshot row, for the tab to
 * show. The write is conditional on the run's ownership token
 * (`recordInstructionSnapshotProgress`), so a stale attempt can never write a
 * count over a newer run's.
 *
 * `done` only ever comes from `forEachPrefetched`'s ordered `afterConsume`,
 * so it counts files whose decision is final.
 */
export function createSnapshotProgress(
	target: ProgressTarget,
	phase: InstructionSnapshotProgressPhase,
	total: number,
	now?: () => number,
): ProgressCounter {
	return createProgressCounter({
		total,
		now,
		logContext: {
			snapshotId: target.snapshotId,
			projectId: target.projectId,
			organizationId: target.organizationId,
		},
		write: (done) =>
			recordInstructionSnapshotProgress({
				snapshotId: target.snapshotId,
				projectId: target.projectId,
				organizationId: target.organizationId,
				validationAttemptId: target.validationAttemptId,
				phase,
				done,
				total,
			}),
	});
}
