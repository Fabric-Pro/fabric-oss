import { ORPCError } from "@orpc/server";
import { db, getChatDocumentByIdForOwner } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

/**
 * Get the status of a document
 * Returns the current processing status and workflow information
 */
export const getDocumentStatus = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "GET",
		path: "/ai/documents/{documentId}/status",
		tags: ["AI Documents"],
		summary: "Get document status",
		description: "Get the current processing status of a document",
	})
	.input(z.object({ documentId: z.string() }))
	.handler(async ({ input, context }) => {
		const { documentId } = input;

		// Per-user scoping — status reveals workflow + error metadata
		// that peers in the same org should not see.
		const document = await getChatDocumentByIdForOwner(
			documentId,
			context.user.id,
		);

		if (!document) {
			return {
				found: false,
				status: null,
				workflowStatus: null,
				lastError: null,
			};
		}

		// Defense-in-depth: org-scoped document requires the caller is
		// still a member (mirrors get-download-url / process-document).
		if (document.organizationId) {
			const membership = await verifyOrganizationMembership(
				document.organizationId,
				context.user.id,
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "Not a member of this organization",
				});
			}
		}

		// Chunk count is scoped to the caller's chunks; the ownership
		// is enforced above on the parent document, so a mismatch
		// here would be a data-integrity bug, not a leak.
		const chunkCount = await db.documentChunk.count({
			where: { documentId, userId: context.user.id },
		});

		return {
			found: true,
			status: document.status,
			workflowStatus: document.workflowStatus,
			extractorUsed: document.extractorUsed,
			pageCount: document.pageCount,
			chunkCount,
			lastError: document.lastError,
		};
	});
