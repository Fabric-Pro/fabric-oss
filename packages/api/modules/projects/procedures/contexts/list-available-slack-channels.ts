/**
 * List Available Slack Channels
 *
 * Fetches the Slack workspace channels for selection as project integration contexts.
 *
 * Prerequisites:
 * - User must have connected their Slack workspace via OAuth (SLACK provider)
 *
 * Used by SlackChannelSelector to let users pick which channels to link to a project.
 */

import { ORPCError } from "@orpc/client";
import { db, hasProjectAccess } from "@repo/database";
import { executeSlackTool } from "@repo/integrations/slack";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const SlackChannelSchema = z.object({
	id: z.string(),
	name: z.string(),
	isPrivate: z.boolean(),
	isBotMember: z.boolean().optional(),
	memberCount: z.number(),
	topic: z.string(),
	purpose: z.string(),
});

type SlackChannel = z.infer<typeof SlackChannelSchema>;

export const listAvailableSlackChannelsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/contexts/available-slack-channels",
		tags: ["Projects", "Contexts", "Integrations"],
		summary: "List available Slack channels",
		description:
			"List Slack workspace channels that can be linked as project integration contexts",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			cursor: z.string().optional(),
		}),
	)
	.output(
		z.object({
			channels: z.array(SlackChannelSchema),
			count: z.number(),
			isConnected: z.boolean(),
			botName: z.string().optional(),
			nextCursor: z.string().nullable().optional(),
			error: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Check project access
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

		// Get bot name from integration record
		const slackIntegration = await db.workflowIntegration.findFirst({
			where: {
				userId: user.id,
				provider: "SLACK",
				isActive: true,
				NOT: { name: "SLACK_OAUTH_APP" },
				...(organizationId
					? { organizationId }
					: { organizationId: null }),
			},
			select: { settings: true },
		});
		const settings = slackIntegration?.settings as Record<
			string,
			unknown
		> | null;
		const botName = settings?.login as string | undefined;

		try {
			const result = (await executeSlackTool(
				"list_channels",
				{
					limit: 200,
					cursor: input.cursor || undefined,
				},
				user.id,
				organizationId,
			)) as {
				channels: Array<{
					id: string;
					name: string;
					isPrivate: boolean;
					isBotMember?: boolean;
					memberCount: number;
					topic: string;
					purpose: string;
				}>;
				count: number;
				nextCursor: string | null;
			};

			const channels: SlackChannel[] = (result.channels || []).map(
				(ch) => ({
					id: ch.id,
					name: ch.name,
					isPrivate: ch.isPrivate,
					isBotMember: ch.isBotMember,
					memberCount: ch.memberCount,
					topic: ch.topic || "",
					purpose: ch.purpose || "",
				}),
			);

			return {
				channels,
				count: channels.length,
				isConnected: true,
				botName,
				nextCursor: result.nextCursor,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";

			if (
				errorMessage.includes("Slack not connected") ||
				errorMessage.includes("Please connect your Slack")
			) {
				return {
					channels: [],
					count: 0,
					isConnected: false,
					error: "Slack not connected. Please connect your Slack workspace in Settings > Integrations.",
				};
			}

			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to fetch Slack channels: ${errorMessage}`,
			});
		}
	});
