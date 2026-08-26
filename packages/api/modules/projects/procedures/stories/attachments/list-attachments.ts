import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { db } from "@repo/database";
import { getStorageProvider } from "@repo/storage";
import { buildContentDisposition } from "@repo/utils/attachment";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";

const DOWNLOAD_URL_TTL_SECONDS = 3600;

/**
 * List a story's attachments with per-row 1 h signed GET download URLs.
 *
 * Authorization: `requireProjectPermission(STORY_READ)` — read-only viewers
 * must be able to download attachments (FR-16).
 *
 * Each row gets a signed GET URL carrying a Content-Disposition header so
 * browsers keep the original filename on download. If signing fails for an
 * individual row (e.g. orphaned storage key), `downloadUrl` is set to null
 * rather than failing the whole request.
 *
 * storageKey is NEVER returned to the client.
 *
 * #1702 Part 1 — Task 7.
 */
export const listAttachmentsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/{storyId}/attachments",
		tags: ["Projects", "Stories", "Attachments"],
		summary: "List a story's attachments with signed download URLs",
	})
	.input(
		z.object({
			projectId: z.string(),
			userStoryId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		// 1. IDOR: story must belong to the project.
		const story = await db.userStory.findFirst({
			where: { id: input.userStoryId, projectId: input.projectId },
			select: { id: true },
		});
		if (!story) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}

		// 3. Fetch all attachment rows for this story, ordered by creation time.
		//    Soft-deleted rows (deletedAt != null) are unconditionally excluded.
		const rows = await db.storyAttachment.findMany({
			where: { storyId: input.userStoryId, deletedAt: null },
			orderBy: { createdAt: "asc" },
			select: {
				id: true,
				filename: true,
				mimeType: true,
				sizeBytes: true,
				designation: true,
				source: true,
				sourceTool: true,
				promotedAt: true,
				externalAuthor: true,
				externalCreatedAt: true,
				createdAt: true,
				storageKey: true,
			},
		});

		const bucket = config.storage.bucketNames.projectContexts;
		const storageProvider = getStorageProvider();
		const expectedPrefix = `story-attachments/${input.projectId}/${input.userStoryId}/`;

		// 4. Mint signed download URLs (1 h TTL, Content-Disposition for filename preservation).
		//    On sign failure set downloadUrl: null (orphan tolerance).
		const attachments = await Promise.all(
			rows.map(async (r) => {
				let downloadUrl: string | null = null;
				if (r.storageKey.startsWith(expectedPrefix)) {
					try {
						downloadUrl = await storageProvider.getSignedUrl(
							r.storageKey,
							{
								bucket,
								expiresIn: DOWNLOAD_URL_TTL_SECONDS,
								responseContentDisposition:
									buildContentDisposition(r.filename),
							},
						);
					} catch {
						downloadUrl = null;
					}
				}
				// Explicit projection, not a spread-minus-storageKey. This
				// payload goes to the browser, and the row now carries
				// `extractedText` — cached document text for the AI-context
				// resolver. A spread makes the response an open set: every
				// column added to the model, and every future widening of the
				// `select` above, ships to the client by default and silently.
				// Naming the fields makes the payload a closed set, so exposing
				// something new takes an edit here.
				return {
					id: r.id,
					filename: r.filename,
					mimeType: r.mimeType,
					sizeBytes: r.sizeBytes,
					designation: r.designation,
					source: r.source,
					sourceTool: r.sourceTool,
					promotedAt: r.promotedAt,
					externalAuthor: r.externalAuthor,
					externalCreatedAt: r.externalCreatedAt,
					createdAt: r.createdAt,
					downloadUrl,
				};
			}),
		);

		return { attachments };
	});
