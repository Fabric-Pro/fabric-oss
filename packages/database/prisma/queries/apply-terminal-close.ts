import { db, type FeatureDraftingStage } from "../client";
import type { PmStateChangeEntityType } from "../generated/client";
import { createFeatureVersion } from "./projects/feature-versions";

export interface ApplyTerminalCloseParams {
	entityType: PmStateChangeEntityType;
	entityId: string;
	projectId: string;
	userId: string | null;
	lastEditedByName?: string | null;
	organizationId: string | null;
	/** Audit/version note, e.g. the reason the item was closed. */
	changeDescription: string;
	/** When true (the auto-hide poll path), marks the story as auto-hidden. */
	markAutoHidden?: boolean;
}

/**
 * Sets draftingStage=CLOSED on a roadmap entity. For STORY it also bumps
 * version and writes a FeatureVersion audit row (mirrors the prior inline
 * `applyHide`). Shared by the pending-review procedures and the ADO auto-hide
 * poll path so the close-with-version logic lives in one place.
 *
 * Transactional + idempotent (#1360): the scheduled poll and a future manual
 * Pull can both call this concurrently. STORY runs a guarded `updateMany`
 * (optimistic-lock predicate on id + projectId + current draftingStage +
 * version) and the FeatureVersion write inside one `db.$transaction`, so a
 * version-write failure rolls back the row transition. Legacy EPIC/FEATURE
 * pending rows are no-ops (the folder tables were dropped).
 *
 * Returns `{ applied: true }` when the close was written, or `{ applied: false }`
 * when the entity is missing, already CLOSED, or the guard lost a concurrent
 * race (updateMany count !== 1). Callers MUST treat `{ applied: false }` as a
 * no-op (dismiss the pending-review row) rather than recording it as success.
 */
export async function applyTerminalClose({
	entityType,
	entityId,
	projectId,
	userId,
	lastEditedByName,
	organizationId,
	changeDescription,
	markAutoHidden,
}: ApplyTerminalCloseParams): Promise<{ applied: boolean }> {
	const now = new Date();

	// Stories are the only work-item rows since the Epic/Feature folder tables
	// were dropped. Legacy EPIC/FEATURE pending rows are no-ops.
	if (entityType !== "STORY") {
		return { applied: false };
	}

	{
		const story = await db.userStory.findUnique({
			where: { id: entityId, projectId },
			select: {
				id: true,
				version: true,
				description: true,
				acceptanceCriteria: true,
				draftingStage: true,
			},
		});
		if (!story) {
			return { applied: false };
		}
		if (story.draftingStage === "CLOSED") {
			return { applied: false };
		}

		const newVersion = (story.version ?? 1) + 1;

		return await db.$transaction(async (tx) => {
			// Guarded transition: only the writer that still sees the pre-CLOSED
			// row (same draftingStage + version) wins. A concurrent close that
			// already flipped the row → count 0 → no-op (no duplicate version).
			const upd = await tx.userStory.updateMany({
				where: {
					id: entityId,
					projectId,
					draftingStage: story.draftingStage,
					version: story.version,
				},
				data: {
					draftingStage: "CLOSED",
					draftingStageUpdatedAt: now,
					version: newVersion,
					pmAutoHidden: markAutoHidden === true,
					lastEditedAt: now,
					lastEditedByName: lastEditedByName ?? null,
					lastEditedSource: "PM_PULL",
				},
			});
			if (upd.count !== 1) {
				return { applied: false };
			}

			// Same tx as the guarded updateMany: if this throws, the row
			// transition rolls back (no state-without-history corruption).
			await createFeatureVersion(
				{
					storyId: story.id,
					version: newVersion,
					description: story.description ?? null,
					acceptanceCriteria: story.acceptanceCriteria ?? null,
					draftingStage: "CLOSED" as FeatureDraftingStage,
					changeDescription,
					changedBy: userId ?? undefined,
					userId: userId ?? undefined,
					organizationId: organizationId ?? undefined,
				},
				tx,
			);
			return { applied: true };
		});
	}
}
