/**
 * Reprocess Project Contexts Procedure
 *
 * Triggers a Temporal workflow to re-process all project contexts
 * with updated RAG settings (chunk size, overlap, strategy).
 */

import { ORPCError } from "@orpc/server";
import { hasProjectAccess } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const reprocessContextsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.route({
		method: "POST",
		path: "/projects/:projectId/rag-settings/reprocess",
		tags: ["Projects", "RAG"],
		summary: "Reprocess project contexts",
		description:
			"Trigger re-processing of all project contexts with current RAG settings. " +
			"This deletes existing embeddings and creates new ones using the current chunk size, " +
			"overlap, and split method settings.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			workflowId: z.string(),
			runId: z.string(),
			message: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId } = input;
		const user = context.user;

		// Resolve organizationId from input or session
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Check project access
		const hasAccess = await hasProjectAccess(
			projectId,
			user.id,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Get Temporal client
		const client = await getTemporalClient();

		// Start the reprocess workflow
		const workflowId = `project-contexts-reprocess-${projectId}-${Date.now()}`;

		const handle = await client.workflow.start(
			"projectContextsReprocessWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
				args: [
					{
						projectId,
						userId: user.id,
						organizationId,
					},
				],
			}),
		);

		return {
			workflowId: handle.workflowId,
			runId: handle.firstExecutionRunId,
			message:
				"Re-processing started. Documents will be re-chunked with your new RAG settings.",
		};
	});
