import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: Uses canEditProject() - only project owners/editors can
 * disable the Teams channel monitor.
 *
 * Cancels the running monitor workflow and clears the saved workflow ID so
 * a future enable() call starts fresh.
 */
export const disableTeamsChannelMonitorProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/teams-channel-monitor/disable",
		tags: ["Projects", "Teams Channel Monitor"],
		summary: "Disable Teams channel monitor",
		description:
			"Cancels the Temporal workflow for the scheduled Teams channel monitor.",
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
				teamsChannelMonitorWorkflowId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		if (project.teamsChannelMonitorWorkflowId) {
			try {
				const { getTemporalClient } = await import("@repo/temporal");
				const client = await getTemporalClient();
				const handle = client.workflow.getHandle(
					project.teamsChannelMonitorWorkflowId,
				);
				// Signal for graceful shutdown; cancel as hard stop
				await handle.signal("cancelTeamsChannelMonitor");
				await handle.cancel();
			} catch {
				// Workflow may already be complete or cancelled
			}
		}

		await db.project.update({
			where: { id: input.projectId, ...tenantFilter },
			data: {
				teamsChannelMonitorEnabled: false,
				teamsChannelMonitorWorkflowId: null,
			},
		});

		return { status: "disabled" as const };
	});
