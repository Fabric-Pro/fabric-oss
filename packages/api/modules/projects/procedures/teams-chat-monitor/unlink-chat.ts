import { ORPCError } from "@orpc/server";
import { db, unlinkTeamsChatFromProject } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses canEditProject() - only project owners/editors can
 * unlink Teams chats.
 *
 * Unlinks a Teams chat from a project. Cascading deletes remove the
 * associated seen-message dedup rows. Existing PendingBacklogProposal rows
 * remain intact — they keep their reference to the chat via sourceMetadata
 * for historical display.
 */
export const unlinkChatProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/teams-chat-monitor/unlink",
		tags: ["Projects", "Teams Chat Monitor"],
		summary: "Unlink a Teams chat from a project",
		description:
			"Removes a linked Teams chat and its seen-message markers.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			linkedChatId: z.string(),
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

		await unlinkTeamsChatFromProject(input.projectId, input.linkedChatId);

		return { success: true };
	});
