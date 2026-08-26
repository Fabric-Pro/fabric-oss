import { db, type FeatureDraftingStage } from "../client";
import type { PmStateChangeEntityType } from "../generated/client";
import { createFeatureVersion } from "./projects/feature-versions";

export interface ApplyTerminalUnhideParams {
	entityType: PmStateChangeEntityType;
	entityId: string;
	projectId: string;
	userId: string | null;
	lastEditedByName?: string | null;
	organizationId: string | null;
	/** Audit/version note. */
	changeDescription: string;
}

/**
 * Reverses a PM-driven close (#1360). For STORY: restores draftingStage=DRAFT
 * (the manual-reopen convention), clears the terminal/auto-hide markers, bumps
 * version and writes a FeatureVersion. Legacy EPIC/FEATURE pending rows are
 * no-ops (the folder tables were dropped). Shared by the STORY poll
 * auto-unhide path and the single-row pending-review UNHIDE approval.
 *
 * Returns `{ applied: true }` when the unhide was written, or `{ applied: false }`
 * when the entity is missing or the idempotency guard fires (entity not CLOSED or
 * not pmAutoHidden). Callers that receive `{ applied: false }` MUST dismiss the
 * pending-review row instead of approving it to avoid recording no-ops as success.
 */
export async function applyTerminalUnhide({
	entityType,
	entityId,
	projectId,
	userId,
	lastEditedByName,
	organizationId,
	changeDescription,
}: ApplyTerminalUnhideParams): Promise<{ applied: boolean }> {
	const now = new Date();

	// Stories are the only work-item rows since the Epic/Feature folder tables
	// were dropped. Legacy EPIC/FEATURE pending rows are no-ops.
	if (entityType !== "STORY") {
		return { applied: false };
	}

	const story = await db.userStory.findUnique({
		where: { id: entityId, projectId },
		select: {
			id: true,
			version: true,
			description: true,
			acceptanceCriteria: true,
			draftingStage: true,
			pmAutoHidden: true,
		},
	});
	if (!story) {
		return { applied: false };
	}

	// Idempotency guard: only reverse an auto-hide if the story is still
	// in the exact state the auto-hide produced (CLOSED + pmAutoHidden:true).
	// A stale PENDING UNHIDE row approved after the story was already
	// manually re-opened would otherwise double-apply (bogus version history).
	if (story.draftingStage !== "CLOSED" || story.pmAutoHidden !== true) {
		return { applied: false };
	}

	const newVersion = (story.version ?? 1) + 1;

	// Guarded compare-and-swap + version snapshot in one transaction (#1360).
	// The pre-tx findUnique above is only a cheap fast-path: the real
	// concurrency boundary is the guarded updateMany inside the tx, mirroring
	// applyTerminalClose. Two concurrent unhide calls both read version N and
	// pass the pre-tx guard, but only the writer whose predicate still matches
	// (CLOSED + pmAutoHidden + version N) wins (count 1); the loser sees count 0
	// → no row write, no duplicate FeatureVersion history, { applied: false }.
	return await db.$transaction(async (tx) => {
		const upd = await tx.userStory.updateMany({
			where: {
				id: entityId,
				projectId,
				draftingStage: "CLOSED",
				pmAutoHidden: true,
				version: story.version,
			},
			data: {
				draftingStage: "DRAFT",
				draftingStageUpdatedAt: now,
				version: newVersion,
				pmAutoHidden: false,
				pmTicketTerminal: false,
				pmTicketTerminalStatus: null,
				lastEditedAt: now,
				lastEditedByName: lastEditedByName ?? null,
				lastEditedSource: "PM_PULL",
			},
		});
		if (upd.count !== 1) {
			return { applied: false };
		}

		// Same tx as the guarded updateMany: a version-write failure rolls back
		// the row transition (no state-without-history corruption).
		await createFeatureVersion(
			{
				storyId: story.id,
				version: newVersion,
				description: story.description ?? null,
				acceptanceCriteria: story.acceptanceCriteria ?? null,
				draftingStage: "DRAFT" as FeatureDraftingStage,
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
