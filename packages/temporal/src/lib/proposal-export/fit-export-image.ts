/**
 * An export image re-encoded small enough to print (Fizzy #2946): every
 * raster that reaches the print page, the document's uploads, the logos and
 * the hero, is inlined there as a `data:` URL, which Chromium draws only up
 * to 2 MiB. An image over the encoded cap at its own edge is made again at
 * the next smaller edge, until it fits or no edge is left.
 *
 * Its own module so a test that replaces `normalizeExportImage` sees every
 * edge this tries.
 */

import {
	type NormalizeExportImageOptions,
	type NormalizeExportImageResult,
	normalizeExportImage,
} from "./normalize-image";
import { PROPOSAL_EXPORT_LIMITS } from "./types";

/** The longest edges an image is tried at, largest first. */
const PRINTABLE_EDGES = [
	PROPOSAL_EXPORT_LIMITS.maxImageEdge,
	1800,
	1200,
	900,
] as const;

export interface FitExportImageOptions extends NormalizeExportImageOptions {
	/** Most bytes the re-encoded image may take. Defaults to the export's cap. */
	maxEncodedBytes?: number;
}

/**
 * The image re-encoded at the largest edge, up to `maxEdge`, whose bytes
 * fit `maxEncodedBytes`, or `too_large` when none does. An edge the last
 * result already fits within is skipped: the normalizer never enlarges, so
 * it would only make the same image again. A refusal is returned as it is.
 */
export async function fitExportImage(
	bytes: Buffer,
	options: FitExportImageOptions = {},
): Promise<NormalizeExportImageResult> {
	const { maxEncodedBytes, ...normalize } = options;
	const cap = maxEncodedBytes ?? PROPOSAL_EXPORT_LIMITS.maxEncodedImageBytes;
	const maxEdge = normalize.maxEdge ?? PROPOSAL_EXPORT_LIMITS.maxImageEdge;
	const edges = [
		maxEdge,
		...PRINTABLE_EDGES.filter((edge) => edge < maxEdge),
	];
	let previousEdge = Number.POSITIVE_INFINITY;
	for (const edge of edges) {
		if (previousEdge <= edge) {
			continue;
		}
		const result = await normalizeExportImage(bytes, {
			...normalize,
			maxEdge: edge,
		});
		if (!result.ok) {
			return result;
		}
		previousEdge = Math.max(result.image.width, result.image.height);
		if (result.image.bytes.byteLength <= cap) {
			return result;
		}
	}
	return { ok: false, code: "too_large" };
}
