import { ORPCError } from "@orpc/client";
import { getStoriesForBoard, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { resolveProjectOrganizationId } from "../../lib/project-organization";
import { stripInternalStoryFieldsFromMany } from "../../lib/strip-internal-story-fields";

export const boardStoriesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/board",
		tags: ["Projects", "Stories"],
		summary: "Load feature board",
		description: "Get lightweight user stories and statuses for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
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

		const { statuses, stories } = await getStoriesForBoard(input.projectId);

		return {
			statuses,
			stories: stripInternalStoryFieldsFromMany(stories),
		};
	});
