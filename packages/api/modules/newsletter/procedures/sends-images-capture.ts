import {
	createPromptedNewsletterCapture,
	NEWSLETTER_CAPTURE_BRIEF_MAX,
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
 * Capture a new screenshot for a highlight from the reviewer's description of
 * the screen. The image is added at the end of the highlight, being captured,
 * and is included once the capture succeeds.
 */
export const captureImageProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			sendId: z.string(),
			highlightIndex: z.number().int().min(0),
			prompt: z.string().trim().min(1).max(NEWSLETTER_CAPTURE_BRIEF_MAX),
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
		const highlight = await requireCapturableHighlight(
			project.id,
			input.sendId,
			input.highlightIndex,
		);
		await requireCaptureWorker();
		const result = await createPromptedNewsletterCapture({
			projectId: project.id,
			sendId: input.sendId,
			highlightIndex: input.highlightIndex,
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
