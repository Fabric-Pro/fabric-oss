import {
	getNewsletterSendImage,
	replaceNewsletterSendImageStorage,
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
 * Swap an image's picture for a new upload, keeping its highlight, position
 * and description. The image becomes an included upload again. The object it
 * replaced is deleted best-effort.
 */
export const replaceImageProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			imageId: z.string(),
			uploadToken: z.string().max(128),
			width: z.number().int().positive().max(20_000).optional(),
			height: z.number().int().positive().max(20_000).optional(),
		}),
	)
	.handler(async ({ input }) => {
		const project = await loadReviewProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		const current = await getNewsletterSendImage(project.id, input.imageId);
		if (!current) {
			throwImageRefusal({ reason: "IMAGE_NOT_FOUND" });
		}
		await requireImageReviewableSend(project.id, current.sendId);

		const upload = await commitNewsletterImageUpload(
			project,
			current.sendId,
			input.uploadToken,
		);
		const result = await replaceNewsletterSendImageStorage({
			projectId: project.id,
			imageId: input.imageId,
			storageKey: upload.storageKey,
			bytes: upload.bytes,
			width: input.width ?? null,
			height: input.height ?? null,
		});
		if (!result.ok) {
			await deleteNewsletterImageObjects([upload.storageKey]);
			throwImageRefusal(result.refusal);
		}
		await deleteNewsletterImageObjects([result.previousStorageKey]);
		return { image: await presentReviewImage(result.image) };
	});
