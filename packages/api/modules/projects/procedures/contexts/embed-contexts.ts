import { ORPCError } from "@orpc/client";
import { db, listUnindexedSyncedContexts } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { startContextEmbeddingWorkflow } from "@repo/temporal/context-embedding-start";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * How many unindexed synced rows one call hands to the guarded pass. The rest
 * are started by the next call, and a repository sync's rows by its own index
 * step and the reaper's index-only pass.
 */
const MAX_SYNCED_STARTS = 200;

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
						// A synced row (repository sync or `fabric context push`) has
						// content that changes in place, so a copy taken here could be
						// replaced before it lands in the index. Those rows go through
						// the hash-guarded pass below instead.
						sourcePath: null,
					},
				},
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		const { organizationId } = project;
		const synced = organizationId
			? (
					await listUnindexedSyncedContexts(
						{ projectId, organizationId },
						MAX_SYNCED_STARTS,
					)
				).map((row) => ({ ...row, organizationId }))
			: [];

		if (project.contexts.length === 0 && synced.length === 0) {
			return {
				message: "No contexts to embed",
				embeddedCount: 0,
			};
		}

		// Get Temporal client
		const client = await getTemporalClient();

		// The guarded pass re-reads each row's body and hash itself and marks it
		// indexed only for the version it embedded; `dedupe` joins a pass that is
		// already open for the row instead of embedding it twice.
		for (const row of synced) {
			await startContextEmbeddingWorkflow(
				client,
				{
					contextId: row.id,
					projectId,
					userId: user.id,
					organizationId: row.organizationId,
					sourcePath: row.sourcePath,
					title: row.title,
					reembed: true,
				},
				{ decorateStartOptions: withCorrelationMemo, dedupe: true },
			);
		}

		if (project.contexts.length === 0) {
			return {
				message: `Indexing ${synced.length} synced files`,
				contextCount: synced.length,
			};
		}

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
							// The content version copied with the content: the stamp
							// after the embed leaves a row that changed meanwhile alone.
							contentHash: ctx.contentHash,
							updatedAt: ctx.updatedAt.toISOString(),
						})),
					},
				],
			}),
		);

		return {
			workflowId: handle.workflowId,
			runId: handle.firstExecutionRunId,
			contextCount: project.contexts.length + synced.length,
			message: `Embedding ${project.contexts.length + synced.length} contexts`,
		};
	});
