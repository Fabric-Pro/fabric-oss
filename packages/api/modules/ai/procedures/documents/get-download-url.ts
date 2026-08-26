import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { getChatDocumentByIdForOwner } from "@repo/database";
import { getSignedUrl } from "@repo/storage";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

/**
 * Get a signed download URL for a document
 * Returns a temporary URL that allows downloading the document from S3
 */
export const getDocumentDownloadUrl = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "GET",
		path: "/ai/documents/{documentId}/download",
		tags: ["AI Documents"],
		summary: "Get document download URL",
		description: "Get a signed URL for downloading a document",
	})
	.input(z.object({ documentId: z.string() }))
	.handler(async ({ input, context }) => {
		const { documentId } = input;

		// Per-user scoping — prevents a peer with a guessed/leaked
		// documentId from minting a signed download URL for another
		// member's upload.
		const document = await getChatDocumentByIdForOwner(
			documentId,
			context.user.id,
		);

		if (!document) {
			throw new ORPCError("NOT_FOUND", { message: "Document not found" });
		}

		// Defense-in-depth: if the document is org-scoped, the caller
		// must still be a member (closes a window where a document
		// outlives its cascade-delete after the owner is removed).
		if (document.organizationId) {
			const membership = await verifyOrganizationMembership(
				document.organizationId,
				context.user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "Not authorized to access this document",
				});
			}
		}

		// Use the same bucket name as the upload procedure
		const bucketName = config.storage.bucketNames.chatDocuments;

		// 5 min so URLs minted pre-revocation expire quickly.
		const signedUrl = await getSignedUrl(document.s3Path, {
			bucket: bucketName,
			expiresIn: 300,
		});

		return {
			url: signedUrl,
			filename: document.filename,
			mimeType: document.mimeType,
			size: document.size,
		};
	});
