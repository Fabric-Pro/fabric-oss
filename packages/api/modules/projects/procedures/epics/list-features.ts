import { ORPCError } from "@orpc/client";
import { hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * The Epic/Feature container hierarchy was removed; `user_story` is the only
 * work-item table. Feature CONTAINERS no longer exist, so this read endpoint
 * truthfully returns an empty list (kept non-erroring for caller
 * compatibility). Roadmap features are stories with kind=FEATURE — list them
 * via GET /projects/{projectId}/stories.
 */
export const listFeaturesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/features",
		tags: ["Projects", "Features"],
		summary:
			"List feature containers (always empty — containers were removed)",
		description:
			"Feature containers were removed; this always returns an empty list. Roadmap features are stories (kind=FEATURE) in the Stories API.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			epicId: z.string().optional(),
			showClosed: z.boolean().optional().default(false),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		return { features: [] as never[] };
	});
