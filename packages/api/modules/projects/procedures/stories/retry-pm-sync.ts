import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { retryPmSyncItem } from "../../lib/retry-pm-sync-item";

const ItemTypeSchema = z.enum(["epic", "feature", "story", "bug"]);

/**
 * Resolve a work item's current PM link, or `null` if the item doesn't
 * exist in this project. Doubles as the tenant-existence check AND supplies the
 * current `externalId`/`externalMcpServerId` that the unlink path needs to sever
 * the link with the same atomic predicate the Review Center uses. Stories are
 * the only work-item rows — legacy `epic`/`feature` item types resolve to null
 * (the folder tables were dropped).
 */
async function resolveItemLink(
	itemType: z.infer<typeof ItemTypeSchema>,
	itemId: string,
	projectId: string,
): Promise<{
	externalId: string | null;
	externalMcpServerId: string | null;
} | null> {
	if (itemType !== "story" && itemType !== "bug") {
		return null;
	}
	return db.userStory.findFirst({
		where: { id: itemId, projectId },
		select: { externalId: true, externalMcpServerId: true },
	});
}

export const retryPmSyncProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/retry-pm-sync",
		tags: ["Projects", "Stories"],
		summary: "Retry PM sync for a single hierarchy item",
		description:
			"Re-enqueues `syncWorkItemToPM` for a single hierarchy item (story/bug/feature/epic). Backs the Retry button on the failure panel and the Push anyway action on the diff modal. With `unlinkFirst`, severs a dead PM link first so the push re-creates a fresh card (the failure panel's 'Unlink & re-create' action for a deleted PM card).",
	})
	.input(
		z.object({
			projectId: z.string().cuid(),
			// `storyId` retained as the path-param name for URL stability;
			// it now refers to any hierarchy item ID. `itemType` is required.
			storyId: z.string().cuid(),
			itemType: ItemTypeSchema.default("story"),
			pushAnyway: z.boolean().default(false),
			/**
			 * "Unlink & re-create": clear the item's external PM link (and dismiss
			 * any pending FLAG_MISSING unlink proposal) BEFORE syncing, so the push
			 * takes the CREATE path and makes a fresh card. For a deleted PM card
			 * (404) where a plain retry would just re-fail. User-initiated — the
			 * safe, direct counterpart to accepting the Review-Center unlink.
			 */
			unlinkFirst: z.boolean().default(false),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			enqueued: z.boolean(),
			workflowId: z.string().optional(),
			reason: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		const item = await resolveItemLink(
			input.itemType,
			input.storyId,
			input.projectId,
		);
		if (!item) {
			throw new ORPCError("NOT_FOUND", { message: "Item not found" });
		}

		// Shared with `retryPmSyncBatch` so the deleted-card unlink-and-recreate
		// path (sever the dead link → dismiss the pending FLAG_MISSING → forced
		// initial push) has one implementation and the bulk path inherits the
		// single-item BUG-retry behavior with no divergence.
		const result = await retryPmSyncItem({
			itemId: input.storyId,
			itemType: input.itemType,
			projectId: input.projectId,
			userId: user.id,
			pushAnyway: input.pushAnyway,
			unlinkFirst: input.unlinkFirst,
			externalId: item.externalId,
			externalMcpServerId: item.externalMcpServerId,
		});

		return {
			enqueued: result.enqueued,
			workflowId: result.workflowId,
			reason: result.reason,
		};
	});
