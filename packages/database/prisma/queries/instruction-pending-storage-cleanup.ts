/**
 * Durable cleanup receipts for Coding Instructions objects that outlive their
 * snapshot rows. The record is deliberately independent from the snapshot:
 * a row-first delete is safe only when a later activity can still find the
 * three owned prefixes after that row is gone.
 */
import { db } from "../client";
import type { Prisma } from "../generated/client";

/**
 * Every staging PUT capability expires within this window. A receipt waits
 * this long after the row commit before its first sweep. This bounds usable
 * capabilities; it does not prove an already-started storage request has
 * completed.
 */
export const INSTRUCTION_STORAGE_CLEANUP_GRACE_MS = 60 * 60 * 1000;

/** One due receipt, selected system-wide by the storage reaper. */
export type PendingInstructionStorageCleanup = {
	id: string;
	snapshotId: string;
	projectId: string;
	organizationId: string;
	attempts: number;
};

const RECEIPT_SELECT = {
	id: true,
	snapshotId: true,
	projectId: true,
	organizationId: true,
	attempts: true,
} as const;

/**
 * Creates the receipt inside the transaction that removes the snapshot row.
 * The caller must not use this as a standalone queue: committing it without
 * the matching delete would let the reaper remove live prefixes.
 */
export async function createInstructionStorageCleanupReceipt(
	client: Prisma.TransactionClient,
	input: {
		snapshotId: string;
		projectId: string;
		organizationId: string;
		now?: Date;
	},
): Promise<void> {
	const now = input.now ?? new Date();
	const notBefore = new Date(
		now.getTime() + INSTRUCTION_STORAGE_CLEANUP_GRACE_MS,
	);
	await client.projectInstructionPendingStorageCleanup.create({
		data: {
			snapshotId: input.snapshotId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			notBefore,
			nextAttemptAt: notBefore,
		},
	});
}

/**
 * Returns a bounded system-wide page of receipts whose grace/backoff period
 * has elapsed. Each row carries its own organization id because the record
 * intentionally has no parent relation left to resolve it through.
 */
export async function listDueInstructionStorageCleanupReceipts(input: {
	now: Date;
	limit: number;
}): Promise<PendingInstructionStorageCleanup[]> {
	return await db.projectInstructionPendingStorageCleanup.findMany({
		where: { nextAttemptAt: { lte: input.now } },
		orderBy: [
			{ nextAttemptAt: "asc" },
			{ createdAt: "asc" },
			{ id: "asc" },
		],
		take: input.limit,
		select: RECEIPT_SELECT,
	});
}

/** Clear a receipt only after every owned prefix has been fully swept. */
export async function clearInstructionStorageCleanupReceipt(
	id: string,
): Promise<void> {
	await db.projectInstructionPendingStorageCleanup.deleteMany({
		where: { id },
	});
}

/**
 * Keep a failed or truncated sweep durable and move it to a later bounded
 * retry. `updateMany` treats an overlapping successful drain as an idempotent
 * no-op rather than turning a completed cleanup into an activity failure.
 */
export async function deferInstructionStorageCleanupReceipt(input: {
	id: string;
	nextAttemptAt: Date;
	error?: string;
}): Promise<void> {
	await db.projectInstructionPendingStorageCleanup.updateMany({
		where: { id: input.id },
		data: {
			attempts: { increment: 1 },
			nextAttemptAt: input.nextAttemptAt,
			lastError: input.error,
		},
	});
}
