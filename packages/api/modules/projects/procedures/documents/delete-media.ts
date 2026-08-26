import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * AUTHORIZATION: `requireProjectPermission(DOCUMENT_UPDATE)` — removing media
 * from a document is a document-edit operation, not a document-deletion
 * operation. DOCUMENT_DELETE is PROJECT_ADMIN+ only and would 403 editors,
 * regressing the prior canEditProject contract.
 * Deletes media files from S3 with error isolation per file.
 */
export const deleteMediaProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/documents/:documentId/media/delete",
		tags: ["Projects", "Documents", "Media"],
		summary: "Delete document media",
		description: "Delete media files from storage for a project document",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
			organizationId: z.string().nullable().optional(),
			s3Keys: z.array(z.string()).min(1).max(50),
		}),
	)
	.handler(async ({ input }) => {
		const { projectId, documentId, s3Keys } = input;

		// Validate all keys belong to this project/document
		const expectedPrefix = `document-media/${projectId}/${documentId}/`;
		const invalidKeys = s3Keys.filter(
			(key) => !key.startsWith(expectedPrefix),
		);
		if (invalidKeys.length > 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: "One or more S3 keys do not belong to this document",
			});
		}

		const storageProvider = getStorageProvider();
		const bucket = config.storage.bucketNames.projectContexts;
		let deleted = 0;
		const errors: string[] = [];

		// Delete each file with error isolation
		const results = await Promise.allSettled(
			s3Keys.map(async (key) => {
				await storageProvider.deleteFile(key, { bucket });
				return key;
			}),
		);

		for (const result of results) {
			if (result.status === "fulfilled") {
				deleted++;
			} else {
				errors.push(result.reason?.message || "Unknown delete error");
			}
		}

		return { deleted, errors };
	});
