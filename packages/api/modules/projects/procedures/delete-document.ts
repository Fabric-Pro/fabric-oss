import { ORPCError } from "@orpc/client";
import {
	deleteDocument,
	getDocumentById,
	hasProjectAccess,
} from "@repo/database";
import { logger } from "@repo/logs";
import { removeDocumentEmbedding } from "@repo/rag";
import { z } from "zod";
import { emitActivity, emitDocumentChange } from "../../../lib/realtime";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const deleteDocumentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_DELETE))
	.route({
		method: "DELETE",
		path: "/projects/:projectId/documents/:id",
		tags: ["Projects", "Documents"],
		summary: "Delete document",
		description: "Delete a document and all its versions",
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
				message: "You don't have access to this project",
			});
		}

		// Get document info before deleting for the activity log
		const document = await getDocumentById(input.id);

		// TENANT ISOLATION (SOC 2 CC6.1/CC6.3): the permission gate only
		// authorizes `input.projectId`, but the delete targets `input.id`
		// alone. Bind the record to the authorized project so a caller with
		// DELETE on their own project cannot hard-delete another tenant's
		// document (and its versions/chats) by id.
		if (!document || document.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", { message: "Document not found" });
		}

		const documentTitle = document.title || "Untitled";
		const documentType = document.type;

		// Remove document embeddings from Qdrant (if any)
		try {
			await removeDocumentEmbedding(
				input.id,
				organizationId ?? undefined,
			);
		} catch (error) {
			// Non-fatal - document will still be deleted
			logger.warn(
				`[DeleteDocument] Failed to remove embeddings for ${input.id}: ${error}`,
			);
		}

		// Delete document (cascade deletes versions)
		await deleteDocument(input.id);

		// Emit real-time events for collaboration
		await Promise.all([
			emitDocumentChange({
				projectId: input.projectId,
				documentId: input.id,
				action: "deleted",
				userId: user.id,
				userName: user.name || "Anonymous",
				documentType,
				documentTitle,
			}),
			emitActivity({
				projectId: input.projectId,
				userId: user.id,
				userName: user.name || "Anonymous",
				activityType: "document_deleted",
				resourceType: "document",
				resourceId: input.id,
				resourceName: documentTitle,
				timestamp: new Date().toISOString(),
			}),
		]);

		return { success: true };
	});
