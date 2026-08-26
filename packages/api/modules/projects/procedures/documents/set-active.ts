/**
 * Set Active Document Procedure
 *
 * Toggles a document as the active version for its type.
 * Deactivates the previous active document and manages Qdrant embeddings.
 *
 * AUTHORIZATION: Uses hasProjectAccess() - verifies org membership + project access
 */

import { ORPCError } from "@orpc/client";
import { getRAGProviderConfig } from "@repo/ai";
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
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

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
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

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
						organizationId ?? undefined,
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
					const providerConfig = await getRAGProviderConfig({
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
