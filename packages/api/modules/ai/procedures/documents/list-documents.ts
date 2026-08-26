import { ORPCError } from "@orpc/server";
import { getChatDocumentsByChatIdForOwner } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

/**
 * List all documents for a chat
 * Returns documents sorted by creation date (newest first)
 */
export const listDocuments = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "GET",
		path: "/ai/chats/{chatId}/documents",
		tags: ["AI Documents"],
		summary: "List chat documents",
		description: "List all documents attached to a chat",
	})
	.input(z.object({ chatId: z.string() }))
	.handler(async ({ input, context }) => {
		const { chatId } = input;

		// Per-user scoping — if the caller does not own the chat, the
		// helper returns []. Prevents another org member from listing
		// a peer's uploads by chatId.
		const documents = await getChatDocumentsByChatIdForOwner(
			chatId,
			context.user.id,
		);

		// Defense-in-depth: if the chat is org-scoped, the caller must
		// still be a member. Every document in the chat shares the
		// same organizationId so we only need to check once. Matches
		// the guard in get-download-url / process-document.
		const orgScopedDoc = documents.find((d) => d.organizationId);
		if (orgScopedDoc?.organizationId) {
			const membership = await verifyOrganizationMembership(
				orgScopedDoc.organizationId,
				context.user.id,
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "Not a member of this organization",
				});
			}
		}

		return {
			documents: documents.map((doc) => ({
				id: doc.id,
				chatId: doc.chatId,
				filename: doc.filename,
				mimeType: doc.mimeType,
				size: doc.size,
				status: doc.status,
				workflowStatus: doc.workflowStatus,
				extractorUsed: doc.extractorUsed,
				pageCount: doc.pageCount,
				hasTables: doc.hasTables,
				hasImages: doc.hasImages,
				createdAt: doc.createdAt,
				updatedAt: doc.updatedAt,
				errorMessage: doc.errorMessage,
			})),
		};
	});
