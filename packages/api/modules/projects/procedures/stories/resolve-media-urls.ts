import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { getStoryById, hasProjectAccess } from "@repo/database";
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
 * Resolve story-media S3 keys to short-lived signed download URLs so the
 * StoryWorkspace TipTap editor can render previously-uploaded images.
 *
 * Mirrors `documents/resolve-media-urls.ts`. Two layers of access control:
 *   1. `hasProjectAccess` — verifies org membership + project access.
 *   2. `getStoryById(storyId, projectId)` — XOR tenant gate that confirms
 *      the story belongs to the requested project.
 *   3. Every requested S3 key MUST start with the exact prefix
 *      `story-media/{projectId}/{storyId}/` to prevent any cross-story or
 *      cross-project key resolution (defense in depth).
 *
 * AUTHORIZATION: `requireProjectPermission(STORY_UPDATE)` — same permission
 * required to upload story media; reading signed URLs is gated to editors.
 */
export const resolveMediaUrlsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/stories/:storyId/media/resolve-urls",
		tags: ["Projects", "Stories", "Media"],
		summary: "Resolve story media URLs",
		description: "Generate signed download URLs for story media S3 keys",
	})
	.input(
		z.object({
			projectId: z.string(),
			userStoryId: z.string(),
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
		const { projectId, userStoryId, organizationId, s3Keys } = input;
		const user = context.user;

		const resolvedOrgId = resolveOrganizationId(
			organizationId,
			context.session,
		);

		// Check read access (org membership + project access)
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

		// Confirm story exists in this project (XOR tenant gate)
		const story = await getStoryById(userStoryId, projectId);
		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Story not found in this project",
			});
		}

		// Validate all keys belong to this project/story keyspace
		const expectedPrefix = `story-media/${projectId}/${userStoryId}/`;
		const invalidKeys = s3Keys.filter(
			(key) => !key.startsWith(expectedPrefix),
		);
		if (invalidKeys.length > 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: "One or more S3 keys do not belong to this story",
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
			// Skip failed keys silently — they may have been deleted
		}

		return { urls };
	});
