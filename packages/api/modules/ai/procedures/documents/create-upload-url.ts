import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import {
	createAiChat,
	createChatDocument,
	getAiChatByIdForOwner,
} from "@repo/database";
import { getStorageProvider } from "@repo/storage";
import { extensionsForAiChatMime } from "@repo/utils/ai-chat-attachment";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";
import {
	resolveAiChatAttachmentLimits,
	resolveAiChatUploadMime,
} from "../../lib/ai-chat-attachment-limits";

const UPLOAD_URL_TTL_SECONDS = 3600;

export const createDocumentUploadUrl = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "POST",
		path: "/ai/documents/upload-url",
		tags: ["AI"],
		summary: "Create document upload URL",
		description: "Generate a signed URL for uploading a document to a chat",
	})
	.input(
		z.object({
			chatId: z.string().optional(),
			organizationId: z.string().nullable().optional(),
			filename: z.string(),
			mimeType: z.string(),
			// Bounded in the handler against the resolved cap, not here: the
			// operator override is read per request, and a module-scope `.max()`
			// would freeze whatever the env said at import time.
			size: z.number().positive(),
		}),
	)
	.handler(async ({ input, context }) => {
		const {
			filename,
			mimeType,
			size,
			organizationId: inputOrgId,
			chatId: inputChatId,
		} = input;
		const user = context.user;
		const organizationId = resolveOrganizationId(
			inputOrgId,
			context.session,
		);

		console.log("[CreateUploadURL] Starting document upload URL creation");
		console.log("[CreateUploadURL] Input chatId:", inputChatId);
		console.log("[CreateUploadURL] Filename:", filename);
		console.log("[CreateUploadURL] User ID:", user.id);
		console.log("[CreateUploadURL] Organization ID:", organizationId);

		try {
			// Per-user ownership: if the caller passed a chatId they must
			// own it. If the lookup misses (bad id OR another member's
			// chat), fall through to auto-create, which always belongs
			// to the caller.
			let chat = inputChatId
				? await getAiChatByIdForOwner(inputChatId, user.id)
				: null;

			if (!chat) {
				console.log(
					"[CreateUploadURL] Chat not found, creating new chat for document attachment",
				);
				chat = await createAiChat({
					userId: user.id,
					organizationId,
					title: "Document Upload",
				});
				console.log("[CreateUploadURL] Created new chat:", chat.id);
			}

			// At this point, chat is guaranteed to be non-null
			const chatId = chat.id;

			console.log(
				"[CreateUploadURL] Chat found/created:",
				`ID=${chat.id}`,
			);

			// If the chat is org-scoped, verify the caller is still a
			// member (defense-in-depth against a chat that outlives its
			// cascade-delete).
			if (chat.organizationId) {
				const membership = await verifyOrganizationMembership(
					chat.organizationId,
					user.id,
				);

				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message: "Not a member of this organization",
					});
				}
			}

			// Validate file type against the live allowlist. Resolving by
			// extension when the declared MIME is not allowlisted admits an
			// .xlsx that Windows mislabels as legacy ms-excel, while a genuine
			// .xls still resolves to ms-excel and is refused.
			const limits = resolveAiChatAttachmentLimits();
			const resolvedMime = resolveAiChatUploadMime(filename, mimeType);
			if (!resolvedMime) {
				throw new ORPCError("BAD_REQUEST", {
					message: `Unsupported file type for "${filename}": ${mimeType || "unknown"}`,
				});
			}

			if (size > limits.maxBytes) {
				throw new ORPCError("BAD_REQUEST", {
					message: `File size must be at most ${Math.floor(limits.maxBytes / (1024 * 1024))}MB`,
				});
			}

			// Generate document ID and storage path. The extension comes from the
			// resolved MIME rather than the raw filename, so a filename can no
			// longer steer the storage key (it could previously contain a slash
			// and nest the object deeper under the owner's prefix).
			const documentId = `doc_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const ownerPrefix = chat.organizationId || chat.userId;
			const extension = extensionsForAiChatMime(resolvedMime)[0] ?? "bin";
			const storagePath = `${ownerPrefix}/${chatId}/${documentId}.${extension}`;

			// Get storage provider to determine upload method
			const storageProvider = getStorageProvider();
			const supportsPresignedUrls = storageProvider.supportsPresignedUrls;

			let signedUploadUrl: string | null = null;

			if (
				supportsPresignedUrls &&
				storageProvider.getSignedDocumentUploadUrl
			) {
				// ContentLength-bound PUT: storage rejects an oversize body at
				// the edge. `getSignedUploadUrl` signs no ContentLength, which
				// left `size` a client-declared number no layer enforced — a
				// caller could declare a kilobyte and upload gigabytes, and
				// process-document would materialize all of it. Same control the
				// story-attachment path already carries.
				signedUploadUrl =
					await storageProvider.getSignedDocumentUploadUrl(
						storagePath,
						{
							bucket: config.storage.bucketNames.chatDocuments,
							contentType: resolvedMime,
							contentLength: size,
							expiresIn: UPLOAD_URL_TTL_SECONDS,
						},
					);
			}
			// No presigned support leaves signedUploadUrl null and the client
			// falls back to POST /ai/documents/upload, which measures the
			// decoded buffer against the same resolved cap.

			// Create database record
			console.log("[CreateUploadURL] Creating database record");
			console.log("[CreateUploadURL] Document ID:", documentId);
			console.log("[CreateUploadURL] Chat ID:", chatId);
			console.log("[CreateUploadURL] User ID:", user.id);
			console.log(
				"[CreateUploadURL] Organization ID:",
				chat.organizationId,
			);
			console.log(
				"[CreateUploadURL] Storage provider:",
				storageProvider.type,
			);

			await createChatDocument({
				id: documentId,
				chatId,
				userId: user.id,
				organizationId: chat.organizationId,
				filename,
				// The resolved MIME, not the declared one: a mislabeled .xlsx
				// stored as legacy ms-excel would find no extractor downstream.
				mimeType: resolvedMime,
				size,
				s3Path: storagePath,
				status: "PENDING",
			});

			console.log(
				"[CreateUploadURL] Database record created successfully",
			);
			console.log("[CreateUploadURL] Returning documentId:", documentId);

			return {
				documentId,
				// For S3: presigned URL for direct upload
				// For Vercel Blob: null (client should use /ai/documents/upload endpoint)
				signedUploadUrl,
				s3Path: storagePath,
				chatId: chatId as string,
				// Flag to indicate if client should use server-side upload
				useServerUpload: !supportsPresignedUrls,
				storageProvider: storageProvider.type,
			};
		} catch (error) {
			// Re-throw ORPCErrors as-is (FORBIDDEN, BAD_REQUEST, etc.)
			if (error instanceof ORPCError) {
				throw error;
			}
			console.error("[CreateUploadURL] Unexpected error:", error);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Document upload URL creation failed: ${(error as Error).message}`,
			});
		}
	});
