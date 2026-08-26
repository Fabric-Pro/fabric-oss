import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { getDocumentById } from "@repo/database";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/** Supported image MIME types for document media */
const SUPPORTED_IMAGE_TYPES: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

/** Maximum file size: 5MB */
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

/**
 * AUTHORIZATION: `requireProjectPermission(DOCUMENT_CREATE)`.
 * Then verifies the document belongs to the specified project.
 */
export const createMediaUploadUrlProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/documents/:documentId/media/upload-url",
		tags: ["Projects", "Documents", "Media"],
		summary: "Create media upload URL",
		description:
			"Generate a signed URL for uploading an image to a project document",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
			organizationId: z.string().nullable().optional(),
			filename: z.string().min(1).max(255),
			mimeType: z.string(),
			size: z
				.number()
				.positive()
				.max(MAX_IMAGE_SIZE, {
					message: `File size must be less than ${MAX_IMAGE_SIZE / (1024 * 1024)}MB`,
				}),
		}),
	)
	.handler(async ({ input }) => {
		const {
			projectId,
			documentId,
			filename: _filename,
			mimeType,
			size: _size,
		} = input;

		// Validate MIME type
		const extension = SUPPORTED_IMAGE_TYPES[mimeType];
		if (!extension) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Unsupported image type: ${mimeType}. Supported types: PNG, JPEG, GIF, WebP`,
			});
		}

		// Verify document belongs to project
		const document = await getDocumentById(documentId);
		if (!document || document.project.id !== projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Document not found in this project",
			});
		}

		// Generate unique S3 key
		const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
		const s3Key = `document-media/${projectId}/${documentId}/${uniqueId}.${extension}`;
		const bucket = config.storage.bucketNames.projectContexts;

		// Get storage provider for signed URL
		const storageProvider = getStorageProvider();
		let signedUploadUrl: string | null = null;

		if (
			storageProvider.supportsPresignedUrls &&
			storageProvider.getSignedUploadUrl
		) {
			signedUploadUrl = await storageProvider.getSignedUploadUrl(s3Key, {
				bucket,
				contentType: mimeType,
			});
		}

		return {
			signedUploadUrl,
			s3Key,
			useServerUpload: !storageProvider.supportsPresignedUrls,
			storageProvider: storageProvider.type,
		};
	});
