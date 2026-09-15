import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationIdForCaller,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const CLASSIFY_WORKFLOW_ID_PREFIX = "track-classify-";

/**
 * Start the delivery-track classifier for a project.
 *
 * With `storyIds` only those stories are (re)classified; without it every
 * UNCLASSIFIED story is. Human-set tracks are always left alone.
 *
 * AUTHORIZATION: `requireProjectPermission(PROJECT_UPDATE)`.
 */
export const classifyTracksProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/classify-tracks",
		tags: ["Projects", "Features"],
		summary: "Classify features into delivery tracks",
		description:
			"Start a Temporal workflow that assigns delivery tracks to unclassified features.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			storyIds: z.array(z.string()).max(500).optional(),
		}),
	)
	.output(
		z.object({
			workflowId: z.string(),
			runId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			context.user.id,
		);

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true, organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		try {
			const client = await getTemporalClient();
			const workflowId = `${CLASSIFY_WORKFLOW_ID_PREFIX}${input.projectId}-${Date.now()}`;

			const handle = await client.workflow.start(
				"deliveryTrackClassificationWorkflow",
				{
					taskQueue: "ai-chat",
					workflowId,
					args: [
						{
							projectId: input.projectId,
							storyIds: input.storyIds,
							userId: context.user.id,
							organizationId:
								organizationId ??
								project.organizationId ??
								undefined,
						},
					],
				},
			);

			return {
				workflowId: handle.workflowId,
				runId: handle.firstExecutionRunId,
			};
		} catch (error) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					error instanceof Error
						? error.message
						: "Failed to start classification workflow",
			});
		}
	});
