import { ORPCError } from "@orpc/client";
import {
	computeGroupMemberCounts,
	getProjectMemberFunctionTags,
	hasProjectAccess,
} from "@repo/database";
import { isFunctionTagsEnabled } from "@repo/utils/feature-flag";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Member counts per function-tag group, for the client large-group confirm
 * gate (#1767 Stage 5). Flag-gated (returns {} when off). Same auth shape as
 * `listForProject`: PROJECT_MEMBERS_READ + explicit hasProjectAccess re-check.
 */
export const groupMemberCountsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_MEMBERS_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/function-tags/group-counts",
		tags: ["Function Tags"],
		summary: "Group-mention member counts",
	})
	.input(z.object({ projectId: z.string() }))
	.output(z.record(z.string(), z.number()))
	.handler(async ({ input, context }) => {
		if (!isFunctionTagsEnabled()) {
			return {};
		}
		const hasAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}
		const roster = await getProjectMemberFunctionTags(input.projectId);
		return computeGroupMemberCounts(roster);
	});
