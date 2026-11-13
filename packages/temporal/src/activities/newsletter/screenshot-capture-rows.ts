/**
 * The database side of a send's automatic screenshots, as the generating
 * workflow drives it: create the CAPTURING rows, fail a capture whose activity
 * never ran, and, for a send that goes out without review, publish the
 * captures and write them into the content about to be delivered.
 */
import {
	createNewsletterCaptureRows,
	embedCapturedNewsletterImages,
	failNewsletterImageCapture,
	listNewsletterSendImages,
	NEWSLETTER_AUTO_CAPTURES_MAX,
	NEWSLETTER_CAPTURE_BRIEF_MAX,
	type NewsletterContent,
} from "@repo/database";
import {
	deleteNewsletterImageObjects,
	publishNewsletterImages,
} from "@repo/database/prisma/queries/projects/newsletter-image-publish";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";

/**
 * The highlights to capture: visible changes with a brief, in order, capped.
 * `skipped` counts the visible changes past the cap.
 */
export function screenshotCaptures(content: NewsletterContent): {
	captures: Array<{ highlightIndex: number; prompt: string }>;
	skipped: number;
} {
	const captures: Array<{ highlightIndex: number; prompt: string }> = [];
	for (const [highlightIndex, highlight] of content.highlights.entries()) {
		const brief = highlight.captureBrief?.trim();
		if (highlight.visualChange === true && brief) {
			captures.push({
				highlightIndex,
				prompt: brief.slice(0, NEWSLETTER_CAPTURE_BRIEF_MAX),
			});
		}
	}
	return {
		captures: captures.slice(0, NEWSLETTER_AUTO_CAPTURES_MAX),
		skipped: Math.max(0, captures.length - NEWSLETTER_AUTO_CAPTURES_MAX),
	};
}

/**
 * One CAPTURING row per highlight curation marked as a visible change; none
 * when there is nothing to capture or the send has left PENDING.
 */
export async function createNewsletterCaptureRowsActivity(input: {
	sendId: string;
	projectId: string;
	content: NewsletterContent;
	/** True when the send goes out without review. */
	included: boolean;
	createdByUserId: string;
}): Promise<Array<{ id: string; highlightIndex: number }>> {
	heartbeat("createNewsletterCaptureRows");
	const { captures, skipped } = screenshotCaptures(input.content);
	if (skipped > 0) {
		logger.warn("[Newsletter] visible changes left without a screenshot", {
			sendId: input.sendId,
			skipped,
			cap: NEWSLETTER_AUTO_CAPTURES_MAX,
		});
	}
	if (captures.length === 0) {
		return [];
	}
	return createNewsletterCaptureRows({
		projectId: input.projectId,
		sendId: input.sendId,
		captures,
		included: input.included,
		createdByUserId: input.createdByUserId,
	});
}

/** Fail a capture with a reason; a row no longer CAPTURING is left alone. */
export async function failNewsletterScreenshotCaptureActivity(input: {
	imageId: string;
	reason: string;
}): Promise<void> {
	heartbeat("failNewsletterScreenshotCapture");
	await failNewsletterImageCapture(input);
}

/**
 * The review-off path: copy every included, READY capture to its public key
 * and return the content with the images under their highlights. A copy that
 * fails is skipped, so the send goes out without that image.
 */
export async function publishNewsletterScreenshotsActivity(input: {
	sendId: string;
	projectId: string;
	content: NewsletterContent;
}): Promise<NewsletterContent> {
	heartbeat("publishNewsletterScreenshots");
	const images = await listNewsletterSendImages(
		input.projectId,
		input.sendId,
	);
	const published = await publishNewsletterImages({
		sendId: input.sendId,
		images,
		removedHighlightIndexes: [],
		highlightCount: input.content.highlights.length,
		afterEachCopy: () => heartbeat("publishNewsletterScreenshots"),
	});
	if (published.length === 0) {
		return input.content;
	}
	const { content, embedded } = await embedCapturedNewsletterImages({
		sendId: input.sendId,
		content: input.content,
		published,
	});
	const kept = new Set(embedded);
	await deleteNewsletterImageObjects(
		published.filter((p) => !kept.has(p.imageId)).map((p) => p.publicKey),
	);
	return content;
}
