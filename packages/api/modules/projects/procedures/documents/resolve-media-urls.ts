import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { hasProjectAccess } from "@repo/database";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/** Maximum number of S3 keys that can be resolved in a single request */
const MAX_KEYS_PER_REQUEST = 50;

/**
 * AUTHORIZATION: Uses hasProjectAccess() - verifies org membership + project access
 * Resolves S3 keys to signed download URLs for displaying images in the editor.
 */
export const resolveMediaUrlsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/documents/:documentId/media/resolve-urls",
		tags: ["Projects", "Documents", "Media"],
		summary: "Resolve media URLs",
		description: "Generate signed download URLs for document media S3 keys",
	})
	.input(
		z.object({
			projectId: z.string(),
			documentId: z.string(),
			organizationId: z.string().nullable().optional(),
			s3Keys: z
				.array(z.string())
				.min(1)
				.max(MAX_KEYS_PER_REQUEST, {
					message: `Cannot resolve more than ${MAX_KEYS_PER_REQUEST} keys at once`,
				}),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, documentId, organizationId, s3Keys } = input;
		const user = context.user;

		const resolvedOrgId = resolveOrganizationId(
			organizationId,
			context.session,
		);

		// Check read access
		const hasAccess = await hasProjectAccess(
			projectId,
			user.id,
			resolvedOrgId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

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
		const urls: Record<string, string> = {};

		// Resolve all keys to signed URLs in parallel
		const results = await Promise.allSettled(
			s3Keys.map(async (key) => {
				const signedUrl = await storageProvider.getSignedUrl(key, {
					bucket,
					expiresIn: 3600, // 1 hour
				});
				return { key, url: signedUrl };
			}),
		);

		for (const result of results) {
			if (result.status === "fulfilled") {
				urls[result.value.key] = result.value.url;
			}
			// Skip failed keys silently - they may have been deleted
		}

		return { urls };
	});
