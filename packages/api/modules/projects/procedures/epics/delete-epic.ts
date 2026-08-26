import { ORPCError } from "@orpc/client";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * REMOVED — the Epic/Feature container hierarchy was dropped; `user_story` is
 * the only work-item table. The route is retained so existing callers receive
 * a clear error instead of a 404.
 */
export const deleteEpicProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_DELETE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/epics/{epicId}",
		tags: ["Projects", "Epics"],
		summary: "Delete epic (removed)",
		description:
			"Epics were removed — work items are managed via the Stories API.",
	})
	.input(
		z.object({
			projectId: z.string(),
			epicId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async () => {
		throw new ORPCError("NOT_FOUND", {
			message:
				"Epics were removed. Work items are managed via the Stories API.",
		});
	});
