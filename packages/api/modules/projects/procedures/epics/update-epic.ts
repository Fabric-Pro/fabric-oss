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
export const updateEpicProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/epics/{epicId}",
		tags: ["Projects", "Epics"],
		summary: "Update epic (removed)",
		description:
			"Epics were removed — work items are managed via the Stories API.",
	})
	.input(
		z.object({
			projectId: z.string(),
			epicId: z.string(),
			organizationId: z.string().nullable().optional(),
			title: z.string().min(1).max(500).optional(),
			description: z.string().optional(),
			order: z.number().int().min(0).optional(),
			externalId: z.string().nullable().optional(),
			externalUrl: z.string().nullable().optional(),
		}),
	)
	.handler(async () => {
		throw new ORPCError("NOT_FOUND", {
			message:
				"Epics were removed. Work items are managed via PATCH /projects/{projectId}/stories/{storyId}.",
		});
	});
