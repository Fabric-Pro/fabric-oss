import { rgbToHex } from "@repo/utils/brand-colors";
import sharp, { type Metadata, type SharpOptions } from "sharp";

/**
 * Turn untrusted logo bytes — fetched from a website or uploaded by an
 * editor — into a small PNG, or refuse them with a fixed code.
 *
 * Defense in depth, cheapest check first:
 *   1. a byte cap;
 *   2. a magic-byte check, so only PNG, JPEG, GIF and WebP reach the decoder
 *      whatever the declared content type said (SVG and ICO never do);
 *   3. a header-only dimension check, so an image declaring huge dimensions
 *      is refused before any pixel is decoded;
 *   4. the decode itself, with sharp's input pixel limit, fail-on-error, and
 *      the first frame only.
 * The output is re-encoded, which drops metadata and anything appended to
 * the image data.
 */

export const LOGO_MAX_INPUT_BYTES = 5 * 1024 * 1024;
const LOGO_MAX_INPUT_PIXELS = 4096 * 4096;
export const LOGO_MAX_OUTPUT_EDGE = 512;

/** Edge of the thumbnail the dominant colour is measured on. */
const DOMINANT_SAMPLE_EDGE = 64;

export type LogoFormat = "png" | "jpeg" | "gif" | "webp";

export type NormalizeLogoFailureCode = "too_large" | "unsupported";

export type NormalizeLogoResult =
	| {
			ok: true;
			png: Buffer;
			width: number;
			height: number;
			/** The logo's dominant opaque, non-white colour as `#rrggbb`. */
			dominantColor: string | null;
	  }
	| { ok: false; code: NormalizeLogoFailureCode };

const INPUT_OPTIONS = {
	limitInputPixels: LOGO_MAX_INPUT_PIXELS,
	failOn: "error",
	pages: 1,
	page: 0,
	animated: false,
	autoOrient: true,
} satisfies SharpOptions;

/** Identify a raster logo format from its leading bytes. */
export function sniffLogoFormat(bytes: Uint8Array): LogoFormat | null {
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

function isPixelLimitError(error: unknown): boolean {
	return error instanceof Error && /pixel limit/i.test(error.message);
}

/**
 * The most common opaque colour, ignoring near-white so a logo on a white
 * card does not report white. Deterministic: 4 bits per channel, ties go to
 * the lower bin, and the answer is the mean of the winning bin.
 */
async function dominantColorOf(png: Buffer): Promise<string | null> {
	const { data, info } = await sharp(png)
		.resize({
			width: DOMINANT_SAMPLE_EDGE,
			height: DOMINANT_SAMPLE_EDGE,
			fit: "inside",
			withoutEnlargement: true,
		})
		.toColourspace("srgb")
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const channels = info.channels;
	if (channels !== 4) {
		return null;
	}
	const counts = new Uint32Array(4096);
	const sums = new Float64Array(4096 * 3);
	for (let offset = 0; offset + 3 < data.length; offset += channels) {
		const r = data[offset];
		const g = data[offset + 1];
		const b = data[offset + 2];
		if (data[offset + 3] < 128 || (r > 235 && g > 235 && b > 235)) {
			continue;
		}
		const bin = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
		counts[bin] += 1;
		sums[bin * 3] += r;
		sums[bin * 3 + 1] += g;
		sums[bin * 3 + 2] += b;
	}
	let best = -1;
	let bestCount = 0;
	for (let bin = 0; bin < counts.length; bin++) {
		if (counts[bin] > bestCount) {
			best = bin;
			bestCount = counts[bin];
		}
	}
	if (best === -1) {
		return null;
	}
	return rgbToHex(
		sums[best * 3] / bestCount,
		sums[best * 3 + 1] / bestCount,
		sums[best * 3 + 2] / bestCount,
	);
}

export async function normalizeLogo(
	input: Uint8Array,
): Promise<NormalizeLogoResult> {
	if (input.byteLength > LOGO_MAX_INPUT_BYTES) {
		return { ok: false, code: "too_large" };
	}
	const format = sniffLogoFormat(input);
	if (!format) {
		return { ok: false, code: "unsupported" };
	}
	const buffer = Buffer.from(
		input.buffer,
		input.byteOffset,
		input.byteLength,
	);

	// Header only: no pixel is decoded, so the pixel limit is applied here by
	// hand and a huge declared size fails fast with its own code.
	let metadata: Metadata;
	try {
		metadata = await sharp(buffer, {
			...INPUT_OPTIONS,
			limitInputPixels: false,
		}).metadata();
	} catch {
		return { ok: false, code: "unsupported" };
	}
	if (metadata.format !== format || !metadata.width || !metadata.height) {
		return { ok: false, code: "unsupported" };
	}
	if (metadata.width * metadata.height > LOGO_MAX_INPUT_PIXELS) {
		return { ok: false, code: "too_large" };
	}

	try {
		const { data, info } = await sharp(buffer, INPUT_OPTIONS)
			.resize({
				width: LOGO_MAX_OUTPUT_EDGE,
				height: LOGO_MAX_OUTPUT_EDGE,
				fit: "inside",
				withoutEnlargement: true,
			})
			.png()
			.toBuffer({ resolveWithObject: true });
		return {
			ok: true,
			png: data,
			width: info.width,
			height: info.height,
			dominantColor: await dominantColorOf(data),
		};
	} catch (error) {
		return {
			ok: false,
			code: isPixelLimitError(error) ? "too_large" : "unsupported",
		};
	}
}
