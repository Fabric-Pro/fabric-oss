/**
 * One release-notes screenshot a reviewer asked for, by "Capture again" or by
 * describing a screen. Started on the export queue by the review procedures
 * after they set the image row to CAPTURING. The activity records its own
 * outcome; a capture that never finishes is failed here so the review stops
 * waiting on it.
 */
import type { CaptureNewsletterScreenshotInput } from "../activities/newsletter";
import {
	CAPTURE_START_TO_CLOSE_MS,
	captureActivity,
	failCapture,
} from "./newsletter-screenshots";

/** The capture plus time for the worker to pick it up. */
const CAPTURE_SCHEDULE_TO_CLOSE_MS = CAPTURE_START_TO_CLOSE_MS + 60_000;

export async function captureNewsletterScreenshotWorkflow(
	input: CaptureNewsletterScreenshotInput,
): Promise<void> {
	try {
		await captureActivity(CAPTURE_SCHEDULE_TO_CLOSE_MS)(input);
	} catch (error) {
		await failCapture(
			input.imageId,
			"The capture did not finish in time.",
			error,
		);
	}
}
