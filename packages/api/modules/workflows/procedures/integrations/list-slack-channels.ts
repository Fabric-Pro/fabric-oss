/**
 * List Slack Channels for Wizard
 *
 * Lists available Slack workspace channels for the wizard context selection.
 * This is a simplified version that doesn't require a projectId (used during project creation).
 *
 * Supports cursor-based pagination — the first call returns the first page of
 * channels; subsequent calls (with cursor) return the next page.
 *
 * Prerequisites:
 * - User must have connected their Slack workspace via OAuth (SLACK provider)
 */

import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { executeSlackTool } from "@repo/integrations/slack";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

// Response type for a Slack channel
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

export const listSlackChannelsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/workflows/integrations/slack/channels",
		tags: ["Workflows", "Integrations", "Slack"],
		summary: "List Slack channels",
		description:
			"List Slack workspace channels for context selection (no project required)",
	})
	.input(
		z.object({
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

		// Verify organization membership if in org context
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
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

			// Check if the error is about Slack not being connected
			if (
				errorMessage.includes("Slack not connected") ||
				errorMessage.includes("Please connect your Slack")
			) {
				return {
					channels: [],
					count: 0,
					isConnected: false,
					error: "Slack workspace not connected. Please connect your Slack workspace in Settings > Integrations.",
				};
			}

			// Check if credentials are missing or corrupted
			if (
				errorMessage.includes("credentials missing") ||
				errorMessage.includes("credentials are corrupted") ||
				errorMessage.includes("access token missing")
			) {
				return {
					channels: [],
					count: 0,
					isConnected: false,
					error: "Slack credentials invalid. Please reconnect your Slack workspace in Settings > Integrations.",
				};
			}

			// Re-throw other errors
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to fetch Slack channels: ${errorMessage}`,
			});
		}
	});
