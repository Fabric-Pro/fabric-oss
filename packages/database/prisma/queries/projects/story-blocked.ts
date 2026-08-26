import { db, type LastEditSource } from "../../client";
import { createFeatureVersion } from "./feature-versions";
import { StoryVersionConflictError } from "./stories";

/**
 * Normalize the stored reason: a trimmed non-empty string when blocking, else
 * null (cleared on unblock, and whitespace-only input drops to null). Pure —
 * unit-tested.
 */
export function normalizeBlockReason(
	blocked: boolean,
	reason?: string | null,
): string | null {
	return blocked ? reason?.trim() || null : null;
}

/**
 * The version-history changeDescription for a block/unblock. Pure — unit-tested.
 */
export function blockChangeDescription(
	blocked: boolean,
	reason: string | null,
): string {
	return blocked ? `Blocked${reason ? `: ${reason}` : ""}` : "Unblocked";
}

/**
 * Set or clear the Blocked flag on a work item (UserStory), with an optional
 * reason. Mirrors the apply-terminal-* pattern: bumps the story `version` and
 * writes a `FeatureVersionHistory` snapshot in the same transaction, so the
 * block/unblock is reflected in the work item's version history. Scoped by
 * `projectId` for tenant safety. Returns null when the story isn't found.
 */
export async function setStoryBlocked(
	storyId: string,
	projectId: string,
	data: {
		blocked: boolean;
		reason?: string | null;
		userId?: string;
		organizationId?: string | null;
		lastEditedByName?: string | null;
		lastEditedSource: LastEditSource;
		/**
		 * When blocking, leave an already-blocked item untouched (no reason
		 * overwrite, no version-history entry). Used by the scan's auto-block so a
		 * re-scan doesn't clobber a manual reason or spam the history — and so a
		 * manually-set block "stays there until removed manually".
		 */
		skipIfAlreadyBlocked?: boolean;
	},
): Promise<{
	blocked: boolean;
	blockedReason: string | null;
	identifier: string;
} | null> {
	return db.$transaction(async (tx) => {
		const story = await tx.userStory.findFirst({
			where: { id: storyId, projectId },
			select: {
				id: true,
				identifier: true,
				version: true,
				description: true,
				acceptanceCriteria: true,
				draftingStage: true,
				blocked: true,
				blockedReason: true,
				updatedAt: true,
			},
		});
		if (!story) {
			return null;
		}

		// Idempotent auto-block: if it's already blocked, keep the existing
		// reason/version untouched.
		if (data.skipIfAlreadyBlocked && data.blocked && story.blocked) {
			return {
				blocked: true,
				blockedReason: story.blockedReason,
				identifier: story.identifier,
			};
		}

		const reason = normalizeBlockReason(data.blocked, data.reason);
		if (story.blocked === data.blocked && story.blockedReason === reason) {
			return {
				blocked: story.blocked,
				blockedReason: story.blockedReason,
				identifier: story.identifier,
			};
		}
		const newVersion = story.version + 1;
		const changedAt = new Date();

		const updated = await tx.userStory.updateMany({
			// Concurrency token is `version`, not the row clock: `updatedAt`
			// also moves on derived writes, which would fail this save
			// with a spurious conflict.
			where: { id: storyId, projectId, version: story.version },
			data: {
				blocked: data.blocked,
				blockedReason: reason,
				version: newVersion,
				lastEditedAt: changedAt,
				lastEditedByName: data.lastEditedByName ?? null,
				lastEditedSource: data.lastEditedSource,
			},
		});
		if (updated.count === 0) {
			throw new StoryVersionConflictError(storyId);
		}

		await createFeatureVersion(
			{
				storyId: story.id,
				version: newVersion,
				description: story.description ?? null,
				acceptanceCriteria: story.acceptanceCriteria ?? null,
				draftingStage: story.draftingStage,
				changeDescription: blockChangeDescription(data.blocked, reason),
				changedBy: data.userId ?? undefined,
				userId: data.userId ?? undefined,
				organizationId: data.organizationId ?? undefined,
			},
			tx,
		);

		return {
			blocked: data.blocked,
			blockedReason: reason,
			identifier: story.identifier,
		};
	});
}
