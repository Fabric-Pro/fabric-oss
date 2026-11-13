import {
	createNewsletterSendImage,
	NEWSLETTER_IMAGE_ALT_TEXT_MAX,
} from "@repo/database";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	commitNewsletterImageUpload,
	deleteNewsletterImageObjects,
	loadReviewProject,
	presentReviewImage,
	requireImageReviewableSend,
	throwImageRefusal,
} from "../lib/review-images";

/**
 * Attach an uploaded image to one highlight of a held send. The upload is
 * named by the token `sends.images.createUploadUrl` returned; its stored type,
 * size and leading bytes are checked before anything references it. A new
 * image is included in the email by default. Refused when the highlight
 * already has its maximum, the index is outside the frozen highlights, the
 * send is no longer held (CONFLICT) or does not take images (BAD_REQUEST); a
 * refused image's object is deleted.
 */
export const addImageProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			sendId: z.string(),
			highlightIndex: z.number().int().min(0),
			uploadToken: z.string().max(128),
			altText: z.string().max(NEWSLETTER_IMAGE_ALT_TEXT_MAX).optional(),
			width: z.number().int().positive().max(20_000).optional(),
			height: z.number().int().positive().max(20_000).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await loadReviewProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		await requireImageReviewableSend(project.id, input.sendId);

		const upload = await commitNewsletterImageUpload(
			project,
			input.sendId,
			input.uploadToken,
		);
		const result = await createNewsletterSendImage({
			projectId: project.id,
			sendId: input.sendId,
			highlightIndex: input.highlightIndex,
			storageKey: upload.storageKey,
			bytes: upload.bytes,
			width: input.width ?? null,
			height: input.height ?? null,
			altText: input.altText ?? "",
			createdByUserId: context.user.id,
		});
		if (!result.ok) {
			await deleteNewsletterImageObjects([upload.storageKey]);
			throwImageRefusal(result.refusal);
		}
		return { image: await presentReviewImage(result.image) };
	});
