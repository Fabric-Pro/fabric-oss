/**
 * Direct commit activities (Fizzy #2878 §10). The activities barrel
 * re-exports this module, so EVERY export here becomes a schedulable
 * activity: helpers stay unexported or live in ./lib.
 *
 * Each runs under `withProposalDeadline` (its own start-to-close, heartbeat
 * ticker and cancellation). A cancellation or the deadline is rethrown for
 * Temporal. A classified failure is rethrown for a retry until the last
 * attempt, which hands it back as the snapshot's `failed` outcome for the
 * workflow to record; an unclassified error is logged by class name only and
 * treated the same way, as `UNEXPECTED`. Authority is the frozen destination
 * plus the member's live permission, re-read inside the step
 * (`assertDirectCommitAllowed`).
 *
 * Nothing the commit step decides is written by the commit step itself, bar
 * the pull request a refused push becomes: the workflow records every outcome
 * with the activities below, which are retried for hours and turn a fault no
 * retry can fix into a typed non-retryable failure (`recording`).
 */
import {
	getDirectCommitSnapshot,
	recordDirectCommitFailureBeforeReady,
	recordDirectCommitOutcome,
} from "@repo/database";
import { logger } from "@repo/logs";
import { ApplicationFailure, Context } from "@temporalio/activity";
import {
	type CommitToSyncedBranchResult,
	type ConfirmingSyncInput,
	DIRECT_COMMIT_MAX_ATTEMPTS,
	type DirectCommitReadinessInput,
	type DirectCommitReadinessResult,
	type DirectCommitWorkflowInput,
	READ_ONLY_MODE_FAILURE_CODE,
	type RecordDirectCommitSettlementResult,
	type RecordPushedDirectCommitResult,
	type RevertCommitWorkflowInput,
	type RevertCommitWorkflowResult,
	SETTLE_FAILED_CODE,
	type UnrecordedCommitOutcome,
} from "../lib/instruction-direct-commit-types";
import {
	ReadOnlyModeRefusal,
	runDirectCommit,
	settlePushedDirectCommit,
} from "./lib/instruction-direct-commit";
import {
	activityCancellationSignal,
	assertMayContinue,
	cancellationOf,
	errorClassName,
	ProposalStepFailure,
	withProposalDeadline,
} from "./lib/instruction-proposal-boundary";
import { deterministicRecordFailure } from "./lib/instruction-record-failure";
import {
	runRevertCommit,
	settlePushedRevert,
} from "./lib/instruction-revert-commit";
import { startAutomaticInstructionSync } from "./lib/instruction-sync-start";

/**
 * Runs a record, and turns a database fault that a retry cannot fix into the
 * typed non-retryable `RECORD_REJECTED`, so the retry policy that waits out an
 * unreachable database does not wait out a write the database will always
 * refuse. Every other error is rethrown as it is.
 */
async function recording<T>(write: () => Promise<T>): Promise<T> {
	try {
		return await write();
	} catch (error) {
		throw deterministicRecordFailure(error) ?? error;
	}
}

/**
 * The typed failure an error ends a commit or revert with: the step's own
 * code, `READ_ONLY_MODE` (never retried), or `UNEXPECTED` for anything else.
 */
function failureOf(error: unknown): { code: string; retryable: boolean } {
	if (error instanceof ProposalStepFailure) {
		return { code: error.code, retryable: error.retryable };
	}
	if (error instanceof ReadOnlyModeRefusal) {
		return { code: READ_ONLY_MODE_FAILURE_CODE, retryable: false };
	}
	return { code: "UNEXPECTED", retryable: false };
}

/** True on the attempt after which Temporal gives up, or outside an activity (unit tests). */
function onLastAttempt(): boolean {
	try {
		return Context.current().info.attempt >= DIRECT_COMMIT_MAX_ATTEMPTS;
	} catch {
		return true;
	}
}

/**
 * `checkDirectCommitReadiness`: the snapshot's validation verdict for the
 * commit workflow's wait. READY is `ready`; RECEIVING, VALIDATING and FAILED
 * are `pending` (a FAILED validation is retryable from the tab, so the wait
 * outlives it); REJECTED, a settled commit, a missing row and every row that
 * is not a pending direct commit are `stop`. With `deadlineReached`, a
 * still-pending commit is recorded `failed VALIDATION_TIMEOUT` and the answer
 * is `stop`. A REJECTED snapshot records nothing: its status and findings are
 * the verdict.
 */
export async function checkDirectCommitReadiness(
	input: DirectCommitReadinessInput,
): Promise<DirectCommitReadinessResult> {
	const row = await getDirectCommitSnapshot({
		snapshotId: input.snapshotId,
		organizationId: input.organizationId,
	});
	if (
		!row ||
		row.proposalDestination !== "REPOSITORY_COMMIT" ||
		row.commitOutcome !== null
	) {
		return { kind: "stop" };
	}
	if (row.status === "READY") {
		return { kind: "ready" };
	}
	if (row.status === "REJECTED") {
		return { kind: "stop" };
	}
	if (input.deadlineReached) {
		await recordDirectCommitFailureBeforeReady({
			snapshotId: input.snapshotId,
			organizationId: input.organizationId,
			outcome: {
				outcome: "failed",
				code: "VALIDATION_TIMEOUT",
				retryable: true,
			},
		});
		return { kind: "stop" };
	}
	return { kind: "pending" };
}

/**
 * `revertCommitOnSyncedBranch`: undoes one commit of the synced branch with
 * one new commit (see `runRevertCommit`). Returns how it ended: a typed
 * outcome of the revert's own, or `failed` with a code once the last attempt
 * of an infrastructure fault is spent. A revert has no snapshot row to record
 * a failure on, so the caller reads the answer from the workflow's result.
 */
export async function revertCommitOnSyncedBranch(
	input: RevertCommitWorkflowInput,
): Promise<RevertCommitWorkflowResult> {
	return withProposalDeadline({}, async () => {
		try {
			assertMayContinue();
			return await runRevertCommit(input, activityCancellationSignal());
		} catch (error) {
			const cancelled = cancellationOf(error);
			if (cancelled) {
				throw cancelled;
			}
			const failure = failureOf(error);
			if (failure.code === "UNEXPECTED") {
				logger.error(
					{
						event: "instruction_revert_commit.unexpected",
						requestId: input.requestId,
						failure: errorClassName(error),
					},
					"[CodingInstructions] A revert failed unexpectedly",
				);
			}
			if (
				!onLastAttempt() &&
				(failure.retryable || failure.code === "UNEXPECTED")
			) {
				throw error;
			}
			return { kind: "failed", code: failure.code };
		}
	});
}

/**
 * `recordPushedDirectCommit`: the branch holds the commit `sha`: record it as
 * the snapshot's outcome and name the sync run that publishes the version from
 * the real tree (see `settlePushedDirectCommit`; `startConfirmingInstructionSync`
 * starts it). Retried by the workflow, so it does not give up on a commit that
 * cannot be un-pushed; a fault no retry can fix is a non-retryable failure.
 */
export async function recordPushedDirectCommit(
	input: DirectCommitWorkflowInput & { sha: string },
): Promise<RecordPushedDirectCommitResult> {
	const confirm = await recording(() => settlePushedDirectCommit(input));
	return { kind: "settled", outcome: "committed", confirm };
}

/**
 * `recordDirectCommitSettlement`: records an outcome the commit step reached
 * without pushing (`unchanged`, `branch-moved`, a refusal, a failure). Not
 * the commit step's own write, so that a database that is briefly unreachable
 * is retried for hours here instead of three times there. A row that is
 * settled already (an earlier attempt, the reaper) is left as it is.
 */
export async function recordDirectCommitSettlement(
	input: DirectCommitWorkflowInput & { outcome: UnrecordedCommitOutcome },
): Promise<RecordDirectCommitSettlementResult> {
	await recording(() =>
		recordDirectCommitOutcome({
			snapshotId: input.snapshotId,
			organizationId: input.organizationId,
			outcome: input.outcome,
		}),
	);
	return { kind: "settled", outcome: input.outcome.outcome };
}

/**
 * `reportDirectCommitSettleFailed`: the record of a commit's outcome gave up
 * (its attempts are spent, or the write is refused for good). `sha` names the
 * commit when one reached the branch, null when nothing was pushed. Logs one
 * error, and marks the row `failed SETTLE_FAILED` (retryable) so it does not
 * read as pending forever; a row that is settled already is left as it is.
 * Best effort: the workflow ignores this activity's own failure.
 */
export async function reportDirectCommitSettleFailed(
	input: DirectCommitWorkflowInput & { sha: string | null },
): Promise<void> {
	logger.error(
		{
			event: "instruction_direct_commit.settle_failed",
			snapshotId: input.snapshotId,
			sha: input.sha,
		},
		input.sha === null
			? "[CodingInstructions] A commit's outcome could not be recorded; the row is marked failed"
			: "[CodingInstructions] A commit reached the branch but its outcome could not be recorded; the row is marked failed",
	);
	await recordDirectCommitOutcome({
		snapshotId: input.snapshotId,
		organizationId: input.organizationId,
		outcome: {
			outcome: "failed",
			code: SETTLE_FAILED_CODE,
			retryable: true,
		},
	});
}

/**
 * `reportRevertRecordFailed`: the audit row and confirming run of a revert the
 * branch holds could not be recorded and the record gave up. A revert has no
 * row to mark: this logs the one error that names the commit.
 */
export async function reportRevertRecordFailed(
	input: RevertCommitWorkflowInput,
	reverted: { sha: string },
): Promise<void> {
	logger.error(
		{
			event: "instruction_revert_commit.record_failed",
			requestId: input.requestId,
			sha: reverted.sha,
		},
		"[CodingInstructions] A revert reached the branch but its audit record could not be written",
	);
}

/**
 * `recordRevertedCommit`: the branch holds a revert commit: write its audit
 * row and name the confirming sync run (see `settlePushedRevert`). Retried by
 * the workflow for the same reason as `recordPushedDirectCommit`.
 */
export async function recordRevertedCommit(
	input: RevertCommitWorkflowInput,
	reverted: { sha: string; ref: string; fileCount: number },
): Promise<ConfirmingSyncInput | null> {
	return recording(() => settlePushedRevert(input, reverted));
}

/**
 * `startConfirmingInstructionSync`: asks the sync to take the head a commit of
 * ours just put on the branch, as a `COMMIT_PUSHED` run (not automatic,
 * bypasses the toggle, honours a pause) for the row the commit was made
 * against. The sync is one workflow per project, so a start while a run is
 * open answers `already_running`; that run may have read the branch before the
 * push, and the head needs a run that starts after it. It is therefore a
 * retryable failure, and the workflow retries it with a backoff until the open
 * run has ended (bounded; see `CONFIRMING_SYNC_RETRY`). A start whose answer
 * was lost is retried the same way and ends in one more run that finds the
 * head unchanged. Any other failure of the start is thrown and retried too.
 */
export async function startConfirmingInstructionSync(
	input: ConfirmingSyncInput,
): Promise<void> {
	const started = await startAutomaticInstructionSync({
		projectId: input.projectId,
		organizationId: input.organizationId,
		trigger: "COMMIT_PUSHED",
		expected: { syncId: input.syncId, generation: input.generation },
	});
	if (started.outcome === "already_running") {
		throw ApplicationFailure.retryable(
			"A repository sync run is open; the pushed head needs a run that starts after it",
			"SYNC_RUN_OPEN",
		);
	}
}

/**
 * `commitToSyncedBranch`: one READY direct commit snapshot becomes one commit
 * on the synced branch, or an outcome saying why not (see
 * `runDirectCommit`). Returns how the snapshot settled (the outcome itself is
 * on the row), or `pushed` with the commit's id, which the workflow records
 * with `recordPushedDirectCommit`.
 */
export async function commitToSyncedBranch(
	input: DirectCommitWorkflowInput,
): Promise<CommitToSyncedBranchResult> {
	return withProposalDeadline({}, async () => {
		try {
			assertMayContinue();
			const result = await runDirectCommit({
				snapshotId: input.snapshotId,
				organizationId: input.organizationId,
				signal: activityCancellationSignal(),
			});
			return result.kind === "settled"
				? { kind: "settled", outcome: result.outcome.outcome }
				: result;
		} catch (error) {
			const cancelled = cancellationOf(error);
			if (cancelled) {
				throw cancelled;
			}
			const failure = failureOf(error);
			if (failure.code === "UNEXPECTED") {
				logger.error(
					{
						event: "instruction_direct_commit.unexpected",
						snapshotId: input.snapshotId,
						failure: errorClassName(error),
					},
					"[CodingInstructions] A direct commit failed unexpectedly",
				);
			}
			if (
				!onLastAttempt() &&
				(failure.retryable || failure.code === "UNEXPECTED")
			) {
				throw error;
			}
			return {
				kind: "outcome",
				outcome: { outcome: "failed", ...failure },
			};
		}
	});
}
