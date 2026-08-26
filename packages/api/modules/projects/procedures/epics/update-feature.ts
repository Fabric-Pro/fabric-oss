import { ORPCError } from "@orpc/client";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * REMOVED — the Epic/Feature container hierarchy was dropped; `user_story` is
 * the only work-item table. Features ARE roadmap work items now (create via
 * POST /projects/{projectId}/features, manage via the Stories API). The route
 * is retained so existing callers receive a clear error instead of a 404.
 */
export const updateFeatureProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/{projectId}/features/{featureId}",
		tags: ["Projects", "Features"],
		summary: "Update feature (removed)",
		description:
			"Feature containers were removed — features are roadmap work items managed via the Stories API.",
	})
	.input(
		z.object({
			projectId: z.string(),
			featureId: z.string(),
			organizationId: z.string().nullable().optional(),
			title: z.string().min(1).max(500).optional(),
			description: z.string().optional(),
			epicId: z.string().nullable().optional(),
			order: z.number().int().min(0).optional(),
			externalId: z.string().nullable().optional(),
			externalUrl: z.string().nullable().optional(),
		}),
	)
	.handler(async () => {
		throw new ORPCError("NOT_FOUND", {
			message:
				"Feature containers were removed. Features are roadmap work items — manage them via PATCH /projects/{projectId}/stories/{storyId}.",
		});
	});
