import { ORPCError } from "@orpc/server";
import {
	getChatDocumentByIdForOwner,
	getDocumentChunksForOwner,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

/**
 * Get the extracted text content of a processed document
 * Returns concatenated chunks ordered by chunk index
 */
export const getDocumentContent = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "GET",
		path: "/ai/documents/{documentId}/content",
		tags: ["AI Documents"],
		summary: "Get document content",
		description: "Get the extracted text content of a processed document",
	})
	.input(z.object({ documentId: z.string() }))
	.handler(async ({ input, context }) => {
		const { documentId } = input;

		// Per-user scoping — peers in the same org cannot read each
		// other's extracted document content by id.
		const document = await getChatDocumentByIdForOwner(
			documentId,
			context.user.id,
		);

		if (!document) {
			return { found: false, content: "", status: null };
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

		if (document.status !== "READY") {
			return {
				found: true,
				content: "",
				status: document.status,
			};
		}

		const chunks = await getDocumentChunksForOwner(
			documentId,
			context.user.id,
		);
		const content = chunks.map((c) => c.content).join("\n\n");

		return {
			found: true,
			content,
			status: document.status,
		};
	});
