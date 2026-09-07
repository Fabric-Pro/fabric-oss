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
import { throwNoActiveContextSources } from "../../lib/no-active-context-sources";

/**
 * AUTHORIZATION: Uses canEditProject() - only project owners/editors can
 * enable the Teams chat monitor.
 *
 * Enables the scheduled Teams chat monitor by starting a Temporal workflow
 * that periodically polls each linked chat for new messages and produces
 * PendingBacklogProposal rows for review.
 */
export const enableTeamsChatMonitorProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/teams-chat-monitor/enable",
		tags: ["Projects", "Teams Chat Monitor"],
		summary: "Enable Teams chat monitor",
		description:
			"Starts a Temporal workflow for the scheduled Teams chat monitor.",
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
				teamsChatMonitorEnabled: true,
				teamsChatMonitorWorkflowId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		const linkedChatCount = await db.projectLinkedTeamsChat.count({
			where: { projectId: input.projectId, deactivatedAt: null },
		});

		if (linkedChatCount === 0) {
			// A second count only on the error path: with pausing, "nothing to
			// scan" and "nothing linked" are different situations and only one
			// of them is the user's mistake.
			const pausedCount = await db.projectLinkedTeamsChat.count({
				where: {
					projectId: input.projectId,
					NOT: { deactivatedAt: null },
				},
			});
			throwNoActiveContextSources({
				pausedCount,
				noun: "Teams chat",
				action: "enabling the monitor",
			});
		}

		// Cancel existing workflow if any — signal first for graceful shutdown,
		// then cancel as a hard stop.
		if (project.teamsChatMonitorWorkflowId) {
			try {
				const { getTemporalClient } = await import("@repo/temporal");
				const client = await getTemporalClient();
				const handle = client.workflow.getHandle(
					project.teamsChatMonitorWorkflowId,
				);
				await handle.signal("cancelTeamsChatMonitor");
				await handle.cancel();
			} catch {
				// Workflow may already be complete or cancelled
			}
		}

		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();

		const workflowId = `teams-chat-monitor-${input.projectId}-${Date.now()}`;

		const handle = await client.workflow.start(
			"teamsChatMonitorWorkflow",
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
				teamsChatMonitorEnabled: true,
				teamsChatMonitorIntervalMin: input.intervalMinutes,
				teamsChatMonitorQuietWindowMin: input.quietWindowMinutes,
				teamsChatMonitorWorkflowId: handle.workflowId,
			},
		});

		return {
			workflowId: handle.workflowId,
			status: "enabled" as const,
			intervalMinutes: input.intervalMinutes,
			quietWindowMinutes: input.quietWindowMinutes,
		};
	});
