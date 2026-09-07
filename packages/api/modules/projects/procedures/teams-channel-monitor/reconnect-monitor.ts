import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { executeMicrosoftTeamsTool } from "@repo/integrations/microsoft";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertPreflightAllowsRebind,
	classifyProviderError,
	rebindMonitorWorkflow,
	runMonitorPreflight,
} from "../../lib/monitor-reconnect";

/**
 * AUTHORIZATION: `PROJECT_UPDATE` (EDITOR+), deliberately looser than
 * unlinking. Reconnecting destroys nothing, and editors lost the
 * unlink-and-relink workaround when unlinking became admin-only — this is what
 * replaces it (Fizzy #2355).
 *
 * Rebinds this project's Teams channel monitor to the calling user's Microsoft
 * account. See `../../lib/monitor-reconnect` for why the binding exists at all
 * and why the repair is necessarily monitor-wide.
 *
 * Two modes. `preflightOnly` probes each actively scanned channel under the calling
 * user and reports what they cannot see, WITHOUT changing anything. That check
 * is the point: Microsoft grants team and channel membership per person, so rebinding to
 * someone with narrower access silently shrinks what the project collects, and a
 * shrunken monitor is indistinguishable from a healthy one.
 */
export const reconnectMonitorProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/teams-channel-monitor/reconnect",
		tags: ["Projects", "Teams Channel Monitor"],
		summary: "Reconnect a project's Teams channel monitor",
		description:
			"Checks which linked channels the calling user can reach, and rebinds the monitor to their Microsoft account.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			/** True = report only. False = rebind. */
			preflightOnly: z.boolean().default(true),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// The organization is a property of the project, not a caller claim.
		const project = await db.project.findFirst({
			where: { id: input.projectId },
			select: {
				id: true,
				organizationId: true,
				teamsChannelMonitorIntervalMin: true,
				teamsChannelMonitorQuietWindowMin: true,
				teamsChannelMonitorWorkflowId: true,
				teamsChannelMonitorUserId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		const organizationId = project.organizationId ?? undefined;

		// Paused channels are excluded: they are not being scanned, so whether the
		// new account can see them says nothing about the repair.
		const channels = await db.projectLinkedTeamsChannel.findMany({
			where: { projectId: input.projectId, deactivatedAt: null },
			select: {
				id: true,
				teamId: true,
				channelId: true,
				channelName: true,
			},
		});

		if (channels.length === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: "This project has no actively scanned channels.",
			});
		}

		const report = await runMonitorPreflight({
			conversations: channels.map((channel) => ({
				id: `${channel.teamId}/${channel.channelId}`,
				label: channel.channelName ?? "Untitled channel",
			})),
			// The monitor's OWN fetch, at the smallest page size. Asking a
			// different Graph endpoint is what made the meeting preflight report
			// every meeting as invisible: `/me/onlineMeetings` answers only for
			// the organizer, so it was answering a question nobody had asked.
			probe: async (conversation) => {
				const result = (await executeMicrosoftTeamsTool(
					"list_channel_threads",
					{
						teamId: conversation.id.split("/")[0],
						channelId: conversation.id.split("/")[1],
						top: 1,
					},
					user.id,
					organizationId,
				)) as { error?: string };

				return result?.error
					? classifyProviderError(result.error)
					: "reachable";
			},
		});

		if (input.preflightOnly) {
			return {
				mode: "preflight" as const,
				...report,
				currentlyBoundTo: project.teamsChannelMonitorUserId,
			};
		}

		assertPreflightAllowsRebind(report, "channel");

		const rebound = await rebindMonitorWorkflow({
			projectId: input.projectId,
			previousWorkflowId: project.teamsChannelMonitorWorkflowId,
			cancelSignal: "cancelTeamsChannelMonitor",
			workflowType: "teamsChannelMonitorWorkflow",
			taskQueue: "ai-chat",
			workflowId: `teams-channel-monitor-${input.projectId}-${Date.now()}`,
			logKey: "teamsChannel",
			args: [
				{
					projectId: input.projectId,
					userId: user.id,
					organizationId,
					intervalMinutes:
						project.teamsChannelMonitorIntervalMin ?? 360,
					quietWindowMinutes:
						project.teamsChannelMonitorQuietWindowMin ?? 60,
				},
			],
		});

		// The linked rows' own `userId` is deliberately NOT rewritten: it is the
		// Job Hub's tenancy anchor for telemetry rows, never a credential
		// lookup. The account the scan actually runs under is the workflow
		// argument set above.
		await db.project.update({
			where: { id: input.projectId },
			data: {
				teamsChannelMonitorEnabled: true,
				teamsChannelMonitorWorkflowId: rebound.workflowId,
				teamsChannelMonitorUserId: user.id,
			},
		});

		// Failure counters describe the OLD account's access. Leaving them would
		// keep a repaired monitor showing the banner that sent someone here.
		await db.projectLinkedTeamsChannel.updateMany({
			where: { projectId: input.projectId },
			data: {
				consecutiveFailures: 0,
				lastErrorMessage: null,
				lastErrorAt: null,
			},
		});

		recordAuditFromRequest(context, {
			action: "project.context_source.reconnected",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: { type: "project", id: input.projectId },
			metadata: {
				provider: "MICROSOFT_TEAMS_CHANNEL",
				previouslyBoundTo: project.teamsChannelMonitorUserId,
				reachableCount: report.reachableCount,
				unreachableCount: report.unreachableLabels.length,
			},
		});

		return {
			mode: "reconnected" as const,
			...report,
			workflowId: rebound.workflowId,
			workflowStatus: rebound.status,
			currentlyBoundTo: user.id,
		};
	});
