/**
 * Get Recent Slack Messages for Project
 *
 * Fetches the most recent messages from Slack channels linked to a project.
 * Used by the DocumentEditor to provide Slack context during chat editing.
 *
 * Mirrors get-recent-teams-messages.ts for Slack parity.
 */

import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import type { ProjectContextType } from "@repo/database/prisma/client";
import { executeSlackTool } from "@repo/integrations/slack";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

// Response type for a single Slack message
interface SlackMessage {
	id: string;
	content: string;
	from: string;
	createdAt?: string;
	channelId: string;
	channelName: string;
}

// Internal type for parsed Slack contexts
interface SlackContext {
	channelId: string;
	channelName: string;
}

export const getRecentSlackMessagesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.INTEGRATION_READ))
	.route({
		method: "GET",
		path: "/integrations/slack/recent-messages",
		tags: ["Integrations", "Slack"],
		summary: "Get recent Slack messages for a project",
		description:
			"Fetches the most recent messages from Slack channels linked to a project",
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
		 * This ensures users can only fetch Slack messages for projects they have access to
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

		// Find Slack integration contexts for this project
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
				messages: [] as SlackMessage[],
				hasSlackIntegration: false,
				error: null,
			};
		}

		// Extract Slack channel contexts
		const slackContexts: SlackContext[] = [];

		for (const ctx of integrationContexts) {
			const metadata = ctx.metadata as Record<string, unknown> | null;
			if (metadata?.provider !== "SLACK") {
				continue;
			}

			if (metadata?.channelId) {
				slackContexts.push({
					channelId: metadata.channelId as string,
					channelName:
						(metadata.channelName as string) || "Slack Channel",
				});
			}
		}

		if (slackContexts.length === 0) {
			return {
				messages: [] as SlackMessage[],
				hasSlackIntegration: false,
				error: null,
			};
		}

		// Fetch recent messages from each channel
		const allMessages: SlackMessage[] = [];
		const errors: string[] = [];

		// Distribute limit across channels
		const messagesPerChannel = Math.ceil(limit / slackContexts.length);

		for (const ctx of slackContexts) {
			try {
				const result = (await executeSlackTool(
					"get_channel_messages",
					{ channelId: ctx.channelId, limit: messagesPerChannel },
					userId,
					organizationId ?? undefined,
				)) as {
					messages: Array<{
						id: string;
						content: string;
						from: string;
						createdAt?: string;
					}>;
					count: number;
				};

				// Add context info to each message
				for (const msg of result.messages || []) {
					allMessages.push({
						id: msg.id,
						content: msg.content,
						from: msg.from,
						createdAt: msg.createdAt,
						channelId: ctx.channelId,
						channelName: ctx.channelName,
					});
				}
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				console.error(
					`[getRecentSlackMessages] Error fetching from ${ctx.channelName}:`,
					errorMessage,
				);
				errors.push(
					`Failed to fetch from ${ctx.channelName}: ${errorMessage}`,
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
			hasSlackIntegration: true,
			error: errors.length > 0 ? errors.join("; ") : null,
		};
	});
