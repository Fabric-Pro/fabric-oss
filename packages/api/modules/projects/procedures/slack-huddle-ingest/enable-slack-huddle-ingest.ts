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
 * AUTHORIZATION: requireProjectPermission(PROJECT_UPDATE) — only project
 * owners/editors can enable huddle-notes ingestion.
 *
 * Enables poll-based Slack huddle AI-notes ingestion by starting a Temporal
 * workflow that periodically scans linked Slack channels for huddle canvases and
 * stores them as passive SLACK_HUDDLE_NOTES context. Independent of the
 * event-driven slackChannelMonitor.
 */
export const enableSlackHuddleIngestProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/slack-huddle-ingest/enable",
		tags: ["Projects", "Slack Huddle Ingest"],
		summary: "Enable Slack huddle notes ingestion",
		description:
			"Starts a Temporal workflow that polls linked Slack channels for huddle AI-notes canvases.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			intervalMinutes: z.number().min(1).max(10080).default(15),
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
				slackHuddleIngestWorkflowId: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		// Require at least one linked Slack channel (huddle ingest rides them).
		const linkedChannelCount = await db.projectLinkedSlackChannel.count({
			where: { projectId: input.projectId },
		});
		if (linkedChannelCount === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Link a Slack channel first before enabling huddle notes ingestion",
			});
		}

		// Cancel any prior workflow (signal first, then hard-cancel) — best effort.
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

		// Forward-only anchor: set enabledAt only on the null→now transition;
		// preserve it across re-enables.
		const enabledAt = project.slackHuddleIngestEnabledAt ?? new Date();

		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();

		const workflowId = `slack-huddle-ingest-${input.projectId}-${Date.now()}`;

		const handle = await client.workflow.start(
			"slackHuddleIngestWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
				args: [
					{
						projectId: input.projectId,
						userId: user.id,
						organizationId: project.organizationId ?? undefined,
						intervalMinutes: input.intervalMinutes,
						enabledAtMs: enabledAt.getTime(),
					},
				],
			}),
		);

		await db.project.update({
			where: { id: input.projectId, ...tenantFilter },
			data: {
				slackHuddleIngestEnabled: true,
				slackHuddleIngestIntervalMin: input.intervalMinutes,
				slackHuddleIngestWorkflowId: handle.workflowId,
				slackHuddleIngestEnabledAt: enabledAt,
			},
		});

		return {
			workflowId: handle.workflowId,
			status: "enabled",
			intervalMinutes: input.intervalMinutes,
		};
	});
