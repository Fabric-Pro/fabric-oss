import { ORPCError } from "@orpc/server";
import {
	db,
	deactivateLinkedTeamsChat,
	reactivateLinkedTeamsChat,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: `PROJECT_SETTINGS_EDIT` (project admins and owners), matching
 * the meeting equivalent.
 *
 * Pausing a chat is not destructive, but it is the non-destructive half of a
 * pair whose other half destroys context, and holding both to the same floor is
 * what keeps the menu legible: everything that changes whether a conversation
 * feeds the project is an admin action. Linking deliberately stays at
 * `PROJECT_UPDATE` — a team member may need to add a chat the owner was not in
 * (Fizzy #2355).
 *
 * "Pause" writes one nullable timestamp and nothing else. No seen-message row,
 * no cursor, no context, no vector is touched, which is the entire point: it is
 * the answer to "stop pulling new messages out of this conversation, and keep
 * everything it already gave me."
 */
export const setChatActiveProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/{projectId}/teams-chat-monitor/set-active",
		tags: ["Projects", "Teams Chat Monitor"],
		summary: "Pause or resume scanning a linked Teams chat",
		description:
			"Stops the monitor scanning one linked chat while keeping the conversation context it has already captured, or resumes it.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			linkedChatId: z.string(),
			active: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// The organization is a property of the project, not a caller claim.
		// `requireProjectPermission` has already authorized this project for
		// this user, so the authorized row is the only honest source of the
		// tenant — reading it from the input would let a caller choose which
		// tenant this request is accounted to.
		const project = await db.project.findFirst({
			where: { id: input.projectId },
			select: { id: true, organizationId: true },
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		// Scoped by projectId as well as id: the id alone would let a caller in
		// one project pause a chat linked to another.
		const chat = await db.projectLinkedTeamsChat.findFirst({
			where: { id: input.linkedChatId, projectId: input.projectId },
			select: { id: true },
		});

		if (!chat) {
			throw new ORPCError("NOT_FOUND", {
				message: "Linked chat not found",
			});
		}

		const updated = input.active
			? await reactivateLinkedTeamsChat({
					projectId: input.projectId,
					linkedChatId: input.linkedChatId,
				})
			: await deactivateLinkedTeamsChat({
					projectId: input.projectId,
					linkedChatId: input.linkedChatId,
					userId: user.id,
				});

		recordAuditFromRequest(context, {
			action: "project.context_source.scan_stopped",
			category: "project",
			organizationId: project.organizationId ?? undefined,
			projectId: input.projectId,
			resource: { type: "linked_teams_chat", id: input.linkedChatId },
			metadata: {
				provider: "MICROSOFT_TEAMS_CHAT",
				active: input.active,
			},
		});

		return {
			success: true,
			linkedChatId: updated.id,
			deactivatedAt: updated.deactivatedAt,
		};
	});
