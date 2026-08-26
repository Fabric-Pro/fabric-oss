import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { db } from "@repo/database";
import { getStorageProvider } from "@repo/storage";
import {
	extensionForMime,
	resolveAttachmentMime,
} from "@repo/utils/attachment";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { resolveAttachmentLimits } from "../../../lib/attachment-limits";

const UPLOAD_URL_TTL_SECONDS = 300;

/**
 * Mint a ContentLength-bound presigned PUT URL for a story attachment.
 *
 * Authorization: `requireProjectPermission(STORY_UPDATE)`.
 * IDOR guard: confirms the story belongs to the specified project before
 * reserving a storage key.
 *
 * #1702 Part 1 — Task 5.
 */
export const createAttachmentUploadUrlProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/attachments/upload-url",
		tags: ["Projects", "Stories", "Attachments"],
		summary: "Create a story attachment upload URL",
	})
	.input(
		z.object({
			projectId: z.string(),
			userStoryId: z.string(),
			organizationId: z.string().nullable().optional(),
			filename: z.string().min(1).max(255),
			mimeType: z.string(),
			size: z.number().positive(),
		}),
	)
	.handler(async ({ input }) => {
		const limits = resolveAttachmentLimits();

		const resolvedMime = resolveAttachmentMime(
			input.filename,
			input.mimeType,
			limits.allowlist,
		);
		if (!resolvedMime) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Unsupported file type for "${input.filename}": ${input.mimeType || "unknown"}`,
			});
		}

		if (input.size > limits.maxBytes) {
			throw new ORPCError("BAD_REQUEST", {
				message: `File size must be at most ${Math.floor(limits.maxBytes / (1024 * 1024))}MB`,
			});
		}

		const extension = extensionForMime(resolvedMime) ?? "bin";

		// IDOR: confirm the story belongs to this project before reserving a key.
		const story = await db.userStory.findFirst({
			where: { id: input.userStoryId, projectId: input.projectId },
			select: { id: true },
		});
		if (!story) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}

		const storageKey = `story-attachments-tmp/${input.projectId}/${input.userStoryId}/${randomUUID()}.${extension}`;
		const bucket = config.storage.bucketNames.projectContexts;
		const storageProvider = getStorageProvider();

		if (
			!storageProvider.supportsPresignedUrls ||
			!storageProvider.getSignedDocumentUploadUrl
		) {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message: "Uploads are temporarily unavailable",
			});
		}

		// ContentLength-bound PUT: R2 rejects an oversize body at the edge.
		const signedUploadUrl =
			await storageProvider.getSignedDocumentUploadUrl(storageKey, {
				bucket,
				contentType: resolvedMime,
				contentLength: input.size,
				expiresIn: UPLOAD_URL_TTL_SECONDS,
			});

		return { signedUploadUrl, storageKey, contentType: resolvedMime };
	});
