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
 * AUTHORIZATION: requireProjectPermission(PROJECT_UPDATE).
 *
 * Disables Slack huddle notes ingestion by cancelling the Temporal workflow.
 * Does NOT clear slackHuddleIngestEnabledAt — the forward-only anchor stays
 * stable so a re-enable doesn't re-ingest pre-existing canvases.
 */
export const disableSlackHuddleIngestProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/slack-huddle-ingest/disable",
		tags: ["Projects", "Slack Huddle Ingest"],
		summary: "Disable Slack huddle notes ingestion",
		description:
			"Cancels the Temporal workflow for Slack huddle notes ingestion.",
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
				slackHuddleIngestWorkflowId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		if (project.slackHuddleIngestWorkflowId) {
			try {
				const { getTemporalClient } = await import("@repo/temporal");
				const client = await getTemporalClient();
				const handle = client.workflow.getHandle(
					project.slackHuddleIngestWorkflowId,
				);
				await handle.signal("cancelSlackHuddleIngest");
				await handle.cancel();
			} catch {
				// Workflow may already be complete or cancelled.
			}
		}

		await db.project.update({
			where: { id: input.projectId, ...tenantFilter },
			data: {
				slackHuddleIngestEnabled: false,
				slackHuddleIngestWorkflowId: null,
			},
		});

		return { status: "disabled" };
	});
