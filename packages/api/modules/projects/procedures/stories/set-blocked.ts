import { ORPCError } from "@orpc/server";
import { hasProjectAccess, setStoryBlocked } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Block or unblock a work item (UserStory) with an optional reason. Used both
 * from the work-item detail page (manual) and from a Security & Accessibility
 * finding ("Block F-XXX", reason = the finding). The change is recorded in the
 * work item's version history (see `setStoryBlocked`).
 */
export const setBlockedProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/blocked",
		tags: ["Projects", "Stories"],
		summary: "Block or unblock a work item",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			storyId: z.string(),
			blocked: z.boolean(),
			reason: z.string().max(2000).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const hasAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const result = await setStoryBlocked(input.storyId, input.projectId, {
			blocked: input.blocked,
			reason: input.reason ?? null,
			userId: context.user.id,
			organizationId,
			lastEditedByName: context.user.name ?? null,
			lastEditedSource: "MANUAL",
		});
		if (!result) {
			throw new ORPCError("NOT_FOUND", {
				message: "Work item not found",
			});
		}
		return result;
	});
