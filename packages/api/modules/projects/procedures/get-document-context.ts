/**
 * Get Document Context Procedure
 *
 * Provides vector-searched RAG context for document editing.
 * Uses the same Qdrant vector search + reranking as the Temporal generation path,
 * ensuring chat editing and generation use identical context quality.
 *
 * AUTHORIZATION: Uses hasProjectAccess() - verifies org membership + project access
 */

import { ORPCError } from "@orpc/client";
import { hasProjectAccess } from "@repo/database";
import { logger } from "@repo/logs";
import {
	buildDocumentRetrievalQuery,
	contextMetaHeader,
	retrieveProjectContexts,
} from "@repo/rag";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const getDocumentContextProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/document-context",
		tags: ["Projects", "Documents"],
		summary: "Get document context",
		description:
			"Retrieve vector-searched RAG context for document generation/editing",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentType: z.string(),
			organizationId: z.string().nullable().optional(),
			userPrompt: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You do not have access to this project",
			});
		}

		try {
			// Build intent-optimized search query for the document type
			const query = buildDocumentRetrievalQuery(
				input.documentType,
				input.userPrompt,
			);

			// Vector search + reranking (same pipeline as Temporal generation)
			const contexts = await retrieveProjectContexts({
				projectId: input.projectId,
				query,
				userId: user.id,
				organizationId,
			});

			// Return just the content strings (same format as Temporal's
			// return). Each string carries the source's type label + AI
			// guidance header (#1888) when set — matching what the Temporal
			// document-generation path injects, so editor-side and
			// workflow-side generation agree. Header is "" when the flag is
			// off or the source is unannotated.
			const ragContexts = contexts.map(
				(c) => `${contextMetaHeader(c)}${c.content}`,
			);

			logger.info(
				`[getDocumentContext] Retrieved ${ragContexts.length} contexts for ${input.documentType}`,
				{
					projectId: input.projectId,
					documentType: input.documentType,
					contextCount: ragContexts.length,
				},
			);

			return { ragContexts };
		} catch (error) {
			// If AI provider is not configured, return empty contexts
			// (user can still edit without RAG)
			if (
				error instanceof Error &&
				error.message.includes("No AI provider configured")
			) {
				logger.warn(
					"[getDocumentContext] No AI provider configured, returning empty contexts",
				);
				return { ragContexts: [] };
			}

			logger.error(
				`[getDocumentContext] Failed to retrieve contexts: ${error}`,
			);
			return { ragContexts: [] };
		}
	});
