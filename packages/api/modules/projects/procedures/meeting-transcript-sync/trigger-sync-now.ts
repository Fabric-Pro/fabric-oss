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
 * AUTHORIZATION: Uses canEditProject() - only project owners/editors can trigger sync.
 *
 * Triggers a meeting transcript sync immediately. If sync is enabled, signals
 * the running workflow to wake up. If sync is not enabled but meetings are linked,
 * starts a one-shot workflow run.
 */
export const triggerSyncNowProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/meeting-transcript-sync/trigger",
		tags: ["Projects", "Meeting Transcript Sync"],
		summary: "Trigger meeting transcript sync immediately",
		description:
			"Signals the running workflow to sync now, or starts a one-shot sync if not enabled.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			// Calendar lookback for this one-shot sync (backfill). Bounds mirror
			// the activity-side clamp in resolveLookbackWindow.
			daysBack: z.number().int().min(1).max(180).optional(),
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
					"At least one meeting must be linked before triggering transcript sync",
			});
		}

		// Always start a one-shot sync workflow. The activity's dedup check
		// (isTranscriptAlreadySynced) prevents duplicate imports even if the
		// recurring auto-sync workflow is also running.
		//
		// We don't try to signal the running workflow because it has no syncNow
		// handler — it only defines cancelMeetingTranscriptSync.
		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();

		const workflowId = `meeting-transcript-sync-oneshot-${input.projectId}-${Date.now()}`;

		await client.workflow.start(
			"meetingTranscriptSyncWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
				args: [
					{
						projectId: input.projectId,
						userId: user.id,
						organizationId: project.organizationId ?? undefined,
						intervalMinutes: 0, // 0 means one-shot, no recurring
						daysBack: input.daysBack,
					},
				],
			}),
		);

		return {
			status: "started",
			message: input.daysBack
				? `One-shot transcript sync started (looking back ${input.daysBack} days)`
				: "One-shot transcript sync started",
			workflowId,
		};
	});
