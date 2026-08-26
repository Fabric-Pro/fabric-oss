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
export const createEpicProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/epics",
		tags: ["Projects", "Epics"],
		summary: "Create epic (removed)",
		description:
			"Epics were removed — create features as roadmap work items via POST /projects/{projectId}/features.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			title: z.string().min(1).max(500),
			description: z.string().optional(),
		}),
	)
	.handler(async () => {
		throw new ORPCError("NOT_FOUND", {
			message:
				"Epics were removed. Create features as roadmap work items via POST /projects/{projectId}/features.",
		});
	});
