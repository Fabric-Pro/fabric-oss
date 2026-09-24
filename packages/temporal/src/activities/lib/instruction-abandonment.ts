/**
 * Closing out an abandoned RECEIVING snapshot, shared by the hourly reaper
 * and the repository sync's `record` activity (design 2026-09-23 §5.4 Part
 * A, §5.7), so the verdict marker and the staging cleanup are one
 * implementation. Not re-exported from the activities barrel.
 */
import {
	markAbandonedInstructionSnapshotSwept,
	rotateAbandonedInstructionSnapshot,
} from "@repo/database";
import {
	instructionSnapshotWorkflowId,
	stagingPrefix,
} from "@repo/instructions";
import { logger } from "@repo/logs";
import type { StorageProviderInterface } from "@repo/storage";
import type { Client } from "@temporalio/client";
import {
	deleteObjectsUnderPrefix,
	type StorageBudget,
} from "./instruction-prune";

/**
 * The ONLY things a caught error contributes to a log event here: the name of
 * its class and, when the thrower set one, its `code`.
 *
 * Never `err.message`. The comments this replaces assumed a storage failure
 * came from `assertAllDeleted`, whose message is a count of failed objects —
 * but `listObjects`, `deleteObjects`, the provider SDK and Prisma all throw
 * on their own, and their messages carry request URLs, bucket names, prefixes
 * and object keys. A key names a project, a snapshot and a file, and these
 * strings reach the worker log. The result object's counts are what a run
 * reports; a name and a code are what tell an operator which KIND of failure
 * they are looking at.
 *
 * `code` is sliced because it is still a value off an arbitrary thrown
 * object: the codes worth having (`ECONNRESET`, `NoSuchBucket`, `P2025`) are
 * short, and nothing longer is a code.
 */
export function errorFacts(err: unknown): { errorName: string; code?: string } {
	const errorName = err instanceof Error ? err.name : "unknown";
	const code = (err as { code?: unknown } | null | undefined)?.code;
	return typeof code === "string"
		? { errorName, code: code.slice(0, 64) }
		: { errorName };
}

/**
 * What Temporal knows about the execution behind a snapshot's validation
 * workflow: the guard that stops phase 1 rejecting a live upload, and the
 * evidence phase 0 heals a stranded VALIDATING row on.
 *
 * `finalize` starts the workflow BEFORE it writes VALIDATING, deliberately:
 * writing the status first would strand the row in VALIDATING forever if the
 * start then failed, because every later finalize short-circuits on
 * `status !== "RECEIVING"`. It also TOLERATES a lost status write — a
 * pre-read RECEIVING plus `WorkflowExecutionAlreadyStartedError` is treated
 * as a confirmed retry. So a row that still reads RECEIVING can legitimately
 * have a live execution behind it, and closing it out would delete the very
 * bytes that execution is about to verify.
 *
 * The callers read the answer differently, which is why RUNNING and CLOSED
 * are separate here. For phase 1 and for the sync's `record`, only RUNNING
 * means hands off: a CLOSED execution that still left the row RECEIVING
 * never reached the verify claim (terminated or timed out before its first
 * activity), and nothing else will ever close that row (design 2026-09-23
 * §5.7). For phase 0 they are opposites — a running execution is the reason
 * a row is legitimately VALIDATING, and a closed one is proof that whatever
 * was going to write the verdict has already stopped.
 *
 * Errs toward live on every uncertainty, exactly as the stale-generation
 * watchdog does (`document-generation-watchdog-activities.ts`): only the
 * "Temporal has never heard of this id" answer, or an explicitly closed
 * execution, is proof of anything. An unreachable Temporal, or any other
 * describe failure, leaves the row for the next run — a stale row costs a tab
 * that keeps polling, a wrongly-closed one costs a user's upload.
 */
export async function describeSnapshotWorkflow(
	client: Client,
	snapshotId: string,
): Promise<"running" | "closed" | "absent" | "unknown"> {
	try {
		const description = await client.workflow
			.getHandle(instructionSnapshotWorkflowId(snapshotId))
			.describe();
		return description.status.name === "RUNNING" ? "running" : "closed";
	} catch (error) {
		const name = error instanceof Error ? error.name : "";
		return name === "WorkflowNotFoundError" ? "absent" : "unknown";
	}
}

/**
 * Sweeps one closed abandonment's staging prefix and records the outcome on
 * its row, which is the whole of phase 1b's per-row work and the tail of
 * phase 1's.
 *
 * Success — including a sweep that stopped at `MAX_PREFIX_PAGES`, whose
 * residue belongs to the bucket-lifecycle follow-up — clears the completion
 * mark, and the row leaves the pending population for good. Failure leaves
 * the mark alone, so the row is rediscovered on the next run, and rotates it
 * to the back of the oldest-first queue so it cannot block the rows behind
 * it. Either way the caller carries on to the next row.
 *
 * The third outcome is the run's OBJECT budget stopping the sweep part-way.
 * That is neither: the row keeps its pending mark and is NOT rotated, because
 * nothing failed and the next run — whose budget is fresh — should find it at
 * the same place in the oldest-first queue. Marking it swept is what must not
 * happen: the mark is permanent, and clearing it over a prefix that still has
 * bytes in it would strand them for good.
 */
export async function sweepClosedAbandonment(
	storage: StorageProviderInterface,
	row: { id: string; projectId: string; organizationId: string },
	phase: string,
	budget: StorageBudget,
): Promise<{ deleted: number; truncated: boolean; failed: boolean }> {
	const tenant = {
		snapshotId: row.id,
		projectId: row.projectId,
		organizationId: row.organizationId,
	};
	try {
		const sweep = await deleteObjectsUnderPrefix(
			storage,
			stagingPrefix(row.projectId, row.id),
			budget,
		);
		if (sweep.truncated && budget.remaining <= 0) {
			// Stopped by the run budget rather than by the page budget. Leave
			// the mark; the next run resumes this prefix from the top.
			return {
				deleted: sweep.deleted,
				truncated: true,
				failed: false,
			};
		}
		// The mark comes AFTER the prefix is actually clean, and only then:
		// it is what takes the row out of the pending population, so a row
		// that was not finished must keep it.
		await markAbandonedInstructionSnapshotSwept(tenant);
		return {
			deleted: sweep.deleted,
			truncated: sweep.truncated,
			failed: false,
		};
	} catch (err) {
		// Counted and carried past, with the error's CLASS and code only — see
		// `errorFacts`. The snapshot/project/organization ids stay: they are
		// this feature's structured-log convention, and they are what makes a
		// standing failure diagnosable at all.
		logger.warn(
			{
				event: "instructions.reaper.abandoned_sweep_error",
				phase,
				...tenant,
				...errorFacts(err),
			},
			"[InstructionReaper] Staging sweep failed for one abandonment; it stays pending and is retried next run",
		);
		await rotateAbandonedInstructionSnapshot(tenant);
		return { deleted: 0, truncated: false, failed: true };
	}
}
