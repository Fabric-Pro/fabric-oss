import {
	includeAllNewsletterSendImages,
	removedHighlightIndexesSchema,
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
 * Include every ready image of a held send in one change, under the
 * highlights the reviewer keeps. Returns the images it included; the rest are
 * unchanged.
 */
export const includeAllImagesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			sendId: z.string(),
			removedHighlightIndexes: removedHighlightIndexesSchema.default([]),
		}),
	)
	.handler(async ({ input }) => {
		const project = await loadReviewProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		const result = await includeAllNewsletterSendImages({
			projectId: project.id,
			sendId: input.sendId,
			removedHighlightIndexes: input.removedHighlightIndexes,
		});
		if (!result.ok) {
			throwImageRefusal(result.refusal);
		}
		return {
			images: await Promise.all(result.images.map(presentReviewImage)),
		};
	});
