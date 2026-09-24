/**
 * Stranded repository-sync receipts, the Coding Instructions reaper's
 * second pass (Fizzy #2672).
 *
 * A sync run's receipt is completed by the workflow's `record`, which runs in
 * a non-cancellable `finally` and closes every unfinished receipt the run
 * began. That is the fast path, and it cannot be the only one. Now that a
 * receipt outlives its configuration (no foreign key), a receipt `record`
 * never reaches stays open, and unaudited, for good:
 *
 *  - a `begin` attempt that outlives its one-minute start-to-close is
 *    abandoned by Temporal, but its code keeps running, and its receipt insert
 *    can commit after the retry has begun the run and `record` has swept.
 *    The foreign key used to refuse that insert once the configuration was
 *    gone; nothing does now;
 *  - a terminated workflow never runs `record` at all.
 *
 * Each hourly tick claims unfinished receipts older than
 * `STRANDED_SYNC_RECEIPT_AGE_MS`, asks Temporal about each one's EXACT
 * execution (the starter's workflow id plus the run id in the receipt's key),
 * and completes a receipt only when that execution has ended or Temporal has
 * no such execution. A running execution is left to its own `record`, and an
 * unanswered describe is never read as closed.
 *
 * Such a receipt stays a candidate, so the claim rotates: it stamps every
 * receipt it takes, takes the least recently checked first, and takes one
 * again only once `STRANDED_SYNC_RECEIPT_RECHECK_MS` has passed. A full batch
 * of receipts whose runs stay open (a parent can stay open for weeks settling
 * a child) therefore cannot starve a later receipt whose run has ended.
 *
 * Every completion goes through `completeInstructionRepositorySyncRun`, bound
 * to the row's own project and organization: it completes a receipt at most
 * once (`finishedAt IS NULL`) and writes its audit row only when it did, so
 * a retried attempt, an overlapping `record`, or the next tick completes
 * nothing twice. FAILED with CONFIGURATION_CHANGED when the receipt's
 * configuration is no longer the project's; otherwise CHILD_ABORTED ("stopped
 * before it finished"), the closest existing error to the "interrupted" the
 * tab showed for the open receipt. The configuration read that picks between
 * them is unlocked, so the completion decides again under its lock
 * (`classifyStaleAsConfigurationChanged`): a receipt whose
 * `(syncId, generation)` is not current there is CONFIGURATION_CHANGED,
 * whatever this pass read. There is no scheduling effect: the
 * configuration's schedule has moved on since the run ended.
 *
 * Bounded twice: `MAX_STRANDED_SYNC_RECEIPTS_PER_RUN` candidates, and a wall
 * clock checked between receipts. What is left unclaimed is the next tick's
 * work; a receipt claimed but not reached before the wall clock ran out is
 * due again once its recheck interval has passed.
 * The activities barrel re-exports only the activity from this module, so
 * its constants never become schedulable activities.
 */

import {
	claimStrandedInstructionSyncRunReceipts,
	completeInstructionRepositorySyncRun,
	getInstructionRepositorySyncForRun,
} from "@repo/database";
import { instructionRepositorySyncWorkflowId } from "@repo/instructions/workflow-ids";
import { logger } from "@repo/logs";
import type { Client } from "@temporalio/client";
import { getTemporalClient } from "../client";
import { safeHeartbeat } from "./lib/activity-liveness";

/**
 * How old an unfinished receipt must be before the reaper looks at it: far
 * past `begin`'s one-minute start-to-close and its retries, so a receipt
 * whose run is starting normally is never described at all.
 */
export const STRANDED_SYNC_RECEIPT_AGE_MS = 15 * 60 * 1000;
/**
 * How long after the reaper last claimed a still-unfinished receipt before
 * it takes that receipt again. Below the hourly schedule's interval, so a
 * receipt left open by one tick is due at the next even when that tick's
 * pass starts a few minutes earlier in its hour than the last one did.
 */
export const STRANDED_SYNC_RECEIPT_RECHECK_MS = 50 * 60 * 1000;
/** Candidates per tick; the rest is the next tick's work. */
export const MAX_STRANDED_SYNC_RECEIPTS_PER_RUN = 100;
/** Per-describe bound, as in the Living Memory describe phase. */
export const STRANDED_SYNC_RECEIPT_DESCRIBE_TIMEOUT_MS = 5_000;
/** Wall clock for one pass, inside the activity's five-minute start-to-close. */
const RUN_TIME_BUDGET_MS = 4 * 60 * 1000;

const CLOSED_STATUSES: ReadonlySet<string> = new Set([
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"TERMINATED",
	"TIMED_OUT",
	"CONTINUED_AS_NEW",
]);

type ExecutionState = "running" | "closed" | "not-found" | "unknown";

export type StrandedSyncReceiptReapResult = {
	candidates: number;
	/** Receipts this pass completed, each with its own audit row. */
	completed: number;
	/** Receipts something else completed first (idempotent no-op). */
	alreadyFinished: number;
	/** Receipts whose run is still open; its own `record` will complete them. */
	stillRunning: number;
	/** Receipts nobody could prove ended: no client, a failed describe, a key of another shape, or the budget ran out. */
	unknown: number;
	errorCount: number;
	/** The batch was full, so more candidates may be waiting. */
	hitCap: boolean;
};

class DescribeTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new DescribeTimeout()), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The workflow run id a receipt key names: `<syncId>:<workflow run id>`.
 * `null` for a key of any other shape, which is never described.
 */
function workflowRunIdOf(receipt: { id: string; syncId: string }) {
	const prefix = `${receipt.syncId}:`;
	const runId = receipt.id.startsWith(prefix)
		? receipt.id.slice(prefix.length)
		: "";
	return runId.length > 0 && !runId.includes(":") ? runId : null;
}

async function describeExecution(
	client: Pick<Client, "workflow">,
	projectId: string,
	runId: string,
): Promise<ExecutionState> {
	try {
		const description = await withTimeout(
			client.workflow
				.getHandle(
					instructionRepositorySyncWorkflowId(projectId),
					runId,
				)
				.describe(),
			STRANDED_SYNC_RECEIPT_DESCRIBE_TIMEOUT_MS,
		);
		const status = description.status.name;
		if (status === "RUNNING") {
			return "running";
		}
		return CLOSED_STATUSES.has(status) ? "closed" : "unknown";
	} catch (error) {
		return error instanceof Error && error.name === "WorkflowNotFoundError"
			? "not-found"
			: "unknown";
	}
}

export async function reapStrandedInstructionSyncReceipts(): Promise<StrandedSyncReceiptReapResult> {
	const startedAtMs = Date.now();
	const receipts = await claimStrandedInstructionSyncRunReceipts({
		startedBefore: new Date(startedAtMs - STRANDED_SYNC_RECEIPT_AGE_MS),
		checkedBefore: new Date(startedAtMs - STRANDED_SYNC_RECEIPT_RECHECK_MS),
		checkedAt: new Date(startedAtMs),
		limit: MAX_STRANDED_SYNC_RECEIPTS_PER_RUN,
	});
	const result: StrandedSyncReceiptReapResult = {
		candidates: receipts.length,
		completed: 0,
		alreadyFinished: 0,
		stillRunning: 0,
		unknown: 0,
		errorCount: 0,
		hitCap: receipts.length >= MAX_STRANDED_SYNC_RECEIPTS_PER_RUN,
	};
	if (receipts.length === 0) {
		return result;
	}

	// A client that will not construct proves nothing: every candidate is
	// left for the next tick, exactly as an unanswered describe would be.
	let client: Pick<Client, "workflow"> | null = null;
	try {
		client = await getTemporalClient();
	} catch (error) {
		logger.warn(
			{
				event: "instructions.reaper.sync_receipts.temporal_unavailable",
				candidates: receipts.length,
				errorName: error instanceof Error ? error.name : typeof error,
			},
			"[InstructionReaper] Temporal client unavailable; no sync receipt can be proven stranded this run",
		);
		result.unknown = receipts.length;
		return result;
	}

	// The project's current configuration id, tenant-checked, read once per
	// project per pass. `null` when switched off or naming another tenant.
	const currentSyncIds = new Map<string, string | null>();
	for (const [index, receipt] of receipts.entries()) {
		if (Date.now() - startedAtMs > RUN_TIME_BUDGET_MS) {
			result.unknown += receipts.length - index;
			break;
		}
		safeHeartbeat({ phase: "sync-receipts", index });
		const runId = workflowRunIdOf(receipt);
		if (runId === null) {
			result.unknown++;
			continue;
		}
		const state = await describeExecution(client, receipt.projectId, runId);
		if (state === "running") {
			result.stillRunning++;
			continue;
		}
		if (state === "unknown") {
			result.unknown++;
			continue;
		}
		try {
			let currentSyncId = currentSyncIds.get(receipt.projectId);
			if (currentSyncId === undefined) {
				const sync = await getInstructionRepositorySyncForRun(
					receipt.projectId,
				);
				currentSyncId =
					sync && sync.organizationId === receipt.organizationId
						? sync.id
						: null;
				currentSyncIds.set(receipt.projectId, currentSyncId);
			}
			const { completed } = await completeInstructionRepositorySyncRun({
				runKey: receipt.id,
				syncId: receipt.syncId,
				generation: receipt.generation,
				projectId: receipt.projectId,
				organizationId: receipt.organizationId,
				userId: receipt.userId,
				trigger: receipt.trigger,
				status: "FAILED",
				error:
					receipt.syncId === currentSyncId
						? "CHILD_ABORTED"
						: "CONFIGURATION_CHANGED",
				note: null,
				commitSha: null,
				snapshotId: null,
				scheduling: { kind: "none" },
				classifyStaleAsConfigurationChanged: true,
			});
			if (completed) {
				result.completed++;
			} else {
				result.alreadyFinished++;
			}
		} catch (error) {
			// Each receipt belongs to a different tenant: one failed write
			// must not stop the others. The receipt stays a candidate.
			result.errorCount++;
			logger.warn(
				{
					event: "instructions.reaper.sync_receipts.complete_failed",
					projectId: receipt.projectId,
					organizationId: receipt.organizationId,
					errorName:
						error instanceof Error ? error.name : typeof error,
				},
				"[InstructionReaper] Could not complete a stranded sync receipt; it is retried next run",
			);
		}
	}

	logger.info(
		{ event: "instructions.reaper.sync_receipts.completed", ...result },
		`[InstructionReaper] Completed ${result.completed} stranded sync receipt(s)`,
	);
	return result;
}
