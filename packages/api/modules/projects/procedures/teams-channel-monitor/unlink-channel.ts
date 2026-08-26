import { ORPCError } from "@orpc/server";
import { db, unlinkTeamsChannelFromProject } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses canEditProject() - only project owners/editors can
 * unlink Teams channels.
 *
 * Unlinks a Teams channel from a project. Cascading deletes remove the
 * associated seen-message dedup rows. Existing PendingBacklogProposal rows
 * remain intact — they keep their reference to the channel via sourceMetadata
 * for historical display.
 */
export const unlinkChannelProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/teams-channel-monitor/unlink",
		tags: ["Projects", "Teams Channel Monitor"],
		summary: "Unlink a Teams channel from a project",
		description:
			"Removes a linked Teams channel and its seen-message markers.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			linkedChannelId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const tenantFilter = organizationId
			? { organizationId }
			: { organizationId: null, userId: user.id };

		const project = await db.project.findFirst({
			where: { id: input.projectId, ...tenantFilter },
			select: { id: true },
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		await unlinkTeamsChannelFromProject(
			input.projectId,
			input.linkedChannelId,
		);

		return { success: true };
	});
