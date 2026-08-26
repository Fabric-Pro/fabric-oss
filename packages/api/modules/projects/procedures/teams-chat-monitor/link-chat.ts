import { ORPCError } from "@orpc/server";
import {
	db,
	ensureTeamsChatIntegrationContext,
	linkTeamsChatToProject,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses canEditProject() - only project owners/editors can link
 * Teams chats to a project.
 *
 * Links a Microsoft Teams group chat to a project for the scheduled chat
 * monitor workflow. Idempotent on (projectId, chatId).
 *
 * When backfillMode is "from-now" (default), the cursor is seeded to the
 * current timestamp so the first poll tick only sees messages posted after
 * linking. When "latest-30", the cursor stays null so the first tick backfills
 * up to 30 historical messages.
 */
export const linkChatProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/teams-chat-monitor/link",
		tags: ["Projects", "Teams Chat Monitor"],
		summary: "Link a Teams chat to a project",
		description:
			"Links a Microsoft Teams group chat to a project for scheduled monitoring.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			chatId: z.string(),
			chatTopic: z.string().optional(),
			chatType: z.string().optional(),
			chatWebUrl: z.string().optional(),
			backfillMode: z.enum(["from-now", "latest-30"]).default("from-now"),
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

		const linkedChat = await linkTeamsChatToProject({
			projectId: input.projectId,
			chatId: input.chatId,
			chatTopic: input.chatTopic,
			chatWebUrl: input.chatWebUrl,
			backfillMode: input.backfillMode,
			userId: user.id,
			organizationId,
		});

		// Also register the chat as a ProjectContext INTEGRATION source so it
		// shows up in the on-demand AI Update source picker and is fetchable by
		// backlog analysis (both read ProjectContext.metadata). Best-effort: the
		// monitor link is the primary action and must not fail if this doesn't.
		try {
			await ensureTeamsChatIntegrationContext({
				projectId: input.projectId,
				chatId: input.chatId,
				chatTopic: input.chatTopic,
				chatType: input.chatType,
				userId: user.id,
				organizationId,
			});
		} catch (error) {
			logger.warn(
				"[TeamsChatMonitor] Failed to register integration context",
				{
					projectId: input.projectId,
					chatId: input.chatId,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
		}

		return linkedChat;
	});
