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
 * AUTHORIZATION: Uses canEditProject() - only project owners/editors can disable sync.
 *
 * Disables scheduled meeting transcript auto-sync by cancelling the Temporal workflow.
 */
export const disableMeetingTranscriptSyncProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-transcript-sync/disable",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "Disable meeting transcript auto-sync",
		description:
			"Cancels the Temporal workflow for scheduled meeting transcript sync.",
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

		// Authorization enforced by `requireProjectPermission` above.
		const tenantFilter = organizationId
			? { organizationId }
			: { organizationId: null, userId: user.id };

		const project = await db.project.findFirst({
			where: { id: input.projectId, ...tenantFilter },
			select: {
				id: true,
				meetingTranscriptSyncWorkflowId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// Cancel the workflow: signal first for graceful shutdown, then cancel as fallback
		if (project.meetingTranscriptSyncWorkflowId) {
			try {
				const { getTemporalClient } = await import("@repo/temporal");
				const client = await getTemporalClient();
				const handle = client.workflow.getHandle(
					project.meetingTranscriptSyncWorkflowId,
				);
				// Signal for graceful shutdown (wakes condition() immediately)
				await handle.signal("cancelMeetingTranscriptSync");
				// Also cancel the workflow via Temporal API as a hard stop
				await handle.cancel();
			} catch {
				// Workflow may already be complete or cancelled
			}
		}

		// Update project
		await db.project.update({
			where: { id: input.projectId, ...tenantFilter },
			data: {
				meetingTranscriptSyncEnabled: false,
				meetingTranscriptSyncWorkflowId: null,
			},
		});

		return {
			status: "disabled",
		};
	});
