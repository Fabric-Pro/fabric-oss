import { ORPCError } from "@orpc/client";
import { clearPmSyncFailure, db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const ItemTypeSchema = z.enum(["epic", "feature", "story", "bug"]);

/**
 * Dismiss a single FAILED PM-sync item from the Review Center's Failures queue.
 *
 * Clears the item's `lastPmSyncStatus` / `lastPmSyncError` so it leaves the
 * queue. Backs the per-row "Dismiss" action on a failure row — the always-
 * available terminal state for a stuck failure (a deleted PM card, a persistent
 * push error) that Retry cannot resolve.
 *
 * Idempotent and FAILED-scoped: dismissing an item that is no longer FAILED
 * (already cleared, or moved to CONFLICT/SUCCESS) is a no-op that returns
 * `dismissed: false` rather than clobbering the newer state. Does NOT touch the
 * PM tool or the item's external link — the durable "never sync again" path for
 * a deleted card is Unlink (the FLAG_MISSING recovery row).
 */
export const dismissPmSyncFailureProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/dismiss-pm-sync-failure",
		tags: ["Projects", "Stories"],
		summary: "Dismiss a failed PM sync from the Review Center",
		description:
			"Clears a work item's FAILED PM-sync flag so it leaves the Review Center Failures queue. Backs the per-row Dismiss action. Scoped to FAILED state (idempotent no-op otherwise); does not touch the PM tool or the item's external link.",
	})
	.input(
		z.object({
			projectId: z.string().cuid(),
			// `storyId` retained as the path-param name for URL consistency with
			// the sibling retry procedure; it refers to any hierarchy item ID.
			storyId: z.string().cuid(),
			itemType: ItemTypeSchema.default("story"),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			dismissed: z.boolean(),
		}),
	)
	.handler(async ({ input }) => {
		// Tenant-existence guard: the item must live in this project. Stories are
		// the only work-item rows (the folder tables were dropped), so legacy
		// epic/feature ids resolve to "not found".
		const item =
			input.itemType === "story" || input.itemType === "bug"
				? await db.userStory.findFirst({
						where: {
							id: input.storyId,
							projectId: input.projectId,
						},
						select: { id: true },
					})
				: null;
		if (!item) {
			throw new ORPCError("NOT_FOUND", { message: "Item not found" });
		}

		const { cleared } = await clearPmSyncFailure({
			itemType: input.itemType,
			itemId: input.storyId,
			projectId: input.projectId,
		});

		return { dismissed: cleared > 0 };
	});
