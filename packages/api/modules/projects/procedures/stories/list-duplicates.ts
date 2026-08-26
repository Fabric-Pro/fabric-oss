import { ORPCError } from "@orpc/client";
import { hasProjectAccess, listPendingDuplicateLinks } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const listDuplicatesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/duplicates",
		tags: ["Projects", "Stories"],
		summary: "List pending duplicate links",
		description:
			"Pending potential-duplicate pairs detected for the project's roadmap, used to surface duplicate chips and the resolve dialog.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId ?? undefined,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}
		const links = await listPendingDuplicateLinks(input.projectId);
		return { links };
	});
