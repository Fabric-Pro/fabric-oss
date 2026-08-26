import { ORPCError } from "@orpc/client";
import {
	createDefaultStoryStatuses,
	hasProjectAccess,
	listStoryStatuses,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

export const listStoryStatusesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/statuses",
		tags: ["Projects", "Stories"],
		summary: "List story statuses",
		description: "Get all story statuses (Kanban columns) for a project",
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

		let statuses = await listStoryStatuses(input.projectId);

		// Auto-create default statuses if none exist (better UX)
		if (statuses.length === 0) {
			await createDefaultStoryStatuses(input.projectId);
			statuses = await listStoryStatuses(input.projectId);
		}

		return { statuses };
	});
