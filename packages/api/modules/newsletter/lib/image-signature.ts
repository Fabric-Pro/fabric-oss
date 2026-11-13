import type { NewsletterImageContentType } from "./review-images";

type Signatures = Record<NewsletterImageContentType, readonly number[]>;

/** The leading bytes every file of each accepted type starts with. */
const IMAGE_SIGNATURES: Signatures = {
	"image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
	"image/jpeg": [0xff, 0xd8, 0xff],
};

/**
 * Whether `bytes` start with the signature of `contentType`. The type an
 * upload declares is only a label the browser chose; this is what the file
 * actually is.
 */
export function hasImageSignature(
	bytes: Uint8Array,
	contentType: NewsletterImageContentType,
): boolean {
	const signature = IMAGE_SIGNATURES[contentType];
	return (
		bytes.length >= signature.length &&
		signature.every((byte, index) => bytes[index] === byte)
	);
}
