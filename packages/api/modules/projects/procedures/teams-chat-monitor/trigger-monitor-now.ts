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
 * trigger a one-shot monitor run.
 *
 * Starts a ONE-SHOT monitor workflow (intervalMinutes: 0) so the UI "Monitor
 * now" button can force an immediate scan without interfering with the
 * scheduled workflow. The saved teamsChatMonitorWorkflowId is NOT updated
 * — the scheduled workflow keeps running and this one-shot run exits after
 * a single tick.
 */
export const triggerMonitorNowProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/teams-chat-monitor/trigger-now",
		tags: ["Projects", "Teams Chat Monitor"],
		summary: "Trigger Teams chat monitor immediately",
		description:
			"Starts a one-shot workflow run that scans linked chats once and exits.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
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
				teamsChatMonitorQuietWindowMin: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		const linkedChatCount = await db.projectLinkedTeamsChat.count({
			where: { projectId: input.projectId },
		});

		if (linkedChatCount === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"At least one Teams chat must be linked before triggering the monitor",
			});
		}

		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();

		const workflowId = `teams-chat-monitor-oneshot-${input.projectId}-${Date.now()}`;

		await client.workflow.start(
			"teamsChatMonitorWorkflow",
			withCorrelationMemo({
				taskQueue: "ai-chat",
				workflowId,
				args: [
					{
						projectId: input.projectId,
						userId: user.id,
						organizationId: project.organizationId ?? undefined,
						intervalMinutes: 0, // 0 = one-shot
						quietWindowMinutes:
							project.teamsChatMonitorQuietWindowMin ?? 60,
					},
				],
			}),
		);

		return {
			workflowId,
			status: "triggered" as const,
		};
	});
