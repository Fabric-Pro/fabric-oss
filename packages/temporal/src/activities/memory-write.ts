/**
 * Living Memory write activities (ADR-022). The activities barrel re-exports
 * this module, so EVERY export here becomes a schedulable activity: helpers
 * stay unexported or live in ./lib.
 *
 * `runMemoryWrite` is the one activity that touches the repository (see
 * `executeMemoryWrite`). It runs under `withProposalDeadline` (its own
 * start-to-close, heartbeat ticker and cancellation). A cancellation or the
 * deadline is rethrown for Temporal. A classified failure is rethrown for a
 * retry until the last attempt, which hands it back as the write's `FAILED`
 * outcome; an unclassified error is logged by class name only and treated the
 * same way, as `UNEXPECTED`. A refusal the live checks make immediately before
 * a push (`MemoryWriteRefused`) is the write's `REFUSED` outcome, never a retry.
 *
 * It never writes the receipt. The workflow records every outcome with
 * `recordMemoryWriteOutcome`, which is retried for a long time: a commit that
 * is on the branch cannot be un-pushed, so the receipt must not stay `PENDING`
 * because the database was briefly unreachable. A fault no retry can fix ends
 * the record at once, typed.
 */

import {
	db,
	getMemoryWriteForRun,
	REPOSITORY_SYNC_SUBJECT_STORES,
	settleMemoryWrite,
} from "@repo/database";
import { logger } from "@repo/logs";
import { ApplicationFailure, Context } from "@temporalio/activity";
import {
	type MemoryWriteOutcome,
	memoryWriteOutcomeSchema,
} from "../lib/memory-write/outcome";
import { deleteStagedBytes } from "../lib/memory-write/staging";
import {
	MEMORY_WRITE_MAX_ATTEMPTS,
	MEMORY_WRITE_SETTLE_FAILED_CODE,
	type MemoryWriteStepResult,
	type MemoryWriteWorkflowInput,
	type RecordMemoryWriteOutcomeResult,
} from "../lib/memory-write-types";
import { startAutomaticContextSync } from "./lib/context-sync-start";
import {
	activityCancellationSignal,
	assertMayContinue,
	cancellationOf,
	errorClassName,
	ProposalStepFailure,
	withProposalDeadline,
} from "./lib/instruction-proposal-boundary";
import { deterministicRecordFailure } from "./lib/instruction-record-failure";
import { MemoryWriteRefused } from "./lib/memory-write-push";
import { executeMemoryWrite } from "./lib/memory-write-run";

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

/** The typed failure an error ends a write with: the step's own code, or `UNEXPECTED`. */
function failureOf(error: unknown): { code: string; retryable: boolean } {
	if (error instanceof ProposalStepFailure) {
		return { code: error.code, retryable: error.retryable };
	}
	return { code: "UNEXPECTED", retryable: false };
}

/** The attempt number of the running activity, 1 for the first; 1 outside an activity (unit tests). */
function currentAttempt(): number {
	try {
		return Context.current().info.attempt;
	} catch {
		return 1;
	}
}

/** True on the attempt after which Temporal gives up, or outside an activity (unit tests). */
function onLastAttempt(): boolean {
	try {
		return Context.current().info.attempt >= MEMORY_WRITE_MAX_ATTEMPTS;
	} catch {
		return true;
	}
}

/**
 * `runMemoryWrite`: one `PENDING` receipt becomes a commit on the synced
 * branch or a pull request into it, or a typed outcome saying why not (see
 * `executeMemoryWrite`). Returns `stopped` when there is nothing to act on
 * (the receipt is settled already, or gone), else the outcome for the
 * workflow to record.
 */
export async function runMemoryWrite(
	input: MemoryWriteWorkflowInput,
): Promise<MemoryWriteStepResult> {
	return withProposalDeadline({}, async () => {
		try {
			assertMayContinue();
			return await executeMemoryWrite({
				input,
				signal: activityCancellationSignal(),
				attempt: currentAttempt(),
			});
		} catch (error) {
			const cancelled = cancellationOf(error);
			if (cancelled) {
				throw cancelled;
			}
			if (error instanceof MemoryWriteRefused) {
				return { kind: "outcome", outcome: error.outcome };
			}
			const failure = failureOf(error);
			if (failure.code === "UNEXPECTED") {
				logger.error(
					{
						event: "memory_write.unexpected",
						writeId: input.writeId,
						failure: errorClassName(error),
					},
					"[LivingMemory] A write failed unexpectedly",
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
				outcome: { status: "FAILED", ...failure },
			};
		}
	});
}

/** What the audit row adds to the receipt's own facts: codes, ids and counts, never a path, a message or a URL. */
function auditMetadataOf(outcome: MemoryWriteOutcome): Record<string, unknown> {
	switch (outcome.status) {
		case "COMMITTED":
			return { sha: outcome.sha };
		case "PULL_REQUEST":
			return {
				sha: outcome.sha,
				branch: outcome.branch,
				externalId: outcome.externalId,
				reason: outcome.reason,
			};
		case "CONFLICT":
			return { conflictCount: outcome.paths.length };
		case "REFUSED":
			return {
				code: outcome.code,
				pathCount: outcome.paths?.length ?? 0,
			};
		case "FAILED":
			return { code: outcome.code, retryable: outcome.retryable };
		default:
			return unhandledOutcome(outcome);
	}
}

function unhandledOutcome(outcome: never): never {
	throw new Error(
		`Unhandled memory write outcome: ${JSON.stringify(outcome)}`,
	);
}

/**
 * `recordMemoryWriteOutcome`: settles the receipt with the outcome (status,
 * typed outcome, `settledAt`) and writes the `memory_write_settled` audit row,
 * in one transaction. Idempotent: a receipt that is settled already (an earlier
 * attempt, or another run) is left as it is and its status is answered. An
 * outcome that does not parse, or a receipt that is gone, is a typed
 * non-retryable failure; a database fault that a retry can clear is retried.
 * When the write landed (a commit or a pull request), the staged bytes are no
 * longer needed and are removed, best effort; for any other outcome they stay,
 * because the caller may send the same request again.
 */
export async function recordMemoryWriteOutcome(
	input: MemoryWriteWorkflowInput & { outcome: MemoryWriteOutcome },
): Promise<RecordMemoryWriteOutcomeResult> {
	const parsed = memoryWriteOutcomeSchema.safeParse(input.outcome);
	if (!parsed.success) {
		throw ApplicationFailure.nonRetryable(
			"A memory write's outcome does not parse",
			"MEMORY_WRITE_OUTCOME_INVALID",
		);
	}
	const outcome = parsed.data;
	const settled = await recording(() =>
		settleMemoryWrite({
			writeId: input.writeId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			status: outcome.status,
			outcome,
			metadata: auditMetadataOf(outcome),
		}),
	);
	if (settled.status === null) {
		throw ApplicationFailure.nonRetryable(
			"A memory write's receipt is gone",
			"MEMORY_WRITE_MISSING",
		);
	}
	if (settled.status === "PENDING") {
		throw ApplicationFailure.retryable(
			"A memory write's receipt did not accept its outcome",
			"MEMORY_WRITE_NOT_SETTLED",
		);
	}
	if (
		settled.applied &&
		(outcome.status === "COMMITTED" || outcome.status === "PULL_REQUEST")
	) {
		await removeStagedBytes(input);
	}
	return { kind: "settled", status: settled.status };
}

/** Removes the staged bytes of a write that landed. Never throws: a leftover object is not a failed write. */
async function removeStagedBytes(
	input: MemoryWriteWorkflowInput,
): Promise<void> {
	try {
		const write = await getMemoryWriteForRun(input);
		const keys =
			write?.entries.flatMap((entry) =>
				entry.stagedKey === null ? [] : [entry.stagedKey],
			) ?? [];
		const left = await deleteStagedBytes(keys);
		if (left > 0) {
			logger.warn(
				{
					event: "memory_write.staged_left",
					writeId: input.writeId,
					left,
				},
				"[LivingMemory] Some staged bytes of a settled write could not be removed",
			);
		}
	} catch (error) {
		logger.warn(
			{
				event: "memory_write.staged_cleanup_failed",
				writeId: input.writeId,
				failure: errorClassName(error),
			},
			"[LivingMemory] The staged bytes of a settled write could not be removed",
		);
	}
}

/**
 * `reportMemoryWriteSettleFailed`: the record of a write's outcome gave up
 * (its attempts are spent, or the write is refused for good). `sha` names the
 * commit or branch head when one reached the repository. Logs one error and
 * marks the receipt `FAILED SETTLE_FAILED` (retryable) so it does not read as
 * pending forever; a receipt that is settled already is left as it is. Best
 * effort: the workflow ignores this activity's own failure.
 */
export async function reportMemoryWriteSettleFailed(
	input: MemoryWriteWorkflowInput & { sha: string | null },
): Promise<void> {
	logger.error(
		{
			event: "memory_write.settle_failed",
			writeId: input.writeId,
			sha: input.sha,
		},
		input.sha === null
			? "[LivingMemory] A write's outcome could not be recorded; the receipt is marked failed"
			: "[LivingMemory] A write reached the repository but its outcome could not be recorded; the receipt is marked failed",
	);
	const outcome: MemoryWriteOutcome = {
		status: "FAILED",
		code: MEMORY_WRITE_SETTLE_FAILED_CODE,
		retryable: true,
		...(input.sha === null ? {} : { sha: input.sha }),
	};
	await settleMemoryWrite({
		writeId: input.writeId,
		projectId: input.projectId,
		organizationId: input.organizationId,
		status: "FAILED",
		outcome,
		metadata: auditMetadataOf(outcome),
	});
}

/**
 * `startMemoryWriteSync`: asks the Living Memory sync to take the commit a
 * write just put on the synced branch, as an automatic (webhook) run for the
 * row the write was made against, so the files are read back without waiting
 * for the poll. The sync is one workflow per project: when a run is open it may
 * have read the branch before the push, so the head is recorded on the row
 * the way the push webhook records it (`recordPendingHead`), and the open run's
 * completion re-checks the branch. A kick that fails is the workflow's to
 * ignore: the poll takes the head anyway.
 */
export async function startMemoryWriteSync(
	input: MemoryWriteWorkflowInput & { sha: string },
): Promise<void> {
	const sync = await db.projectContextRepositorySync.findFirst({
		where: {
			projectId: input.projectId,
			organizationId: input.organizationId,
		},
		select: { id: true, generation: true },
	});
	if (!sync) {
		return;
	}
	const row = {
		id: sync.id,
		projectId: input.projectId,
		organizationId: input.organizationId,
		generation: sync.generation,
	};
	const started = await startAutomaticContextSync({
		projectId: row.projectId,
		organizationId: row.organizationId,
		trigger: "WEBHOOK",
		expected: { syncId: row.id, generation: row.generation },
	});
	if (started.outcome === "started") {
		return;
	}
	const store = REPOSITORY_SYNC_SUBJECT_STORES.context;
	const { applied } = await store.recordPendingHead(db, row, input.sha);
	if (!applied) {
		return;
	}
	await store.settlePendingHead(db, row, started.runId);
}
