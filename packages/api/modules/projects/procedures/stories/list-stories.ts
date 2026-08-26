import { ORPCError } from "@orpc/client";
import { getStoriesForKanban, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { stripInternalStoryFieldsFromMany } from "../../lib/strip-internal-story-fields";

export const listStoriesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories",
		tags: ["Projects", "Stories"],
		summary: "List user stories",
		description:
			"Get all user stories for a project with statuses (for Kanban board)",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
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

		const { statuses, stories } = await getStoriesForKanban(
			input.projectId,
		);

		return {
			statuses,
			stories: stripInternalStoryFieldsFromMany(stories),
		};
	});
