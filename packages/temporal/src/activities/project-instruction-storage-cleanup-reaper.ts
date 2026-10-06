/**
 * Bounded recovery for the storage prefixes of deleted Coding Instructions
 * snapshots. The deletion transaction creates a durable receipt after the
 * row deletion succeeds and before that transaction commits, so a failed
 * prefix sweep remains discoverable even after a
 * project itself has been deleted.
 */
import {
	clearInstructionStorageCleanupReceipt,
	deferInstructionStorageCleanupReceipt,
	listDueInstructionStorageCleanupReceipts,
} from "@repo/database";
import { snapshotOwnedPrefixes } from "@repo/instructions";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import { safeHeartbeat } from "./lib/activity-liveness";
import { errorFacts } from "./lib/instruction-abandonment";
import {
	deleteObjectsUnderPrefix,
	type StorageBudget,
} from "./lib/instruction-prune";

/** Receipts examined on one hourly tick. */
export const MAX_INSTRUCTION_STORAGE_CLEANUP_RECEIPTS_PER_RUN = 25;
/** Prefix deletions across all receipts on one tick. */
export const MAX_INSTRUCTION_STORAGE_CLEANUP_OBJECTS_PER_RUN = 20_000;
/** Failed and page-truncated receipts wait for a later hourly pass. */
export const INSTRUCTION_STORAGE_CLEANUP_RETRY_MS = 60 * 60 * 1000;
/** Leaves headroom inside the workflow activity's five-minute timeout. */
const RUN_TIME_BUDGET_MS = 4 * 60 * 1000;

export type InstructionStorageCleanupReapResult = {
	candidates: number;
	completed: number;
	deferred: number;
	objectsDeleted: number;
	errorCount: number;
	hitCap: boolean;
};

/**
 * Deletes only the three prefixes that a deleted snapshot could own. A
 * receipt remains until every prefix reports a complete traversal: a page or
 * run budget truncation is deliberately not success.
 */
export async function reapInstructionStorageCleanupReceipts(): Promise<InstructionStorageCleanupReapResult> {
	const startedAtMs = Date.now();
	const receipts = await listDueInstructionStorageCleanupReceipts({
		now: new Date(startedAtMs),
		limit: MAX_INSTRUCTION_STORAGE_CLEANUP_RECEIPTS_PER_RUN,
	});
	const result: InstructionStorageCleanupReapResult = {
		candidates: receipts.length,
		completed: 0,
		deferred: 0,
		objectsDeleted: 0,
		errorCount: 0,
		hitCap:
			receipts.length >= MAX_INSTRUCTION_STORAGE_CLEANUP_RECEIPTS_PER_RUN,
	};
	const storage = getStorageProvider();
	const budget: StorageBudget = {
		remaining: MAX_INSTRUCTION_STORAGE_CLEANUP_OBJECTS_PER_RUN,
	};

	for (const [index, receipt] of receipts.entries()) {
		if (
			Date.now() - startedAtMs > RUN_TIME_BUDGET_MS ||
			budget.remaining <= 0
		) {
			result.hitCap = true;
			break;
		}
		safeHeartbeat({ phase: "instruction-storage-cleanup", index });
		let complete = true;
		try {
			for (const prefix of snapshotOwnedPrefixes(
				receipt.projectId,
				receipt.snapshotId,
			)) {
				if (
					Date.now() - startedAtMs > RUN_TIME_BUDGET_MS ||
					budget.remaining <= 0
				) {
					complete = false;
					result.hitCap = true;
					break;
				}
				const sweep = await deleteObjectsUnderPrefix(
					storage,
					prefix,
					budget,
				);
				result.objectsDeleted += sweep.deleted;
				if (sweep.truncated) {
					complete = false;
					break;
				}
			}
			if (complete) {
				await clearInstructionStorageCleanupReceipt(receipt.id);
				result.completed++;
			} else {
				await deferInstructionStorageCleanupReceipt({
					id: receipt.id,
					nextAttemptAt: new Date(
						Date.now() + INSTRUCTION_STORAGE_CLEANUP_RETRY_MS,
					),
					error: "truncated",
				});
				result.deferred++;
			}
		} catch (error) {
			result.errorCount++;
			result.deferred++;
			const facts = errorFacts(error);
			await deferInstructionStorageCleanupReceipt({
				id: receipt.id,
				nextAttemptAt: new Date(
					Date.now() + INSTRUCTION_STORAGE_CLEANUP_RETRY_MS,
				),
				error: facts.errorName,
			});
			logger.warn(
				{
					event: "instructions.reaper.storage_cleanup_failed",
					projectId: receipt.projectId,
					organizationId: receipt.organizationId,
					...facts,
				},
				"[InstructionReaper] Storage cleanup receipt remains pending after a failed prefix sweep",
			);
		}
	}

	logger.info(
		{ event: "instructions.reaper.storage_cleanup_completed", ...result },
		`[InstructionReaper] Completed ${result.completed} Coding Instructions storage cleanup receipt(s)`,
	);
	return result;
}
