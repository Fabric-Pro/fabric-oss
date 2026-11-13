import { ORPCError } from "@orpc/server";
import {
	clearPublishedNewsletterSendImages,
	listPublishedNewsletterSendImages,
} from "@repo/database";
import { newsletterImageBucket } from "@repo/database/prisma/queries/projects/newsletter-image-publish";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { loadReviewProject, throwImageRefusal } from "../lib/review-images";

/**
 * Take a sent newsletter's images down: delete the public copies approval
 * published, so they disappear from the emails already delivered, then clear
 * their public keys and drop them from the archived content. An image whose
 * copy could not be deleted keeps its key, so asking again retries it; the
 * request then fails and says so.
 */
export const unpublishImagesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			sendId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await loadReviewProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		const listed = await listPublishedNewsletterSendImages(
			project.id,
			input.sendId,
		);
		if (!listed.ok) {
			throwImageRefusal(listed.refusal);
		}
		if (listed.images.length === 0) {
			return { removed: 0 };
		}

		const keys = listed.images.map((image) => image.publicKey);
		let failedKeys: Set<string>;
		try {
			const result = await getStorageProvider().deleteObjects(keys, {
				bucket: newsletterImageBucket(),
			});
			failedKeys = new Set(result.errors.map((error) => error.key));
		} catch (error) {
			logger.warn("[Newsletter] published images not deleted", {
				sendId: input.sendId,
				error: error instanceof Error ? error.name : "unknown",
			});
			failedKeys = new Set(keys);
		}

		const removed = await clearPublishedNewsletterSendImages({
			projectId: project.id,
			sendId: input.sendId,
			imageIds: listed.images
				.filter((image) => !failedKeys.has(image.publicKey))
				.map((image) => image.id),
			failedCount: failedKeys.size,
			actor: {
				userId: context.user.id,
				email: context.user.email ?? null,
				name: context.user.name ?? null,
			},
		});
		if (failedKeys.size > 0) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"Some published images could not be removed. Try again.",
				data: { removed },
			});
		}
		return { removed };
	});
