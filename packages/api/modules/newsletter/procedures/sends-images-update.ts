import {
	NEWSLETTER_IMAGE_ALT_TEXT_MAX,
	newsletterImagePlacementSchema,
	updateNewsletterSendImage,
} from "@repo/database";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	loadReviewProject,
	presentReviewImage,
	throwImageRefusal,
} from "../lib/review-images";

/**
 * Include or exclude an image, edit its description, show it above or below
 * the highlight's text, or move it: to another highlight (refused when that
 * highlight is full) and/or to a position within its highlight (a position
 * past the end appends).
 */
export const updateImageProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			imageId: z.string(),
			included: z.boolean().optional(),
			altText: z.string().max(NEWSLETTER_IMAGE_ALT_TEXT_MAX).optional(),
			placement: newsletterImagePlacementSchema.optional(),
			highlightIndex: z.number().int().min(0).optional(),
			position: z.number().int().min(0).optional(),
		}),
	)
	.handler(async ({ input }) => {
		const project = await loadReviewProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		const result = await updateNewsletterSendImage({
			projectId: project.id,
			imageId: input.imageId,
			included: input.included,
			altText: input.altText,
			placement: input.placement,
			highlightIndex: input.highlightIndex,
			position: input.position,
		});
		if (!result.ok) {
			throwImageRefusal(result.refusal);
		}
		return { image: await presentReviewImage(result.image) };
	});
