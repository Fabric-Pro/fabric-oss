import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Embed project contexts into Qdrant for RAG retrieval
 *
 * This endpoint:
 * 1. Retrieves all contexts for a project
 * 2. Triggers a Temporal workflow to generate embeddings and store in Qdrant
 * 3. Returns workflow ID for tracking
 *
 * AUTHORIZATION: Uses canEditProject() which verifies:
 * - Personal projects: User must be the owner
 * - Org projects: User must be org member AND (project owner OR project member with EDITOR role)
 *
 * Note: organizationId is retrieved from the project record itself for the Temporal workflow,
 * so we don't need it as an input parameter.
 */
export const embedProjectContextsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/embed",
		tags: ["Projects", "Contexts"],
		summary: "Embed project contexts into Qdrant for RAG",
	})
	.input(
		z.object({
			projectId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const { projectId } = input;

		// Get project with contexts
		// Filter out INTEGRATION type contexts - they don't have content to embed
		// (they provide live tool access via Teams/Slack search, not indexed content)
		const project = await db.project.findUnique({
			where: { id: projectId },
			include: {
				organization: true,
				contexts: {
					where: {
						embeddedAt: null, // Only embed contexts that haven't been embedded yet
						type: { not: "INTEGRATION" }, // Skip integration contexts
					},
				},
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		if (project.contexts.length === 0) {
			return {
				message: "No contexts to embed",
				embeddedCount: 0,
			};
		}

		// Get Temporal client
		const client = await getTemporalClient();

		// Start context embedding workflow
		const workflowId = `project-context-embedding-${projectId}-${Date.now()}`;

		const handle = await client.workflow.start(
			"projectContextEmbeddingWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
				args: [
					{
						projectId,
						userId: user.id,
						organizationId: project.organizationId || undefined,
						contexts: project.contexts.map((ctx) => ({
							id: ctx.id,
							type: ctx.type,
							content: ctx.content,
						})),
					},
				],
			}),
		);

		return {
			workflowId: handle.workflowId,
			runId: handle.firstExecutionRunId,
			contextCount: project.contexts.length,
			message: `Embedding ${project.contexts.length} contexts`,
		};
	});
