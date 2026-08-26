import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const ItemTypeSchema = z.enum(["epic", "feature", "story", "bug"]);

export const dismissPmSyncConflictProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/dismiss-pm-sync-conflict",
		tags: ["Projects", "Stories"],
		summary: "Dismiss a PM sync conflict",
		description:
			"Clears the CONFLICT status for a hierarchy item, acknowledging the user has reviewed the diff and chosen to skip.",
	})
	.input(
		z.object({
			projectId: z.string().cuid(),
			storyId: z.string().cuid(),
			itemType: ItemTypeSchema.default("story"),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(z.object({ dismissed: z.boolean() }))
	.handler(async ({ input }) => {
		// Stories are the only work-item rows — legacy `epic`/`feature` item
		// types can't resolve a row (the folder tables were dropped) and land
		// on NOT_FOUND below.
		if (input.itemType !== "story" && input.itemType !== "bug") {
			throw new ORPCError("NOT_FOUND", {
				message: "Item not found",
			});
		}

		const row = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			select: { id: true },
		});
		if (!row) {
			throw new ORPCError("NOT_FOUND", {
				message: "Item not found",
			});
		}
		await db.userStory.update({
			where: { id: input.storyId },
			data: {
				lastPmSyncStatus: "SUCCESS" as const,
				lastPmSyncError: null,
			},
		});

		return { dismissed: true };
	});
