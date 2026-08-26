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
 * AUTHORIZATION: Uses canEditProject() - only project owners/editors can
 * enable the Teams channel monitor.
 *
 * Enables the scheduled Teams channel monitor by starting a Temporal workflow
 * that periodically polls each linked channel for new messages and produces
 * PendingBacklogProposal rows for review.
 */
export const enableTeamsChannelMonitorProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/teams-channel-monitor/enable",
		tags: ["Projects", "Teams Channel Monitor"],
		summary: "Enable Teams channel monitor",
		description:
			"Starts a Temporal workflow for the scheduled Teams channel monitor.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			intervalMinutes: z.number().min(1).max(10080).default(360),
			quietWindowMinutes: z.number().min(1).max(10080).default(60),
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
				teamsChannelMonitorEnabled: true,
				teamsChannelMonitorWorkflowId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// Validate ≥1 linked channel exists
		const linkedChannelCount = await db.projectLinkedTeamsChannel.count({
			where: { projectId: input.projectId },
		});

		if (linkedChannelCount === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"At least one Teams channel must be linked before enabling the monitor",
			});
		}

		// Cancel existing workflow if any — signal first for graceful shutdown,
		// then cancel as a hard stop.
		if (project.teamsChannelMonitorWorkflowId) {
			try {
				const { getTemporalClient } = await import("@repo/temporal");
				const client = await getTemporalClient();
				const handle = client.workflow.getHandle(
					project.teamsChannelMonitorWorkflowId,
				);
				await handle.signal("cancelTeamsChannelMonitor");
				await handle.cancel();
			} catch {
				// Workflow may already be complete or cancelled
			}
		}

		// Start new workflow
		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();

		const workflowId = `teams-channel-monitor-${input.projectId}-${Date.now()}`;

		const handle = await client.workflow.start(
			"teamsChannelMonitorWorkflow",
			withCorrelationMemo({
				taskQueue: "ai-chat",
				workflowId,
				args: [
					{
						projectId: input.projectId,
						userId: user.id,
						organizationId: project.organizationId ?? undefined,
						intervalMinutes: input.intervalMinutes,
						quietWindowMinutes: input.quietWindowMinutes,
					},
				],
			}),
		);

		await db.project.update({
			where: { id: input.projectId, ...tenantFilter },
			data: {
				teamsChannelMonitorEnabled: true,
				teamsChannelMonitorIntervalMin: input.intervalMinutes,
				teamsChannelMonitorQuietWindowMin: input.quietWindowMinutes,
				teamsChannelMonitorWorkflowId: handle.workflowId,
			},
		});

		return {
			workflowId: handle.workflowId,
			status: "enabled" as const,
			intervalMinutes: input.intervalMinutes,
			quietWindowMinutes: input.quietWindowMinutes,
		};
	});
