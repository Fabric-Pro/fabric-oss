import { ORPCError } from "@orpc/client";
import { db, reorderStoriesPriority } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * A drag pins the whole visible sequence for one work-item kind, so the payload
 * is as large as the backlog. This has to exceed any realistic project or the
 * gesture simply fails — an earlier 500 cap silently broke every drag on a
 * larger backlog, because the client sends the full list by design. The write is
 * a single statement, so the ceiling costs nothing; it exists only to bound the
 * request body.
 */
const MAX_REORDERED_STORIES = 5000;

/**
 * Persist the shared manual rank for the roadmap's Priority layout. The client
 * sends the full visible sequence for one work-item kind; every id is pinned to
 * its position, which is what makes a hand-placed order survive a reload.
 *
 * Priority is Fabric-only, so — like the Roadmap move path — this never enqueues
 * a PM sync.
 */
export const reorderStoriesPriorityProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/reorder-priority",
		tags: ["Projects", "Stories"],
		summary: "Set the shared manual rank for the Priority layout",
		description:
			"Writes UserStory.priorityOrder for the supplied stories. Ids outside the project are rejected. Emits one story.updated audit row for the batch.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			storyOrders: z
				.array(
					z.object({
						id: z.string(),
						priorityOrder: z.number().finite(),
					}),
				)
				.min(1)
				.max(MAX_REORDERED_STORIES),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const ids = input.storyOrders.map((entry) => entry.id);
		if (new Set(ids).size !== ids.length) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Duplicate story ids in reorder payload",
			});
		}

		// The UPDATE statements are project-scoped, so a foreign id would silently
		// affect nothing. Reject it instead: a caller sending ids from another
		// project has a bug, and a silent partial write would be invisible.
		const owned = await db.userStory.count({
			where: { projectId: input.projectId, id: { in: ids } },
		});
		if (owned !== ids.length) {
			throw new ORPCError("BAD_REQUEST", {
				message: "One or more work items do not belong to this project",
			});
		}

		await reorderStoriesPriority(input.projectId, input.storyOrders);

		recordAuditFromRequest(context, {
			action: "story.updated",
			category: "story",
			organizationId,
			projectId: input.projectId,
			resource: { type: "story", id: input.projectId, name: null },
			metadata: {
				changedFields: ["priorityOrder"],
				via: "priority-drag",
				count: ids.length,
			},
		});

		return { success: true };
	});
