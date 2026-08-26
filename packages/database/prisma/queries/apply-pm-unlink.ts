import { db } from "../client";
import type { PmStateChangeEntityType, Prisma } from "../generated/client";

type Tx = Prisma.TransactionClient;

export interface ApplyPmUnlinkParams {
	projectId: string;
	entityType: PmStateChangeEntityType;
	entityId: string;
	expectedExternalId: string;
	expectedExternalMcpServerId: string | null;
}

/**
 * Transaction-form unlink: severs an entity's external PM link on a caller-
 * provided tx client, so the Accept path can claim the pending row and unlink
 * atomically in one transaction (#1360). Same atomic externalId + projectId +
 * server guard (updateMany count === 1) as before; also deletes the entity's
 * missing-streak rows. Returns { applied:false } and clears nothing on count 0.
 */
export async function applyPmUnlinkTx(
	tx: Tx,
	{
		projectId,
		entityType,
		entityId,
		expectedExternalId,
		expectedExternalMcpServerId,
	}: ApplyPmUnlinkParams,
): Promise<{ applied: boolean }> {
	const where = {
		id: entityId,
		projectId,
		externalId: expectedExternalId,
		externalMcpServerId: expectedExternalMcpServerId,
	};

	// Stories are the only work-item rows since the Epic/Feature folder tables
	// were dropped. Legacy EPIC/FEATURE pending rows can't match a user_story id,
	// so they naturally resolve to { applied: false } via count 0.
	if (entityType !== "STORY") {
		return { applied: false };
	}

	const { count } = await tx.userStory.updateMany({
		where,
		data: {
			externalId: null,
			externalUrl: null,
			externalMcpServerId: null,
			pmTicketTerminal: false,
			pmTicketTerminalStatus: null,
			pmAutoHidden: false,
			lastSyncedPmHash: null,
			lastSyncedAt: null,
			lastPmSyncStatus: null,
			lastPmSyncError: null,
			lastPmSyncAttemptAt: null,
			lastSyncedStatusId: null,
		},
	});

	if (count !== 1) {
		return { applied: false };
	}

	await tx.pmTicketMissingStreak.deleteMany({
		where: { projectId, entityType, entityId },
	});

	return { applied: true };
}

/**
 * Standalone unlink (own transaction). Thin wrapper over `applyPmUnlinkTx` so
 * existing direct callers / unit tests keep their contract.
 */
export async function applyPmUnlink(
	params: ApplyPmUnlinkParams,
): Promise<{ applied: boolean }> {
	return await db.$transaction((tx) => applyPmUnlinkTx(tx, params));
}
