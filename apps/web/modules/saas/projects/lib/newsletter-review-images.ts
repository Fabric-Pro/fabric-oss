/**
 * Client-side rules for the images a reviewer attaches to a held release-notes
 * send. The server enforces the same limits; these only let the review panel
 * shrink an image and explain a refusal before a round trip.
 */

/** Mirrors the server's 300 KB ceiling (`review-images.ts`, server-only). */
export const NEWSLETTER_IMAGE_UPLOAD_MAX_BYTES = 300 * 1024;

/** Wider than the email's content column at 2x, so nothing is upscaled. */
export const NEWSLETTER_IMAGE_MAX_WIDTH = 1200;

export const NEWSLETTER_IMAGE_ACCEPT = "image/png,image/jpeg";

interface ReviewImageLike {
	highlightIndex: number;
	captureState: string;
	included: boolean;
	url: string | null;
}

/**
 * How many images could go out, and how many will. Only an image that is
 * READY, can be shown (has a url) and sits under a highlight the reviewer kept
 * counts; `included` is the subset the reviewer left ticked.
 */
export function summarizeReviewImages(
	images: readonly ReviewImageLike[],
	removedIndexes: ReadonlySet<number>,
): { available: number; included: number } {
	let available = 0;
	let included = 0;
	for (const image of images) {
		if (
			image.captureState !== "READY" ||
			!image.url ||
			removedIndexes.has(image.highlightIndex)
		) {
			continue;
		}
		available += 1;
		if (image.included) {
			included += 1;
		}
	}
	return { available, included };
}

/** The approve button says what will happen. */
export function approveButtonLabel(includedImages: number): string {
	if (includedImages === 0) {
		return "Approve & send as text";
	}
	return includedImages === 1
		? "Approve & send with 1 image"
		: `Approve & send with ${includedImages} images`;
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** "4 highlights · 2 images": what goes out if approved now. */
export function reviewSummaryLine(
	keptHighlights: number,
	includedImages: number,
): string {
	return `${plural(keptHighlights, "highlight", "highlights")} · ${plural(includedImages, "image", "images")}`;
}

/** "3 of 4 images included", or null when there is nothing to include. */
export function includedImagesLine(summary: {
	available: number;
	included: number;
}): string | null {
	if (summary.available === 0) {
		return null;
	}
	return `${summary.included} of ${plural(summary.available, "image", "images")} included`;
}

/** The images under each highlight index, in the server's position order. */
export function imagesByHighlight<T extends { highlightIndex: number }>(
	images: readonly T[],
): Map<number, T[]> {
	const byHighlight = new Map<number, T[]>();
	for (const image of images) {
		const list = byHighlight.get(image.highlightIndex);
		if (list) {
			list.push(image);
		} else {
			byHighlight.set(image.highlightIndex, [image]);
		}
	}
	return byHighlight;
}
