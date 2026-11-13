import {
	getNewsletterSendImage,
	NEWSLETTER_CAPTURE_BRIEF_MAX,
	releaseStaleNewsletterCaptures,
	startNewsletterImageRecapture,
} from "@repo/database";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertCapabilityAvailable } from "../../capabilities/assert";
import {
	requireCapturableHighlight,
	requireCaptureWorker,
	startScreenshotCapture,
} from "../lib/review-captures";
import {
	loadReviewProject,
	presentReviewImage,
	throwImageRefusal,
} from "../lib/review-images";

/**
 * Capture a captured image again, optionally with new words for what to show.
 * The current picture stays until the new one lands; a failed capture keeps
 * it and shows the reason. Refused for an uploaded image and while a capture
 * of it is still running.
 */
export const regenerateImageProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			imageId: z.string(),
			prompt: z
				.string()
				.trim()
				.min(1)
				.max(NEWSLETTER_CAPTURE_BRIEF_MAX)
				.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await loadReviewProject(input.projectId);
		assertInputOrgMatchesProject(input.organizationId, project);
		await assertCapabilityAvailable({
			capabilityKey: "release-notes.generate",
			projectId: project.id,
			userId: context.user.id,
			organizationId: project.organizationId ?? null,
		});
		const current = await getNewsletterSendImage(project.id, input.imageId);
		if (!current) {
			throwImageRefusal({ reason: "IMAGE_NOT_FOUND" });
		}
		const highlight = await requireCapturableHighlight(
			project.id,
			current.sendId,
			current.highlightIndex,
		);
		await requireCaptureWorker();
		// A capture that stopped without a result would otherwise refuse this
		// one as still running, for good.
		await releaseStaleNewsletterCaptures({
			projectId: project.id,
			sendId: current.sendId,
		});
		const result = await startNewsletterImageRecapture({
			projectId: project.id,
			imageId: input.imageId,
			prompt: input.prompt,
			actor: {
				userId: context.user.id,
				email: context.user.email ?? null,
				name: context.user.name ?? null,
			},
		});
		if (!result.ok) {
			throwImageRefusal(result.refusal);
		}
		await startScreenshotCapture({ imageId: result.image.id, highlight });
		return { image: await presentReviewImage(result.image) };
	});
