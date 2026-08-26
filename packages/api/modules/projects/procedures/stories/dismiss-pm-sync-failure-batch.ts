import { ORPCError } from "@orpc/client";
import { clearPmSyncFailures, db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const ItemTypeSchema = z.enum(["epic", "feature", "story", "bug"]);

const InputItemSchema = z.object({
	id: z.string().cuid(),
	itemType: ItemTypeSchema,
});

/**
 * Bulk-dismiss FAILED PM-sync items from the Review Center's Failures queue.
 *
 * Backs the bulk "Dismiss" action on the Failures tab toolbar. One atomic
 * `updateMany` scoped to the project AND to `lastPmSyncStatus = FAILED`, so
 * cross-tenant / non-failed / already-cleared ids are silently skipped and
 * reported as not dismissed. Mirrors `retryPmSyncBatch`'s ownership model
 * (project pre-check + project-scoped write) without the per-item Temporal
 * fan-out, since a dismiss is a single bounded DB write.
 */
export const dismissPmSyncFailureBatchProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/dismiss-pm-sync-failure-batch",
		tags: ["Projects", "Stories"],
		summary: "Dismiss a batch of failed PM syncs from the Review Center",
		description:
			"Clears the FAILED PM-sync flag on the selected work items so they leave the Review Center Failures queue. Backs the bulk Dismiss action. Scoped to FAILED state and the project (idempotent, tenant-guarded).",
	})
	.input(
		z.object({
			projectId: z.string().cuid(),
			items: z.array(InputItemSchema).max(200),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			dismissedCount: z.number(),
		}),
	)
	.handler(async ({ input }) => {
		if (input.items.length === 0) {
			return { dismissedCount: 0 };
		}

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		// Stories are the only work-item rows — legacy epic/feature ids can't
		// resolve a row, so filtering to story/bug is harmless (they'd no-op).
		const storyIds = input.items
			.filter((i) => i.itemType === "story" || i.itemType === "bug")
			.map((i) => i.id);

		const { cleared } = await clearPmSyncFailures({
			projectId: input.projectId,
			itemIds: storyIds,
		});

		return { dismissedCount: cleared };
	});
