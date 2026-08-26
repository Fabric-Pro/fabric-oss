import { ORPCError } from "@orpc/client";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * REMOVED — the Epic/Feature container hierarchy was dropped; `user_story` is
 * the only work-item table. Features ARE roadmap work items now. The route is
 * retained so existing callers receive a clear error instead of a 404.
 */
export const deleteFeatureProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_DELETE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/features/{featureId}",
		tags: ["Projects", "Features"],
		summary: "Delete feature (removed)",
		description:
			"Feature containers were removed — features are roadmap work items managed via the Stories API.",
	})
	.input(
		z.object({
			projectId: z.string(),
			featureId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async () => {
		throw new ORPCError("NOT_FOUND", {
			message:
				"Feature containers were removed. Features are roadmap work items — manage them via the Stories API.",
		});
	});
