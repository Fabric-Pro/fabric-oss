import { ORPCError } from "@orpc/client";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * REMOVED — the Epic/Feature container hierarchy was dropped; `user_story` is
 * the only work-item table, so a "hierarchy" no longer exists. The route is
 * retained so existing callers receive a clear error instead of a 404.
 */
export const getHierarchyProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/hierarchy",
		tags: ["Projects", "Epics"],
		summary: "Get project hierarchy (removed)",
		description:
			"The Epic/Feature hierarchy was removed — fetch the flat work-item list via GET /projects/{projectId}/stories.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async () => {
		throw new ORPCError("NOT_FOUND", {
			message:
				"The Epic/Feature hierarchy was removed. Fetch the flat work-item list via GET /projects/{projectId}/stories.",
		});
	});
