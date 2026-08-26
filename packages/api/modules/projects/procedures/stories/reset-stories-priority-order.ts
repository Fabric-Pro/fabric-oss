import { clearStoriesPriorityOrder } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Drop the shared manual rank for one work-item kind, so the Priority layout
 * falls back to its computed order. Scoped to a kind because the layout ranks
 * bugs and features independently — resetting Bugs must leave Features alone.
 */
export const resetStoriesPriorityOrderProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/reset-priority-order",
		tags: ["Projects", "Stories"],
		summary: "Clear the manual rank for one work-item kind",
		description:
			"Sets UserStory.priorityOrder to NULL for every story of the given kind in the project, restoring the computed ranking.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			kind: z.enum(["FEATURE", "BUG"]),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const cleared = await clearStoriesPriorityOrder(
			input.projectId,
			input.kind,
		);

		recordAuditFromRequest(context, {
			action: "story.updated",
			category: "story",
			organizationId,
			projectId: input.projectId,
			resource: { type: "story", id: input.projectId, name: null },
			metadata: {
				changedFields: ["priorityOrder"],
				via: "priority-reset",
				kind: input.kind,
				count: cleared,
			},
		});

		return { cleared };
	});
