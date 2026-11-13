/**
 * How a release-notes screenshot is framed and encoded so it stays sharp and
 * readable in the email, whose content column is 456 CSS px wide.
 *
 * The page is laid out at 1024 CSS px, the narrowest desktop layout, and
 * rendered at 2 device pixels per CSS pixel. A whole page then shrinks less
 * than at a wider layout, and every pixel the email shows is a real one on a
 * high-density screen. An element capture is widened to at least 560 CSS px
 * so the email never stretches a small crop.
 */
import sharp from "sharp";

export const CAPTURE_VIEWPORT = { width: 1024, height: 640 } as const;
export const CAPTURE_DEVICE_SCALE_FACTOR = 2;

/** A crop narrower or shorter than this, in CSS px, is widened around it. */
export const MIN_CLIP_WIDTH = 560;
export const MIN_CLIP_HEIGHT = 240;

/** About 2.6 device px per CSS px in the 456 px column. */
const OUTPUT_WIDTH = 1200;
const OUTPUT_MAX_BYTES = 300 * 1024;
const JPEG_QUALITIES = [88, 82, 74, 66, 58, 50] as const;

export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Grow `size` around `start` to `min`, kept inside `0..limit`. */
function widen(
	start: number,
	size: number,
	min: number,
	limit: number,
): [number, number] {
	const length = Math.min(Math.max(size, min), limit);
	const centred = start + size / 2 - length / 2;
	const from = Math.min(Math.max(centred, 0), limit - length);
	return [from, length];
}

/** The part of `box` inside the viewport, or null when none of it is. */
export function visiblePart(
	box: Box,
	viewport: { width: number; height: number } = CAPTURE_VIEWPORT,
): Box | null {
	const x = Math.max(box.x, 0);
	const y = Math.max(box.y, 0);
	const right = Math.min(box.x + box.width, viewport.width);
	const bottom = Math.min(box.y + box.height, viewport.height);
	if (right <= x || bottom <= y) {
		return null;
	}
	return { x, y, width: right - x, height: bottom - y };
}

/**
 * The viewport area to capture for an element at `box`: the element, widened
 * to the minimum size around its centre and kept inside the viewport.
 */
export function frameClip(
	box: Box,
	viewport: { width: number; height: number } = CAPTURE_VIEWPORT,
): Box {
	const [x, width] = widen(box.x, box.width, MIN_CLIP_WIDTH, viewport.width);
	const [y, height] = widen(
		box.y,
		box.height,
		MIN_CLIP_HEIGHT,
		viewport.height,
	);
	return { x, y, width, height };
}

/**
 * A PNG as a JPEG at most 1200 px wide and within the email's size budget.
 * Full-resolution colour (4:4:4) keeps coloured text and thin lines crisp.
 */
export async function encodeNewsletterScreenshot(
	png: Buffer,
): Promise<{ data: Buffer; width: number; height: number } | null> {
	for (const quality of JPEG_QUALITIES) {
		const { data, info } = await sharp(png)
			.resize({ width: OUTPUT_WIDTH, withoutEnlargement: true })
			.flatten({ background: "#ffffff" })
			.jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:4:4" })
			.toBuffer({ resolveWithObject: true });
		if (data.length <= OUTPUT_MAX_BYTES) {
			return { data, width: info.width, height: info.height };
		}
	}
	return null;
}
