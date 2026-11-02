import { ORPCError } from "@orpc/client";
import { hasProjectAccess, searchStoryDescriptions } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { resolveProjectOrganizationId } from "../../lib/project-organization";

export const searchDescriptionsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/search-descriptions",
		tags: ["Projects", "Stories"],
		summary: "Search feature descriptions",
		description: "Find description substrings within a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			needles: z
				.array(
					z
						.string()
						.min(1)
						.max(2000)
						.refine(
							(value) => value === value.toLowerCase(),
							"Needles must be lowercase",
						),
				)
				.min(1)
				.max(64),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const projectOrganizationId = await resolveProjectOrganizationId(
			input.organizationId,
			input.projectId,
		);
		const organizationId = resolveOrganizationId(
			projectOrganizationId,
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

		return {
			matches: await searchStoryDescriptions(
				input.projectId,
				input.needles,
			),
		};
	});
