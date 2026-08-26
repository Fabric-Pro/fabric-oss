import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses canEditProject() — only project owners/editors can
 * trigger a manual one-shot Slack monitor run.
 *
 * One-shot semantic for the event-driven Slack monitor differs from the
 * Teams polling monitor: there's no "run the polling tick once" because
 * fresh events stream in continuously. Instead, "Monitor now" fires a
 * `slackChannelBackfillWorkflow` per linked channel, parameterized to scan
 * from `lastMessageTs` (or `defaultBackfillHours` ago if null) to now. The
 * backfill workflow already owns Slack pagination, `Retry-After` back-off,
 * and the seen-message dedup — re-running it is safe and idempotent.
 *
 * The long-running `slackChannelMonitorWorkflow` itself is NOT restarted —
 * `slackChannelMonitorWorkflowId` stays unchanged.
 */
export const triggerMonitorNowProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/slack-channel-monitor/trigger-now",
		tags: ["Projects", "Slack Channel Monitor"],
		summary: "Trigger Slack channel monitor immediately",
		description:
			"Starts a one-shot backfill workflow per linked channel and exits.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			defaultBackfillHours: z.number().min(1).max(168).default(24),
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
			select: {
				id: true,
				organizationId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		const linkedChannels = await db.projectLinkedSlackChannel.findMany({
			where: { projectId: input.projectId },
			select: {
				id: true,
				slackTeamId: true,
				channelId: true,
				channelName: true,
				lastMessageTs: true,
			},
		});

		if (linkedChannels.length === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"At least one Slack channel must be linked before triggering the monitor",
			});
		}

		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();

		const startedWorkflowIds: string[] = [];
		for (const channel of linkedChannels) {
			const workflowId = `slack-channel-backfill:${input.projectId}:${channel.id}:${Date.now()}`;
			try {
				await client.workflow.start(
					"slackChannelBackfillWorkflow",
					withCorrelationMemo({
						taskQueue: "ai-chat",
						workflowId,
						workflowIdReusePolicy: "ALLOW_DUPLICATE",
						args: [
							{
								projectId: input.projectId,
								linkedChannelId: channel.id,
								slackTeamId: channel.slackTeamId,
								channelId: channel.channelId,
								channelName: channel.channelName ?? undefined,
								userId: user.id,
								organizationId:
									project.organizationId ?? undefined,
								// Trigger-now semantic: start from the cursor if it
								// exists, otherwise fall back to the user-supplied
								// window. The backfill workflow owns the actual
								// `oldest` parameter for conversations.history.
								fromLastMessageTs:
									channel.lastMessageTs ?? undefined,
								defaultBackfillHours:
									input.defaultBackfillHours,
								source: "manual-trigger" as const,
							},
						],
					}),
				);
				startedWorkflowIds.push(workflowId);
			} catch (err) {
				console.error(
					"[slack-channel-monitor] trigger-now backfill start failed",
					{
						projectId: input.projectId,
						linkedChannelId: channel.id,
						channelId: channel.channelId,
					},
					err,
				);
			}
		}

		return {
			workflowIds: startedWorkflowIds,
			channelCount: linkedChannels.length,
			status: "triggered" as const,
		};
	});
