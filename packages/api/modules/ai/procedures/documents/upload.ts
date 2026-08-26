import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import {
	getChatDocumentByIdForOwner,
	updateDocumentStatus,
} from "@repo/database";
import { getStorageProvider, uploadFile } from "@repo/storage";
import {
	AI_CHAT_WORKBOOK_SIGNATURE_BYTES,
	classifyAiChatWorkbook,
} from "@repo/utils/ai-chat-attachment";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";
import {
	describeAiChatWorkbookRejection,
	resolveAiChatAttachmentLimits,
	resolveAiChatUploadMime,
} from "../../lib/ai-chat-attachment-limits";

/**
 * Server-side file upload endpoint
 *
 * This endpoint is used when the storage provider doesn't support presigned URLs
 * (e.g., Vercel Blob). The client sends the file data to this endpoint, and we
 * upload it to the storage provider.
 *
 * For S3-compatible providers, clients should use the presigned URL flow instead.
 */
export const uploadDocument = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "POST",
		path: "/ai/documents/upload",
		tags: ["AI"],
		summary: "Upload document to storage",
		description:
			"Upload a document file directly to storage (for providers that don't support presigned URLs)",
	})
	.input(
		z.object({
			documentId: z.string(),
			// File data as base64 encoded string
			fileData: z.string(),
			mimeType: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { documentId, fileData, mimeType } = input;
		const user = context.user;

		console.log("[UploadDocument] Starting document upload");
		console.log("[UploadDocument] Document ID:", documentId);
		console.log("[UploadDocument] User ID:", user.id);

		// Per-user ownership enforced by the helper — a document
		// belonging to another user returns null.
		const document = await getChatDocumentByIdForOwner(documentId, user.id);

		if (!document) {
			throw new ORPCError("NOT_FOUND", {
				message: "Document not found",
			});
		}

		// Defense-in-depth: org-scoped document requires the caller is
		// still a member. Without this, a removed owner whose
		// cascade-delete is still in flight could keep writing bytes
		// into the org-scoped storage path and flip status to
		// PROCESSING/FAILED. Matches get-download-url / process-document.
		if (document.organizationId) {
			const membership = await verifyOrganizationMembership(
				document.organizationId,
				user.id,
			);
			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "Not a member of this organization",
				});
			}
		}

		// Verify document is pending
		if (document.status !== "PENDING") {
			throw new ORPCError("BAD_REQUEST", {
				message: `Document already ${document.status.toLowerCase()}`,
			});
		}

		// This path is the only one that measures real bytes — the presigned
		// path binds ContentLength at the storage edge instead. Both read the
		// same resolved cap, so an operator lowering it is honored here too.
		const limits = resolveAiChatAttachmentLimits();

		// Type admission, which this path previously skipped entirely: it
		// accepted any MIME the caller declared. Resolving by extension when the
		// declared MIME is not allowlisted admits an .xlsx that Windows
		// mislabels as legacy ms-excel; a genuine .xls is still refused.
		const resolvedMime = resolveAiChatUploadMime(
			document.filename,
			mimeType,
		);
		if (!resolvedMime) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Unsupported file type for "${document.filename}": ${mimeType || "unknown"}`,
			});
		}

		// Decode base64 file data
		const buffer = Buffer.from(fileData, "base64");

		// Validate file size
		if (buffer.length > limits.maxBytes) {
			throw new ORPCError("BAD_REQUEST", {
				message: `File size must be at most ${Math.floor(limits.maxBytes / (1024 * 1024))}MB`,
			});
		}

		// Container-signature check against the bytes actually received. The
		// hook runs the same classifier at file selection, but that is an
		// advisory affordance: `accept` is only a picker hint, paste/drop
		// bypass it, and this endpoint is reachable directly. This is the
		// control. Non-workbook filenames classify as accepted and are
		// unaffected.
		const classification = classifyAiChatWorkbook(
			buffer.subarray(0, AI_CHAT_WORKBOOK_SIGNATURE_BYTES),
			document.filename,
		);
		if (classification !== "accepted") {
			throw new ORPCError("BAD_REQUEST", {
				message: describeAiChatWorkbookRejection(
					classification,
					document.filename,
				),
			});
		}

		// Get storage provider
		const storageProvider = getStorageProvider();

		console.log(
			"[UploadDocument] Uploading to storage provider:",
			storageProvider.type,
		);
		console.log("[UploadDocument] Storage path:", document.s3Path);

		try {
			// Upload to storage
			const result = await uploadFile(document.s3Path, buffer, {
				bucket: config.storage.bucketNames.chatDocuments,
				contentType: resolvedMime,
				access: "public",
			});

			console.log("[UploadDocument] Upload successful:", result.url);

			// Update document status - file is now uploaded and ready for processing
			// Using PROCESSING status to indicate file was uploaded and ready for next step
			await updateDocumentStatus({
				documentId,
				status: "PROCESSING",
			});

			return {
				success: true,
				documentId,
				url: result.url,
			};
		} catch (error) {
			console.error("[UploadDocument] Upload failed:", error);

			// Update document status to failed
			await updateDocumentStatus({
				documentId,
				status: "FAILED",
				errorMessage: "Failed to upload document to storage",
			});

			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to upload document to storage",
			});
		}
	});
