import { ORPCError } from "@orpc/server";
import {
	db,
	ensureTeamsChannelIntegrationContext,
	linkTeamsChannelToProject,
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
 * Teams channels to a project.
 *
 * Links a Microsoft Teams channel to a project for the scheduled channel
 * monitor workflow. Idempotent on (projectId, teamId, channelId).
 *
 * When backfillMode is "from-now" (default), the cursor is seeded to the
 * current timestamp so the first poll tick only sees messages posted after
 * linking. When "latest-30", the cursor stays null so the first tick backfills
 * up to 30 historical messages.
 */
export const linkChannelProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/teams-channel-monitor/link",
		tags: ["Projects", "Teams Channel Monitor"],
		summary: "Link a Teams channel to a project",
		description:
			"Links a Microsoft Teams channel to a project for scheduled monitoring.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			teamId: z.string(),
			channelId: z.string(),
			teamName: z.string().optional(),
			channelName: z.string().optional(),
			channelWebUrl: z.string().optional(),
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

		const linkedChannel = await linkTeamsChannelToProject({
			projectId: input.projectId,
			teamId: input.teamId,
			channelId: input.channelId,
			teamName: input.teamName,
			channelName: input.channelName,
			channelWebUrl: input.channelWebUrl,
			backfillMode: input.backfillMode,
			userId: user.id,
			organizationId,
		});

		// Also register the channel as a ProjectContext INTEGRATION source so it
		// shows up in the on-demand AI Update source picker and is fetchable by
		// backlog analysis (both read ProjectContext.metadata). Best-effort: the
		// monitor link is the primary action and must not fail if this doesn't.
		try {
			await ensureTeamsChannelIntegrationContext({
				projectId: input.projectId,
				teamId: input.teamId,
				channelId: input.channelId,
				teamName: input.teamName,
				channelName: input.channelName,
				userId: user.id,
				organizationId,
			});
		} catch (error) {
			logger.warn(
				"[TeamsChannelMonitor] Failed to register integration context",
				{
					projectId: input.projectId,
					channelId: input.channelId,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
		}

		return linkedChannel;
	});
