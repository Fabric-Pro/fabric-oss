import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { getStoryById } from "@repo/database";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Supported image MIME types for story media.
 * Mirrors the document-media allowlist.
 */
const SUPPORTED_IMAGE_TYPES: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

/** Maximum file size: 5 MB (matches documents — see decisions.md cross-cutting). */
// Mirrors MAX_BYTES_PER_IMAGE in @repo/integrations/shared/attachment-constants. Keep in sync.
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

/**
 * Generate a signed URL for uploading a pasted/dropped image into a user
 * story's TipTap description.
 *
 * Mirrors `documents/create-media-upload-url.ts`. Uses the same bucket
 * (`config.storage.bucketNames.projectContexts`) but a parallel keyspace
 * (`story-media/{projectId}/{storyId}/{id}.{ext}`) so cross-story access
 * is impossible by construction.
 *
 * AUTHORIZATION: `requireProjectPermission(STORY_UPDATE)` — same permission
 * required by `updateStoryProcedure`. Then verifies the story belongs to
 * the specified project via `getStoryById(storyId, projectId)`, which
 * filters on both `id` AND `projectId` (XOR tenant gate).
 */
export const createMediaUploadUrlProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/stories/:storyId/media/upload-url",
		tags: ["Projects", "Stories", "Media"],
		summary: "Create story media upload URL",
		description:
			"Generate a signed URL for uploading an image to a user story's description",
	})
	.input(
		z.object({
			projectId: z.string(),
			userStoryId: z.string(),
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
			userStoryId,
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

		// Verify story belongs to project (XOR tenant filter — getStoryById
		// queries with `where: { id, projectId }` so a story belonging to a
		// different project resolves to null).
		const story = await getStoryById(userStoryId, projectId);
		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Story not found in this project",
			});
		}

		// Generate unique S3 key under the story-media keyspace
		const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
		const s3Key = `story-media/${projectId}/${userStoryId}/${uniqueId}.${extension}`;
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
