import { deleteNewsletterSendImage } from "@repo/database";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { cancelScreenshotCapture } from "../lib/review-captures";
import {
	deleteNewsletterImageObjects,
	loadReviewProject,
	throwImageRefusal,
} from "../lib/review-images";

/**
 * Remove an image from a held send; its object is deleted best-effort, and a
 * capture of it still running is stopped best-effort.
 */
export const removeImageProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			imageId: z.string(),
		}),
	)
	.handler(async ({ input }) => {
		const project = await loadReviewProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		const result = await deleteNewsletterSendImage({
			projectId: project.id,
			imageId: input.imageId,
		});
		if (!result.ok) {
			throwImageRefusal(result.refusal);
		}
		await deleteNewsletterImageObjects([result.storageKey]);
		if (result.wasCapturing) {
			await cancelScreenshotCapture(input.imageId);
		}
		return { imageId: input.imageId, removed: true as const };
	});
