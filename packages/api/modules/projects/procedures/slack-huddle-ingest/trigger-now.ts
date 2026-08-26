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
 * AUTHORIZATION: requireProjectPermission(PROJECT_UPDATE).
 *
 * Triggers a one-shot Slack huddle notes ingestion run immediately (lets the
 * user pull notes without waiting for the next poll cycle). The activity's
 * canvas-id dedup prevents duplicate imports even if the recurring workflow is
 * also running.
 *
 * Router key + client method name are BOTH `triggerNow` (avoids the
 * triggerNow/triggerMonitor mismatch logged in project memory).
 */
export const triggerNowProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/slack-huddle-ingest/trigger",
		tags: ["Projects", "Slack Huddle Ingest"],
		summary: "Trigger Slack huddle notes ingestion now",
		description:
			"Starts a one-shot Slack huddle notes ingestion run immediately.",
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
				slackHuddleIngestEnabledAt: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		const linkedChannelCount = await db.projectLinkedSlackChannel.count({
			where: { projectId: input.projectId },
		});
		if (linkedChannelCount === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Link a Slack channel first before triggering huddle notes ingestion",
			});
		}

		// A one-shot run still honours the forward-only anchor when set; falls
		// back to "now" if huddle ingest was never enabled.
		const enabledAt = project.slackHuddleIngestEnabledAt ?? new Date();

		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();

		const workflowId = `slack-huddle-ingest-oneshot-${input.projectId}-${Date.now()}`;

		await client.workflow.start(
			"slackHuddleIngestWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
				args: [
					{
						projectId: input.projectId,
						userId: user.id,
						organizationId: project.organizationId ?? undefined,
						intervalMinutes: 0, // one-shot
						enabledAtMs: enabledAt.getTime(),
					},
				],
			}),
		);

		return {
			status: "started",
			message: "One-shot Slack huddle notes ingestion started",
			workflowId,
		};
	});
