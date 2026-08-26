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
 * AUTHORIZATION: Uses canEditProject() - only project owners/editors can enable sync.
 *
 * Enables scheduled meeting transcript auto-sync by starting a Temporal workflow
 * that periodically checks for new transcripts and syncs them as project context.
 */
export const enableMeetingTranscriptSyncProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-transcript-sync/enable",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "Enable meeting transcript auto-sync",
		description:
			"Starts a Temporal workflow for scheduled meeting transcript sync.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			intervalMinutes: z.number().min(1).max(10080).default(360),
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
				organizationId: true,
				meetingTranscriptSyncEnabled: true,
				meetingTranscriptSyncWorkflowId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// Validate at least one linked meeting exists
		const linkedMeetingCount = await db.projectLinkedMeeting.count({
			where: { projectId: input.projectId },
		});

		if (linkedMeetingCount === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"At least one meeting must be linked before enabling transcript sync",
			});
		}

		// Cancel existing workflow if any
		if (project.meetingTranscriptSyncWorkflowId) {
			try {
				const { getTemporalClient } = await import("@repo/temporal");
				const client = await getTemporalClient();
				const handle = client.workflow.getHandle(
					project.meetingTranscriptSyncWorkflowId,
				);
				await handle.signal("cancelMeetingTranscriptSync");
				await handle.cancel();
			} catch {
				// Workflow may already be complete or cancelled
			}
		}

		// Start new workflow
		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();

		const workflowId = `meeting-transcript-sync-${input.projectId}-${Date.now()}`;

		const handle = await client.workflow.start(
			"meetingTranscriptSyncWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
				args: [
					{
						projectId: input.projectId,
						userId: user.id,
						organizationId: project.organizationId ?? undefined,
						intervalMinutes: input.intervalMinutes,
					},
				],
			}),
		);

		// Update project
		await db.project.update({
			where: { id: input.projectId, ...tenantFilter },
			data: {
				meetingTranscriptSyncEnabled: true,
				meetingTranscriptSyncIntervalMin: input.intervalMinutes,
				meetingTranscriptSyncWorkflowId: handle.workflowId,
			},
		});

		return {
			workflowId: handle.workflowId,
			status: "enabled",
			intervalMinutes: input.intervalMinutes,
		};
	});
