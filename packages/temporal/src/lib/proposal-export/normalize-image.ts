/**
 * Untrusted stored image bytes into a raster both export writers can place
 * (Fizzy #2946), or a refusal with a fixed code.
 *
 * The bytes are whatever an editor uploaded, or a brand logo someone stored,
 * and print hands them to a Chromium that runs without its sandbox, so
 * nothing reaches a page as it was stored. Defence in depth, cheapest check
 * first, on the pattern of the website logo reader
 * (`@repo/integrations/website-brand/normalize-logo`):
 *
 *   1. a byte cap;
 *   2. a magic-byte check, so only PNG, JPEG, GIF and WebP reach the decoder
 *      whatever the stored content type says (SVG, ICO and anything else
 *      never do);
 *   3. a header-only dimension check, so an image declaring huge dimensions
 *      is refused before any pixel is decoded;
 *   4. the decode itself, with sharp's input pixel limit, fail-on-error and
 *      the first frame only.
 *
 * The output is always re-encoded: PNG when the image has an alpha channel,
 * JPEG otherwise, in sRGB, oriented as its EXIF tag said and then without
 * any metadata or anything appended to the image data.
 *
 * Generic on purpose: the document's uploaded images and the cover's brand
 * logos both come through here, with different edge limits.
 */

import sharp, { type Metadata, type SharpOptions } from "sharp";
import { type ExportRaster, PROPOSAL_EXPORT_LIMITS } from "./types";

/** The raster formats the decoder is ever handed. */
type ExportImageFormat = "png" | "jpeg" | "gif" | "webp";

export type NormalizeExportImageFailureCode = "too_large" | "unsupported";

export type NormalizeExportImageResult =
	| { ok: true; image: ExportRaster }
	| { ok: false; code: NormalizeExportImageFailureCode };

export interface NormalizeExportImageOptions {
	/** Largest input, in bytes. Defaults to one export image's cap. */
	maxBytes?: number;
	/** Longest output edge, in pixels. Defaults to one export image's edge. */
	maxEdge?: number;
	/** Most pixels the header may declare. Defaults to the export's limit. */
	maxPixels?: number;
}

/** JPEG quality of a re-encoded photo: indistinguishable in print. */
const JPEG_QUALITY = 85;

/** The leading bytes of each format the decoder accepts. */
export function sniffExportImageFormat(
	bytes: Uint8Array,
): ExportImageFormat | null {
	if (bytes.length < 12) {
		return null;
	}
	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "png";
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return "jpeg";
	}
	const ascii = (start: number, end: number) =>
		String.fromCharCode(...bytes.subarray(start, end));
	if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") {
		return "gif";
	}
	if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
		return "webp";
	}
	return null;
}

function inputOptions(maxPixels: number): SharpOptions {
	return {
		limitInputPixels: maxPixels,
		failOn: "error",
		// The first frame of an animation only.
		pages: 1,
		page: 0,
		animated: false,
		// Applied before the metadata is dropped, so the image keeps the
		// orientation the reader saw on the page.
		autoOrient: true,
	};
}

function isPixelLimitError(error: unknown): boolean {
	return error instanceof Error && /pixel limit/i.test(error.message);
}

/**
 * Untrusted image bytes as an {@link ExportRaster}, or `too_large` (bytes,
 * declared pixels) or `unsupported` (any other format, a header that does not
 * match the sniffed format, a decode error).
 */
export async function normalizeExportImage(
	bytes: Buffer,
	options: NormalizeExportImageOptions = {},
): Promise<NormalizeExportImageResult> {
	const maxBytes = options.maxBytes ?? PROPOSAL_EXPORT_LIMITS.maxImageBytes;
	const maxEdge = options.maxEdge ?? PROPOSAL_EXPORT_LIMITS.maxImageEdge;
	const maxPixels =
		options.maxPixels ?? PROPOSAL_EXPORT_LIMITS.maxImagePixels;

	if (bytes.byteLength > maxBytes) {
		return { ok: false, code: "too_large" };
	}
	const format = sniffExportImageFormat(bytes);
	if (!format) {
		return { ok: false, code: "unsupported" };
	}

	// Header only: no pixel is decoded, so the pixel limit is applied here by
	// hand and a huge declared size fails fast with its own code.
	let metadata: Metadata;
	try {
		metadata = await sharp(bytes, {
			...inputOptions(maxPixels),
			limitInputPixels: false,
		}).metadata();
	} catch {
		return { ok: false, code: "unsupported" };
	}
	if (metadata.format !== format || !metadata.width || !metadata.height) {
		return { ok: false, code: "unsupported" };
	}
	if (metadata.width * metadata.height > maxPixels) {
		return { ok: false, code: "too_large" };
	}

	try {
		const pipeline = sharp(bytes, inputOptions(maxPixels))
			.resize({
				width: maxEdge,
				height: maxEdge,
				fit: "inside",
				withoutEnlargement: true,
			})
			// CMYK and 16-bit inputs come out as 8-bit sRGB, which both
			// Chromium and Word place as they are.
			.toColourspace("srgb");
		const transparent = metadata.hasAlpha === true;
		const { data, info } = await (transparent
			? pipeline.png()
			: pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: false })
		).toBuffer({ resolveWithObject: true });
		return {
			ok: true,
			image: {
				mimeType: transparent ? "image/png" : "image/jpeg",
				bytes: data,
				width: info.width,
				height: info.height,
			},
		};
	} catch (error) {
		return {
			ok: false,
			code: isPixelLimitError(error) ? "too_large" : "unsupported",
		};
	}
}
