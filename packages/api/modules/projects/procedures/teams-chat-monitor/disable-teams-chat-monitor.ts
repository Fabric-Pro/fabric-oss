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
 * disable the Teams chat monitor.
 *
 * Cancels the running monitor workflow and clears the saved workflow ID so
 * a future enable() call starts fresh.
 */
export const disableTeamsChatMonitorProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/teams-chat-monitor/disable",
		tags: ["Projects", "Teams Chat Monitor"],
		summary: "Disable Teams chat monitor",
		description:
			"Cancels the Temporal workflow for the scheduled Teams chat monitor.",
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
				teamsChatMonitorWorkflowId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

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

		await db.project.update({
			where: { id: input.projectId, ...tenantFilter },
			data: {
				teamsChatMonitorEnabled: false,
				teamsChatMonitorWorkflowId: null,
			},
		});

		return { status: "disabled" as const };
	});
