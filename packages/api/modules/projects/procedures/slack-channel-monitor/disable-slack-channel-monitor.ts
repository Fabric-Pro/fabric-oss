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
 * AUTHORIZATION: Uses canEditProject() — only project owners/editors can
 * disable the Slack channel monitor.
 *
 * Cancels the running monitor workflow (sends `cancelSlackChannelMonitor`
 * signal for graceful shutdown, then `cancel()` as a hard stop) and clears
 * the saved workflow ID so a future enable() call starts fresh.
 *
 * Webhook fanout will continue to call `getHandle().signal(...)` for any
 * in-flight Slack events until the new state propagates — those signals are
 * caught and logged inside the fanout helper (`WorkflowNotFoundError`).
 */
export const disableSlackChannelMonitorProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/slack-channel-monitor/disable",
		tags: ["Projects", "Slack Channel Monitor"],
		summary: "Disable Slack channel monitor",
		description:
			"Cancels the Temporal workflow for the event-driven Slack channel monitor.",
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
				slackChannelMonitorWorkflowId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		if (project.slackChannelMonitorWorkflowId) {
			try {
				const { getTemporalClient } = await import("@repo/temporal");
				const client = await getTemporalClient();
				const handle = client.workflow.getHandle(
					project.slackChannelMonitorWorkflowId,
				);
				// Graceful: workflow drains its queue once then exits. Hard
				// stop with cancel() in case the signal handler isn't picked
				// up (workflow may already be finishing).
				await handle.signal("cancelSlackChannelMonitor");
				await handle.cancel();
			} catch {
				// Workflow may already be complete or cancelled — non-fatal.
			}
		}

		// Flip monitor flag at both the project level and on every linked-channel
		// row so the webhook fanout lookup ignores them until re-enabled.
		await db.$transaction([
			db.project.update({
				where: { id: input.projectId, ...tenantFilter },
				data: {
					slackChannelMonitorEnabled: false,
					slackChannelMonitorWorkflowId: null,
				},
			}),
			db.projectLinkedSlackChannel.updateMany({
				where: { projectId: input.projectId },
				data: { monitorEnabled: false },
			}),
		]);

		return { status: "disabled" as const };
	});
