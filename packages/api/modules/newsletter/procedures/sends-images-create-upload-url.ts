import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	createNewsletterImageUpload,
	loadReviewProject,
	NEWSLETTER_IMAGE_CONTENT_TYPES,
	NEWSLETTER_IMAGE_MAX_BYTES,
	requireImageReviewableSend,
} from "../lib/review-images";

/**
 * A signed PUT for one image of a held send, and the token that names it to
 * `sends.images.add` / `sends.images.replace`. The object key is built from
 * the project's tenant, the send and a server-generated token; the caller
 * never names a key. With `contentLength` the PUT is signed for exactly that
 * size; either way the stored type and size are checked again on commit.
 */
export const createImageUploadUrlProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			sendId: z.string(),
			contentType: z.enum(NEWSLETTER_IMAGE_CONTENT_TYPES),
			contentLength: z.number().int().positive().optional(),
		}),
	)
	.handler(async ({ input }) => {
		const project = await loadReviewProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		await requireImageReviewableSend(project.id, input.sendId);
		if (
			input.contentLength !== undefined &&
			input.contentLength > NEWSLETTER_IMAGE_MAX_BYTES
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "The image is too large",
				data: { code: "too_large" },
			});
		}
		return createNewsletterImageUpload(
			project,
			input.sendId,
			input.contentType,
			input.contentLength,
		);
	});
