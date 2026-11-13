import { compressImage } from "./image-upload-utils";
import {
	NEWSLETTER_IMAGE_MAX_WIDTH,
	NEWSLETTER_IMAGE_UPLOAD_MAX_BYTES,
} from "./newsletter-review-images";

type NewsletterImageContentType = "image/png" | "image/jpeg";

type PreparedNewsletterImage =
	| {
			ok: true;
			file: File;
			contentType: NewsletterImageContentType;
			width: number;
			height: number;
	  }
	| { ok: false; code: "unsupported" | "too_large" };

/** JPEG qualities tried, least destructive first, once a PNG cannot fit. */
const JPEG_QUALITY_LADDER = [0.85, 0.75, 0.65, 0.55] as const;

function contentTypeOf(file: File): NewsletterImageContentType | null {
	if (file.type === "image/png" || file.type === "image/jpeg") {
		return file.type;
	}
	return null;
}

function readImageSize(file: File): Promise<{ width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		const url = URL.createObjectURL(file);
		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve({ width: img.naturalWidth, height: img.naturalHeight });
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("Failed to read the image"));
		};
		img.src = url;
	});
}

/**
 * `compressImage` caps the LONGEST side; the email caps the width. This is the
 * longest-side cap that leaves the width at `maxWidth`, so a tall screenshot is
 * not shrunk to a sliver.
 */
function longestSideForWidth(
	size: { width: number; height: number },
	maxWidth: number,
): number {
	const target = Math.min(size.width, maxWidth);
	return size.width >= size.height
		? target
		: Math.round(size.height * (target / size.width));
}

/**
 * The byte limit is the only acceptance rule. Width is a downscale target, not
 * a limit: `compressImage` hands back its input whenever re-encoding does not
 * make it smaller, so a wide but light image must be accepted as it is.
 */
function fits(file: File): boolean {
	return file.size <= NEWSLETTER_IMAGE_UPLOAD_MAX_BYTES;
}

async function finish(file: File): Promise<PreparedNewsletterImage> {
	const contentType = contentTypeOf(file);
	if (!contentType) {
		return { ok: false, code: "unsupported" };
	}
	if (!fits(file)) {
		return { ok: false, code: "too_large" };
	}
	const size = await readImageSize(file);
	return { ok: true, file, contentType, ...size };
}

/**
 * Fit a picked file to what the newsletter accepts: PNG or JPEG of at most
 * 300 KB. A file within the limit is used unchanged. A heavier one is scaled
 * down to 1200 px wide: a PNG stays a PNG when that is enough, otherwise it is
 * re-encoded as JPEG at falling quality until it fits.
 * Never throws: an image the browser cannot decode is reported unsupported.
 */
export async function prepareNewsletterImage(
	file: File,
): Promise<PreparedNewsletterImage> {
	const contentType = contentTypeOf(file);
	if (!contentType) {
		return { ok: false, code: "unsupported" };
	}
	try {
		const size = await readImageSize(file);
		if (fits(file)) {
			return { ok: true, file, contentType, ...size };
		}
		const maxDimension = longestSideForWidth(
			size,
			NEWSLETTER_IMAGE_MAX_WIDTH,
		);
		if (contentType === "image/png") {
			const png = await compressImage(file, {
				maxDimension,
				force: true,
			});
			if (fits(png)) {
				return finish(png);
			}
		}
		let smallest = file;
		for (const quality of JPEG_QUALITY_LADDER) {
			const jpeg = await compressImage(file, {
				maxDimension,
				quality,
				force: true,
				type: "image/jpeg",
			});
			if (jpeg.size < smallest.size) {
				smallest = jpeg;
			}
			if (fits(jpeg)) {
				return finish(jpeg);
			}
		}
		return finish(smallest);
	} catch {
		return { ok: false, code: "unsupported" };
	}
}
