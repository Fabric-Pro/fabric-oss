/**
 * The uploaded images a Proposal export carries (Fizzy #2946): found in the
 * prepared Main, read from storage by key, and re-encoded, so both writers
 * place bytes that were checked here and never load anything themselves.
 *
 * An uploaded image is the one raw HTML form the export reads (see
 * `document-content.ts`). Only keys under this document's own media prefix
 * are read at all; a key anywhere else is dropped without a read, so a
 * crafted tag cannot pull another document's or another tenant's object
 * into the PDF.
 *
 * Every read is bounded: at most `maxImages` distinct images, each at most
 * `maxImageBytes` as stored, and all of them together within one byte budget
 * the caller also charges the brand logos against. Each is re-encoded at
 * most `maxEncodedImageBytes`, stepping its edge down until it fits, so the
 * print page can inline it. Reads run one at a time,
 * in document order, so which image a full budget leaves out never depends
 * on timing. Anything that goes wrong drops that one image and is counted in
 * a warning; the warnings carry counts only, never a key or any content.
 *
 * Heartbeating is the caller's: `onImage` runs after each image settles.
 */

import { config } from "@repo/config";
import type { Root } from "mdast";
import {
	isDocumentMediaKey,
	namesStoredObject,
	readUploadedImageTag,
} from "./document-content";
import { fitExportImage } from "./fit-export-image";
import { eachNode } from "./markdown";
import { readStoredObjectWithin } from "./read-stored-object";
import {
	type ExportRaster,
	PROPOSAL_EXPORT_LIMITS,
	type ProposalExportWarning,
} from "./types";
import { ExportWarningTally } from "./warnings";

/** Reads one stored object's bytes by key; throws when it cannot. */
export type ExportImageReader = (key: string) => Promise<Buffer>;

/**
 * The stored bytes one export may still read, shared between the document's
 * images and the cover's logos.
 */
export interface ExportImageBudget {
	/** Bytes left. */
	readonly remainingBytes: number;
	/**
	 * Charge `bytes` and return true, or return false and charge nothing
	 * when they do not fit.
	 */
	charge(bytes: number): boolean;
}

/** A fresh budget of `totalBytes`, by default the export's whole budget. */
export function createExportImageBudget(
	totalBytes: number = PROPOSAL_EXPORT_LIMITS.maxTotalImageBytes,
): ExportImageBudget {
	let remaining = totalBytes;
	return {
		get remainingBytes() {
			return remaining;
		},
		charge(bytes) {
			if (!Number.isFinite(bytes) || bytes < 0 || bytes > remaining) {
				return false;
			}
			remaining -= bytes;
			return true;
		},
	};
}

/**
 * Reads from the bucket Main's uploads are stored in, abandoning the read
 * as soon as the object passes the per-image cap.
 */
export const readStoredExportImage: ExportImageReader = (key) =>
	readStoredObjectWithin(
		{ bucket: config.storage.bucketNames.projectContexts, key },
		PROPOSAL_EXPORT_LIMITS.maxImageBytes,
	);

export interface ExtractDocumentImagesInput {
	/** The prepared Main (`prepareExportMarkdown(...).root`). */
	root: Root;
	projectId: string;
	documentId: string;
	/** Defaults to {@link readStoredExportImage}. */
	read?: ExportImageReader;
	/** Defaults to a fresh budget of the export's whole allowance. */
	budget?: ExportImageBudget;
	/** Defaults to the export's limits; tests pass smaller ones. */
	limits?: {
		maxImages?: number;
		maxImageBytes?: number;
		maxEncodedImageBytes?: number;
	};
	/** Runs after each image settles, read or dropped: the heartbeat hook. */
	onImage?: () => void;
}

export interface ExtractedDocumentImages {
	/** Each carried image by its storage key. */
	images: Map<string, ExportRaster>;
	warnings: ProposalExportWarning[];
}

/**
 * Every uploaded image key Main places, in document order, each once. Only
 * `html` nodes the uploaded-image reader accepts count; Markdown image
 * syntax is never read.
 */
export function uploadedImageKeys(root: Root): string[] {
	return scanUploadedImages(root).keys;
}

/**
 * The uploaded image keys, and how many image tags name a stored object but
 * are refused (a key written twice, a malformed tag): both writers leave
 * those out, so they are reported as dropped.
 */
function scanUploadedImages(root: Root): { keys: string[]; refused: number } {
	const keys = new Set<string>();
	let refused = 0;
	eachNode(root, (node) => {
		if (node.type !== "html") {
			return;
		}
		const tag = readUploadedImageTag(node.value);
		if (tag) {
			keys.add(tag.key);
		} else if (
			/^\s*<img\s/i.test(node.value) &&
			namesStoredObject(node.value)
		) {
			refused++;
		}
	});
	return { keys: [...keys], refused };
}

/**
 * Read, check and re-encode the document's uploaded images. A key outside
 * this document's media prefix, a missing or unreadable object, bytes over
 * the per-image cap or the shared budget, and bytes the normalizer refuses
 * each drop that image with `IMAGE_DROPPED`, as does one still over the
 * encoded cap at the smallest edge; distinct images beyond
 * `maxImages` are left out with `IMAGE_LIMIT`.
 */
export async function extractDocumentImages(
	input: ExtractDocumentImagesInput,
): Promise<ExtractedDocumentImages> {
	const read = input.read ?? readStoredExportImage;
	const budget = input.budget ?? createExportImageBudget();
	const maxImages =
		input.limits?.maxImages ?? PROPOSAL_EXPORT_LIMITS.maxImages;
	const caps = {
		maxBytes:
			input.limits?.maxImageBytes ?? PROPOSAL_EXPORT_LIMITS.maxImageBytes,
		maxEncodedBytes:
			input.limits?.maxEncodedImageBytes ??
			PROPOSAL_EXPORT_LIMITS.maxEncodedImageBytes,
	};

	const tally = new ExportWarningTally();

	const scanned = scanUploadedImages(input.root);
	tally.add("IMAGE_DROPPED", scanned.refused);
	const owned: string[] = [];
	for (const key of scanned.keys) {
		if (isDocumentMediaKey(key, input.projectId, input.documentId)) {
			owned.push(key);
		} else {
			tally.add("IMAGE_DROPPED");
		}
	}
	const carried = owned.slice(0, Math.max(0, maxImages));
	tally.add("IMAGE_LIMIT", owned.length - carried.length);

	const images = new Map<string, ExportRaster>();
	for (const key of carried) {
		const image = await readOne(key, read, budget, caps);
		if (image) {
			images.set(key, image);
		} else {
			tally.add("IMAGE_DROPPED");
		}
		input.onImage?.();
	}

	return {
		images,
		warnings: tally.warnings(),
	};
}

async function readOne(
	key: string,
	read: ExportImageReader,
	budget: ExportImageBudget,
	caps: { maxBytes: number; maxEncodedBytes: number },
): Promise<ExportRaster | null> {
	let bytes: Buffer;
	try {
		bytes = await read(key);
	} catch {
		return null;
	}
	// An object over the per-image cap is never decoded, so it is not
	// charged against what the rest of the export may read.
	if (bytes.byteLength > caps.maxBytes || !budget.charge(bytes.byteLength)) {
		return null;
	}
	const normalized = await fitExportImage(bytes, caps);
	return normalized.ok ? normalized.image : null;
}
