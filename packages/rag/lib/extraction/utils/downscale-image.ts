import sharp from "sharp";

/**
 * Anthropic rejects base64 images over 5MB. OpenAI/Gemini allow ~20MB,
 * so we downscale to the lowest common denominator before any vision call
 * to stay provider-agnostic.
 */
export const VISION_MAX_BYTES = 5 * 1024 * 1024;

const TARGET_LONG_EDGE = 1568;
const INITIAL_QUALITY = 85;
const MIN_QUALITY = 60;
const QUALITY_STEP = 10;

export interface DownscaleResult {
	buffer: Buffer;
	mimeType: string;
	downscaled: boolean;
	originalBytes: number;
	finalBytes: number;
}

export async function downscaleForVision(
	buffer: Buffer,
	mimeType: string,
): Promise<DownscaleResult> {
	const originalBytes = buffer.length;

	if (originalBytes <= VISION_MAX_BYTES) {
		return {
			buffer,
			mimeType,
			downscaled: false,
			originalBytes,
			finalBytes: originalBytes,
		};
	}

	const pipeline = sharp(buffer).resize({
		width: TARGET_LONG_EDGE,
		height: TARGET_LONG_EDGE,
		fit: "inside",
		withoutEnlargement: true,
	});

	let quality = INITIAL_QUALITY;
	let encoded = await pipeline.clone().jpeg({ quality }).toBuffer();

	while (encoded.length > VISION_MAX_BYTES && quality > MIN_QUALITY) {
		quality -= QUALITY_STEP;
		encoded = await pipeline.clone().jpeg({ quality }).toBuffer();
	}

	return {
		buffer: encoded,
		mimeType: "image/jpeg",
		downscaled: true,
		originalBytes,
		finalBytes: encoded.length,
	};
}
