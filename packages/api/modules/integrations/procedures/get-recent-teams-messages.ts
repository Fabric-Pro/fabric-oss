/**
 * Get Recent Teams Messages for Project
 *
 * Fetches the most recent messages from Microsoft Teams chats and channels
 * linked to a project. Used by the DocumentEditor to provide Teams context
 * during chat editing.
 *
 * Supports both group chats (via get_chat_messages) and team channels
 * (via list_messages) based on the stored metadata chatType.
 */

import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import type { ProjectContextType } from "@repo/database/prisma/client";
import {
	executeMicrosoftTeamsTool,
	isMicrosoftNotConnectedError,
} from "@repo/integrations/microsoft";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

// Response type for a single Teams message
interface TeamsMessage {
	id: string;
	content: string;
	from: string;
	createdAt?: string;
	chatId: string;
	chatName: string;
}

// Internal type for parsed Teams contexts (both chats and channels)
interface TeamsContext {
	type: "chat" | "channel";
	chatId?: string;
	teamId?: string;
	channelId?: string;
	displayName: string;
}

export const getRecentTeamsMessagesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.INTEGRATION_READ))
	.route({
		method: "GET",
		path: "/integrations/teams/recent-messages",
		tags: ["Integrations", "Teams"],
		summary: "Get recent Teams messages for a project",
		description:
			"Fetches the most recent messages from Teams chats and channels linked to a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			limit: z.number().min(1).max(50).default(10),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const { projectId, limit } = input;

		/**
		 * AUTHORIZATION: Uses hasProjectAccess() - verifies org membership + project access
		 * This ensures users can only fetch Teams messages for projects they have access to
		 */
		const hasAccess = await hasProjectAccess(
			projectId,
			userId,
			organizationId ?? undefined,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Find Teams integration contexts for this project
		const integrationContexts = await db.projectContext.findMany({
			where: {
				projectId,
				type: "INTEGRATION" as ProjectContextType,
			},
			select: {
				id: true,
				metadata: true,
			},
		});

		if (integrationContexts.length === 0) {
			return {
				messages: [] as TeamsMessage[],
				hasTeamsIntegration: false,
				error: null,
			};
		}

		// Extract Teams contexts (both chats and channels)
		const teamsContexts: TeamsContext[] = [];

		for (const ctx of integrationContexts) {
			const metadata = ctx.metadata as Record<string, unknown> | null;
			if (metadata?.provider !== "MICROSOFT_TEAMS") {
				continue;
			}

			const chatType = metadata?.chatType as string | undefined;

			if (!chatType) {
				console.warn(
					"[getRecentTeamsMessages] Context missing chatType, skipping",
					{ contextId: ctx.id, projectId },
				);
				continue;
			}

			if (
				chatType === "channel" &&
				metadata?.teamId &&
				metadata?.channelId
			) {
				teamsContexts.push({
					type: "channel",
					teamId: metadata.teamId as string,
					channelId: metadata.channelId as string,
					displayName:
						(metadata.chatTopic as string) || "Teams Channel",
				});
			} else if (metadata?.chatId) {
				teamsContexts.push({
					type: "chat",
					chatId: metadata.chatId as string,
					displayName: (metadata.chatTopic as string) || "Teams Chat",
				});
			}
		}

		if (teamsContexts.length === 0) {
			return {
				messages: [] as TeamsMessage[],
				hasTeamsIntegration: false,
				error: null,
			};
		}

		// Fetch recent messages from each context (chats and channels)
		const allMessages: TeamsMessage[] = [];
		const errors: string[] = [];

		// Distribute limit across contexts
		const messagesPerContext = Math.ceil(limit / teamsContexts.length);

		// Emitted at most once per invocation — every configured context can
		// fail not-connected in the same call (one Microsoft account backs them
		// all), and without this a single request logs the same not-connected
		// line 5-7 times (#2255). Genuine errors are still logged per context,
		// unsuppressed.
		let notConnectedWarned = false;

		for (const ctx of teamsContexts) {
			try {
				let result: {
					messages: Array<{
						id: string;
						content: string;
						from: string;
						createdAt?: string;
					}>;
					count: number;
				};

				if (ctx.type === "chat" && ctx.chatId) {
					result = (await executeMicrosoftTeamsTool(
						"get_chat_messages",
						{ chatId: ctx.chatId, limit: messagesPerContext },
						userId,
						organizationId ?? undefined,
					)) as typeof result;
				} else if (
					ctx.type === "channel" &&
					ctx.teamId &&
					ctx.channelId
				) {
					result = (await executeMicrosoftTeamsTool(
						"list_messages",
						{
							teamId: ctx.teamId,
							channelId: ctx.channelId,
							limit: messagesPerContext,
						},
						userId,
						organizationId ?? undefined,
					)) as typeof result;
				} else {
					continue;
				}

				// Add context info to each message
				const contextId =
					ctx.chatId || `${ctx.teamId}:${ctx.channelId}`;
				for (const msg of result.messages || []) {
					allMessages.push({
						id: msg.id,
						content: msg.content,
						from: msg.from,
						createdAt: msg.createdAt,
						chatId: contextId,
						chatName: ctx.displayName,
					});
				}
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				if (isMicrosoftNotConnectedError(errorMessage)) {
					if (!notConnectedWarned) {
						console.warn(
							`[getRecentTeamsMessages] Error fetching from ${ctx.displayName}:`,
							errorMessage,
						);
						notConnectedWarned = true;
					}
				} else {
					console.error(
						`[getRecentTeamsMessages] Error fetching from ${ctx.displayName}:`,
						errorMessage,
					);
				}
				errors.push(
					`Failed to fetch from ${ctx.displayName}: ${errorMessage}`,
				);
			}
		}

		// Sort by createdAt (most recent first) and limit to requested count
		allMessages.sort((a, b) => {
			if (!a.createdAt || !b.createdAt) {
				return 0;
			}
			return (
				new Date(b.createdAt).getTime() -
				new Date(a.createdAt).getTime()
			);
		});

		const limitedMessages = allMessages.slice(0, limit);

		return {
			messages: limitedMessages,
			hasTeamsIntegration: true,
			error: errors.length > 0 ? errors.join("; ") : null,
		};
	});
