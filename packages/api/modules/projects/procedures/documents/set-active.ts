/**
 * Set Active Document Procedure
 *
 * Toggles a document as the active version for its type.
 * Deactivates the previous active document and manages Qdrant embeddings.
 *
 * AUTHORIZATION: `requireProjectPermission(DOCUMENT_UPDATE)` authorizes the
 * project. Every tenant use (RAG provider config, embedding, embedding removal)
 * takes the project row's organization, never `input.organizationId`.
 */

import { ORPCError } from "@orpc/client";
import { getEmbeddingRAGProviderConfig } from "@repo/ai";
import {
	getDocumentById,
	hasProjectAccess,
	setDocumentActive,
} from "@repo/database";
import { logger } from "@repo/logs";
import { embedProjectDocument, removeDocumentEmbedding } from "@repo/rag";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadProjectOrganizationId } from "../../lib/project-organization";

export const setActiveDocumentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/documents/:id/set-active",
		tags: ["Projects", "Documents"],
		summary: "Set document as active for its type",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			// Accepted for client compatibility and ignored: the tenant is the
			// project's own organization (see the handler).
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// The tenant is the organization that owns the project
		// `requireProjectPermission` authorized. `input.organizationId` is the
		// caller's own string: used here it would pick another organization's
		// RAG provider and key, and its embedding index. A project with no
		// organization is refused before anything is changed.
		const organizationId = await loadProjectOrganizationId(input.projectId);

		// Check project access
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
			// Toggle active status in database
			const { deactivatedDocId, activatedDocId } =
				await setDocumentActive({
					documentId: input.id,
					projectId: input.projectId,
				});

			// Remove embedding from deactivated document
			if (deactivatedDocId) {
				try {
					await removeDocumentEmbedding(
						deactivatedDocId,
						organizationId,
					);
				} catch (error) {
					logger.warn(
						`[SetActive] Failed to remove embedding for deactivated doc ${deactivatedDocId}: ${error}`,
					);
				}
			}

			// Embed the newly activated document if it has content
			const activatedDoc = await getDocumentById(activatedDocId);
			if (
				activatedDoc &&
				activatedDoc.status === "COMPLETE" &&
				activatedDoc.content
			) {
				try {
					const providerConfig = await getEmbeddingRAGProviderConfig({
						userId: user.id,
						organizationId,
					});

					await embedProjectDocument({
						documentId: activatedDocId,
						projectId: input.projectId,
						userId: user.id,
						organizationId,
						content: activatedDoc.content,
						documentType: activatedDoc.type,
						title: activatedDoc.title,
						apiKey: {
							apiKey: providerConfig.apiKey,
							provider: providerConfig.provider,
							baseUrl: providerConfig.baseUrl,
						},
					});
				} catch (error) {
					logger.warn(
						`[SetActive] Failed to embed activated doc ${activatedDocId}: ${error}`,
					);
				}
			}

			return {
				success: true,
				deactivatedDocId,
				activatedDocId,
			};
		} catch (error) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					error instanceof Error
						? error.message
						: "Failed to set document as active",
			});
		}
	});
