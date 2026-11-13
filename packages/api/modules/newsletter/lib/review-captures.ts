import { ORPCError } from "@orpc/server";
import {
	failNewsletterImageCapture,
	getNewsletterSettings,
	newsletterContentSchema,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	type CaptureNewsletterScreenshotInput,
	getTemporalClient,
	isTemporalAvailable,
	PROPOSAL_EXPORT_TASK_QUEUE,
} from "@repo/temporal";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import { requireImageReviewableSend, throwImageRefusal } from "./review-images";

/**
 * Screenshots a reviewer asks for while a send is held: "Capture again" on a
 * captured image, or a new capture described in their own words. The query
 * layer sets the row to CAPTURING; this starts the one-image workflow on the
 * export queue, whose worker slots bound how many browsers run at once.
 */

/**
 * The capture activity's schedule-to-close (5 minutes, in
 * `workflows/capture-newsletter-screenshot.ts`) plus 2 minutes, so the
 * workflow outlives a capture that never finished and records it as failed.
 */
const CAPTURE_WORKFLOW_TIMEOUT = "7m";

/** One capture workflow per image: a new one may start once the last closed. */
function captureWorkflowId(imageId: string): string {
	return `newsletter-screenshot-capture-${imageId}`;
}

/**
 * The highlight a capture illustrates, read from the held content, after the
 * same early checks as any image change plus a capture environment. The send
 * froze its environment when it was created; the project's settings must still
 * take screenshots from that same environment, so an admin who turned
 * screenshots off or moved them elsewhere since is not overruled.
 */
export async function requireCapturableHighlight(
	projectId: string,
	sendId: string,
	highlightIndex: number,
): Promise<CaptureNewsletterScreenshotInput["highlight"]> {
	const send = await requireImageReviewableSend(projectId, sendId);
	if (!send.screenshotEnvironmentId) {
		throwImageRefusal({ reason: "NO_CAPTURE_ENVIRONMENT" });
	}
	const settings = await getNewsletterSettings(projectId);
	if (
		!settings.screenshotsEnabled ||
		settings.screenshotEnvironmentId !== send.screenshotEnvironmentId
	) {
		throwImageRefusal({ reason: "NO_CAPTURE_ENVIRONMENT" });
	}
	const content = newsletterContentSchema.safeParse(send.content);
	const highlight = content.success
		? content.data.highlights[highlightIndex]
		: undefined;
	if (!highlight) {
		throwImageRefusal({ reason: "HIGHLIGHT_OUT_OF_RANGE" });
	}
	return { title: highlight.title, description: highlight.description };
}

/** Refuse before any row changes when no worker can take the capture. */
export async function requireCaptureWorker(): Promise<void> {
	if (!(await isTemporalAvailable())) {
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message:
				"Screenshots cannot be captured right now. Try again shortly.",
		});
	}
}

/**
 * Start the capture of a CAPTURING image. When the start fails the image is
 * failed with a reason, so the review does not wait on it, and the caller
 * gets an error.
 */
export async function startScreenshotCapture(
	input: CaptureNewsletterScreenshotInput,
): Promise<void> {
	try {
		const client = await getTemporalClient();
		await client.workflow.start(
			"captureNewsletterScreenshotWorkflow",
			withCorrelationMemo({
				taskQueue: PROPOSAL_EXPORT_TASK_QUEUE,
				workflowId: captureWorkflowId(input.imageId),
				workflowIdReusePolicy: "ALLOW_DUPLICATE",
				args: [input],
				workflowExecutionTimeout: CAPTURE_WORKFLOW_TIMEOUT,
			}),
		);
	} catch (error) {
		logger.warn("[Newsletter] screenshot capture not started", {
			imageId: input.imageId,
			error: error instanceof Error ? error.name : "unknown",
		});
		try {
			await failNewsletterImageCapture({
				imageId: input.imageId,
				reason: "The capture could not be started.",
			});
		} catch {
			// The row stays CAPTURING; the error below still tells the reviewer.
		}
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "The screenshot capture could not be started.",
		});
	}
}

/**
 * Stop the capture of an image that was removed while it was being captured.
 * Best-effort: the generating workflow's own captures have no workflow of
 * their own, and a capture that already closed has nothing to stop.
 */
export async function cancelScreenshotCapture(imageId: string): Promise<void> {
	try {
		const client = await getTemporalClient();
		await client.workflow.getHandle(captureWorkflowId(imageId)).cancel();
	} catch (error) {
		logger.info("[Newsletter] screenshot capture not cancelled", {
			imageId,
			error: error instanceof Error ? error.name : "unknown",
		});
	}
}
