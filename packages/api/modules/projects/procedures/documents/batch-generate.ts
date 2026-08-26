import { ORPCError } from "@orpc/client";
import { issueAIToken } from "@repo/ai-token";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { buildDocumentTitle } from "../../utils/document-title";

/**
 * Batch generate multiple documents for a project
 *
 * This endpoint:
 * 1. Creates all documents in the database with DRAFT status
 * 2. Triggers a Temporal workflow for batch generation
 * 3. Returns workflow ID and document IDs for tracking
 *
 * AUTHORIZATION: Uses canEditProject() which verifies:
 * - Personal projects: User must be the owner
 * - Org projects: User must be org member AND (project owner OR project member with EDITOR role)
 *
 * Note: organizationId is retrieved from the project record itself for the Temporal workflow,
 * so we don't need it as an input parameter.
 */
export const batchGenerateDocumentsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/documents/batch-generate",
		tags: ["Projects", "Documents"],
		summary: "Batch generate multiple documents using AI with RAG",
	})
	.input(
		z.object({
			projectId: z.string(),
			timeZone: z.string().optional(),
			documents: z.array(
				z.object({
					type: z.enum([
						"GENERAL",
						"BUSINESS_CASE",
						"PRD",
						"PROPOSAL",
						"ARCHITECTURE",
						"TECHNICAL_SPEC",
						"USER_STORY",
						"API_SPEC",
					]),
					title: z.string(),
					prompt: z.string(),
					promptId: z
						.string()
						.optional()
						.describe(
							"Optional custom prompt ID from Prompt Library",
						),
				}),
			),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const { projectId, documents } = input;

		// Get project data
		const project = await db.project.findUnique({
			where: { id: projectId },
			include: {
				organization: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// Create all documents in database with DRAFT status
		const createdDocuments = await Promise.all(
			documents.map((doc) =>
				db.projectDocument.create({
					data: {
						projectId,
						type: doc.type,
						title: buildDocumentTitle(
							doc.type,
							project.name,
							doc.title,
							{ timeZone: input.timeZone },
						),
						content: "", // Empty initially
						status: "DRAFT",
						generationPrompt: doc.prompt,
						generationProgress: 0,
					},
				}),
			),
		);

		// Get Temporal client
		const client = await getTemporalClient();

		// Issue AI token in the API layer where AI_TOKEN_SECRET is available
		// This token will be passed to Temporal activities for agent authentication
		const aiToken = await issueAIToken({
			userId: user.id,
			organizationId: project.organizationId || undefined,
			source: "batch-document-generation",
			// Use longer expiry for batch operations (30 minutes)
			expirySeconds: 1800,
		});

		// Start batch generation workflow
		const workflowId = `batch-document-generation-${projectId}-${Date.now()}`;

		const handle = await client.workflow.start(
			"batchDocumentGenerationWorkflow",
			withCorrelationMemo({
				taskQueue: "project-documents",
				workflowId,
				args: [
					{
						projectId,
						userId: user.id,
						organizationId: project.organizationId || undefined,
						aiToken, // Pass pre-issued token to workflow
						documents: createdDocuments.map((doc, index) => ({
							id: doc.id,
							type: doc.type,
							title: doc.title,
							prompt: documents[index].prompt,
							promptId: documents[index].promptId, // NEW: Pass custom prompt ID
						})),
					},
				],
			}),
		);

		return {
			workflowId: handle.workflowId,
			runId: handle.firstExecutionRunId,
			documents: createdDocuments.map((doc) => ({
				id: doc.id,
				type: doc.type,
				title: doc.title,
				status: doc.status,
			})),
			message: `Batch generation started for ${createdDocuments.length} documents`,
		};
	});
