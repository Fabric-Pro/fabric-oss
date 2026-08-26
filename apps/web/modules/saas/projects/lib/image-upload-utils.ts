/**
 * Image upload utilities for document editor.
 *
 * Handles validation, client-side compression, S3 upload with progress,
 * and S3 key extraction/resolution from editor content.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { encodedSizeOf } from "./ai-context-budget";

/** Supported image MIME types */
const SUPPORTED_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

/** Maximum file size in bytes (5MB) */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/** Maximum image dimension after compression */
const MAX_IMAGE_DIMENSION = 2000;

/**
 * Ceiling the AI provider enforces on ONE inline image, measured on the
 * BASE64-ENCODED payload rather than the file on disk.
 *
 * This distinction is the whole point. Images reach the model as base64, which
 * costs 4 bytes for every 3, so a file that clears a naive 5 MB check arrives
 * as ~6.7 MB and is refused. Anthropic — which serves every Claude deployment
 * here, directly or behind the Databricks gateway — caps an encoded image at
 * 5 MB.
 */
export const MAX_ENCODED_IMAGE_BYTES = 5 * 1024 * 1024;

// Lives in `ai-context-budget` so the upload hook can measure a payload without
// importing this module, which tests mock wholesale for its canvas/S3 surface.
// Imported (not bare re-exported) because `exceedsProviderImageBudget` below
// calls it: `export { x } from "…"` forwards the name without binding it
// locally, which leaves that call site unresolved.
export { encodedSizeOf };

/** True when this payload would exceed the provider ceiling once encoded. */
export function exceedsProviderImageBudget(rawBytes: number): boolean {
	return encodedSizeOf(rawBytes) > MAX_ENCODED_IMAGE_BYTES;
}

/** Largest raw file that still fits the provider ceiling once encoded (~3.75 MB). */
export const MAX_RAW_IMAGE_BYTES = Math.floor(
	(MAX_ENCODED_IMAGE_BYTES / 4) * 3,
);

/**
 * Dimension/quality steps walked when shrinking an over-budget image. Ordered
 * least-destructive first; the first step that fits wins.
 */
const COMPRESSION_LADDER: ReadonlyArray<readonly [number, number]> = [
	[MAX_IMAGE_DIMENSION, 0.85],
	[1600, 0.75],
	[1200, 0.65],
	[1024, 0.6],
];

/** Human-readable size labels */
function formatFileSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

interface ValidationResult {
	valid: boolean;
	error?: string;
}

/**
 * Validate an image file before upload.
 * Checks MIME type and file size.
 */
export function validateImageFile(file: File): ValidationResult {
	if (!SUPPORTED_MIME_TYPES.has(file.type)) {
		return {
			valid: false,
			error: `Unsupported image type: ${file.type}. Use PNG, JPEG, GIF, or WebP.`,
		};
	}

	if (file.size > MAX_FILE_SIZE) {
		return {
			valid: false,
			error: `File too large (${formatFileSize(file.size)}). Maximum size is ${formatFileSize(MAX_FILE_SIZE)}.`,
		};
	}

	return { valid: true };
}

/**
 * Compress an image using canvas-based downscaling.
 * Reduces dimensions to at most `MAX_IMAGE_DIMENSION` on the longest side
 * (or `options.maxDimension` when provided).
 * Returns the original file if it's already small enough or is a GIF.
 *
 * The `options` arg is per-surface scoping for the AI Feature Assistant,
 * which uses 1024 px / 0.80 (spec 2026-05-19-feature-assistant-images §5.1).
 * All existing callers pass no options and inherit the module-level defaults
 * (2000 px / 0.85), so behaviour is unchanged for the document editor.
 */
export async function compressImage(
	file: File,
	options?: {
		maxDimension?: number;
		quality?: number;
		/**
		 * Re-encode even when the file is small or already within
		 * `maxDimension`. The two short-circuits below are size-blind — they
		 * ask about pixels, never bytes — so a heavy photo that happens to be
		 * under the dimension cap comes back untouched. `compressImageToBudget`
		 * sets this because it is chasing a BYTE target, not a pixel one.
		 */
		force?: boolean;
	},
): Promise<File> {
	const maxDimension = options?.maxDimension ?? MAX_IMAGE_DIMENSION;
	const quality = options?.quality ?? 0.85;
	const force = options?.force ?? false;

	// Don't compress GIFs (they lose animation)
	if (file.type === "image/gif") {
		return file;
	}

	// Don't compress small files
	if (!force && file.size <= MAX_FILE_SIZE / 2) {
		return file;
	}

	return new Promise<File>((resolve, reject) => {
		const img = new Image();
		const url = URL.createObjectURL(file);

		img.onload = () => {
			URL.revokeObjectURL(url);

			const { width, height } = img;

			// If already within limits, return original
			if (!force && width <= maxDimension && height <= maxDimension) {
				resolve(file);
				return;
			}

			// Calculate new dimensions maintaining aspect ratio
			let newWidth = width;
			let newHeight = height;

			if (width > height) {
				newWidth = maxDimension;
				newHeight = Math.round(height * (maxDimension / width));
			} else {
				newHeight = maxDimension;
				newWidth = Math.round(width * (maxDimension / height));
			}

			const canvas = document.createElement("canvas");
			canvas.width = newWidth;
			canvas.height = newHeight;

			const ctx = canvas.getContext("2d");
			if (!ctx) {
				resolve(file);
				return;
			}

			ctx.drawImage(img, 0, 0, newWidth, newHeight);

			canvas.toBlob(
				(blob) => {
					if (!blob) {
						resolve(file);
						return;
					}

					const compressed = new File([blob], file.name, {
						type: file.type,
						lastModified: Date.now(),
					});

					// Only use compressed version if it's actually smaller
					resolve(compressed.size < file.size ? compressed : file);
				},
				file.type,
				quality,
			);
		};

		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error("Failed to load image for compression"));
		};

		img.src = url;
	});
}

/**
 * Shrink an image until its BASE64-ENCODED size fits the provider budget.
 *
 * `compressImage` alone is not enough: every one of its short-circuits is about
 * pixels, so an image already inside `MAX_IMAGE_DIMENSION` comes back untouched
 * regardless of how many bytes it carries. That is how a heavy screenshot
 * reached the model unchanged and had the whole request refused.
 *
 * Walks {@link COMPRESSION_LADDER} least-destructive first and stops at the
 * first step that fits. Returns `withinBudget: false` rather than a silently
 * oversized file, so the caller can say so instead of letting the request fail
 * downstream with a provider error the user cannot act on.
 *
 * GIFs are returned unchanged and reported as over budget when they are: canvas
 * re-encoding would drop the animation, so an oversized GIF is a rejection, not
 * a resize.
 */
export async function compressImageToBudget(
	file: File,
): Promise<{ file: File; withinBudget: boolean }> {
	if (!exceedsProviderImageBudget(file.size)) {
		return { file, withinBudget: true };
	}
	if (file.type === "image/gif") {
		return { file, withinBudget: false };
	}

	let best = file;
	for (const [maxDimension, quality] of COMPRESSION_LADDER) {
		let candidate: File;
		try {
			// Shrink what the previous rung produced, not the original. Decoding
			// a near-cap original four times over is a full-resolution decode +
			// canvas draw per rung, all on the main thread, and every rung after
			// the first only needs the smaller image the last one made.
			candidate = await compressImage(best, {
				maxDimension,
				quality,
				force: true,
			});
		} catch {
			// Undecodable image — hand back the smallest we have and let the
			// caller report it rather than throwing mid-attachment.
			break;
		}
		if (candidate.size < best.size) {
			best = candidate;
		}
		if (!exceedsProviderImageBudget(candidate.size)) {
			return { file: candidate, withinBudget: true };
		}
	}
	return { file: best, withinBudget: false };
}

/**
 * Shrink an image to the provider's encoded-size budget, or explain why it
 * cannot be sent.
 *
 * The app has four AI-chat attachment surfaces and they do NOT share a
 * validation path — the copilot hook, Loom Direct, the Loom orchestrator chat
 * and Nexus each accept files their own way. Each therefore needs this call,
 * and each needs the same wording, so the wording lives here rather than being
 * retyped four times and drifting.
 *
 * Returns the (possibly shrunk) file, or a ready-to-toast reason. Never throws.
 */
export type PreparedImage =
	| { ok: true; file: File }
	| { ok: false; error: string };

export async function prepareImageForAi(file: File): Promise<PreparedImage> {
	const { file: shaped, withinBudget } = await compressImageToBudget(file);
	if (withinBudget) {
		return { ok: true, file: shaped };
	}
	return {
		ok: false,
		error:
			file.type === "image/gif"
				? `"${file.name}" is too large to send to the AI. Shrinking it would lose the animation — try a shorter clip or a still frame.`
				: `"${file.name}" is too detailed to send to the AI, even after shrinking it. Try a smaller crop, or save it as a JPEG first.`,
	};
}

interface GetUploadUrlParams {
	projectId: string;
	documentId: string;
	organizationId: string | null;
	filename: string;
	mimeType: string;
	size: number;
}

interface UploadUrlResult {
	signedUploadUrl: string | null;
	s3Key: string;
	useServerUpload: boolean;
	storageProvider: string;
}

/**
 * Get a signed upload URL from the API.
 */
async function getUploadUrl(
	params: GetUploadUrlParams,
): Promise<UploadUrlResult> {
	return await orpcClient.projects.documents.createMediaUploadUrl(params);
}

interface UploadToS3Params {
	signedUrl: string;
	file: File;
	contentType?: string;
	onProgress?: (percent: number) => void;
}

/**
 * Upload a file to S3 using a pre-signed URL.
 * Uses XMLHttpRequest for progress tracking.
 */
export function uploadToS3({
	signedUrl,
	file,
	contentType,
	onProgress,
}: UploadToS3Params): Promise<void> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();

		xhr.upload.addEventListener("progress", (event) => {
			if (event.lengthComputable && onProgress) {
				const percent = Math.round((event.loaded / event.total) * 100);
				onProgress(percent);
			}
		});

		xhr.addEventListener("load", () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				resolve();
			} else {
				reject(new Error(`Upload failed with status ${xhr.status}`));
			}
		});

		xhr.addEventListener("error", () => {
			reject(new Error("Upload failed due to a network error"));
		});

		xhr.addEventListener("abort", () => {
			reject(new Error("Upload was aborted"));
		});

		xhr.open("PUT", signedUrl);
		xhr.setRequestHeader("Content-Type", contentType ?? file.type);
		xhr.send(file);
	});
}

/** Regex to match data-s3-key attributes in HTML content */
const S3_KEY_REGEX = /data-s3-key="([^"]+)"/g;

/** Regex to match S3 keys in markdown image alt text or attributes */
const S3_KEY_MARKDOWN_REGEX = /document-media\/[^"'\s)]+/g;

/**
 * Extract all S3 keys referenced in editor HTML content.
 */
export function extractS3KeysFromContent(htmlContent: string): string[] {
	const keys = new Set<string>();

	// Extract from data-s3-key attributes
	let match: RegExpExecArray | null = null;
	S3_KEY_REGEX.lastIndex = 0;
	match = S3_KEY_REGEX.exec(htmlContent);
	while (match !== null) {
		keys.add(match[1]);
		match = S3_KEY_REGEX.exec(htmlContent);
	}

	// Also extract from src attributes that look like S3 keys
	S3_KEY_MARKDOWN_REGEX.lastIndex = 0;
	match = S3_KEY_MARKDOWN_REGEX.exec(htmlContent);
	while (match !== null) {
		keys.add(match[0]);
		match = S3_KEY_MARKDOWN_REGEX.exec(htmlContent);
	}

	return Array.from(keys);
}

/**
 * Full upload pipeline: validate -> compress -> get URL -> upload to S3.
 * Returns the S3 key on success.
 */
export async function uploadImage(params: {
	file: File;
	projectId: string;
	documentId: string;
	organizationId: string | null;
	onProgress?: (percent: number) => void;
}): Promise<string> {
	const { file, projectId, documentId, organizationId, onProgress } = params;

	// Step 1: Validate
	const validation = validateImageFile(file);
	if (!validation.valid) {
		throw new Error(validation.error);
	}

	// Step 2: Compress
	onProgress?.(0);
	const compressed = await compressImage(file);

	// Step 3: Get upload URL
	onProgress?.(5);
	const { signedUploadUrl, s3Key } = await getUploadUrl({
		projectId,
		documentId,
		organizationId,
		filename: compressed.name,
		mimeType: compressed.type,
		size: compressed.size,
	});

	if (!signedUploadUrl) {
		throw new Error("Server upload is not supported for media files");
	}

	// Step 4: Upload to S3
	await uploadToS3({
		signedUrl: signedUploadUrl,
		file: compressed,
		onProgress: (percent) => {
			// Scale progress from 10-100 (first 10% was validation + URL generation)
			onProgress?.(10 + Math.round(percent * 0.9));
		},
	});

	onProgress?.(100);
	return s3Key;
}

/** Regex to match S3 keys belonging to the story-media keyspace. */
const STORY_MEDIA_KEY_REGEX = /story-media\/[^"'\s)]+/g;

/**
 * Extract the `story-media/...` S3 key from a single `<img src>` value, if
 * present. Recognises three shapes:
 *
 *   - `"story-media/p/s/uuid.png"`               — bare key (markdown insertion
 *                                                  via `appendAttachmentsSection`)
 *   - `"/story-media/p/s/uuid.png"`              — root-relative
 *   - `"https://bucket/story-media/.../?Sig=…"`  — signed URL (query stripped)
 *
 * The capture stops at `?` and `"` so query strings and trailing quotes are
 * excluded.
 *
 * Used by the StoryWorkspace reload-time signed-URL refresher to identify
 * which `<img>` nodes need their `src` patched to a fresh signed URL.
 *
 * SECURITY NOTE: this regex is host-agnostic — `https://other.com/story-media/foo`
 * also matches. That is by design (the resolver does not care which CDN /
 * bucket-host the signed URL points at, only that the captured key matches
 * the keyspace pattern). The captured key is NOT proof that the caller has
 * access to it. Server-side `resolveStoryImageUrls` enforces the actual
 * authorization gate by rejecting any key whose prefix does not match
 * `story-media/{projectId}/{userStoryId}/` (see
 * `packages/api/modules/projects/procedures/stories/resolve-media-urls.ts`).
 */
export function extractStoryS3KeyFromImgSrc(src: string): string | null {
	const match = src.match(/(?:^|\/)(story-media\/[^?"]+)/);
	return match ? match[1] : null;
}

/**
 * Extract all `story-media/...` S3 keys referenced in editor HTML content.
 * Used by the StoryWorkspace reload-time signed-URL refresher (mirrors
 * `extractS3KeysFromContent` for the documents keyspace).
 */
export function extractStoryS3KeysFromContent(htmlContent: string): string[] {
	const keys = new Set<string>();

	// Extract from data-s3-key attributes (mirrors document-media path).
	let match: RegExpExecArray | null = null;
	S3_KEY_REGEX.lastIndex = 0;
	match = S3_KEY_REGEX.exec(htmlContent);
	while (match !== null) {
		const key = match[1];
		if (key?.startsWith("story-media/")) {
			keys.add(key);
		}
		match = S3_KEY_REGEX.exec(htmlContent);
	}

	// Also extract from src attributes that look like story-media S3 keys.
	STORY_MEDIA_KEY_REGEX.lastIndex = 0;
	match = STORY_MEDIA_KEY_REGEX.exec(htmlContent);
	while (match !== null) {
		keys.add(match[0]);
		match = STORY_MEDIA_KEY_REGEX.exec(htmlContent);
	}

	return Array.from(keys);
}

interface GetStoryUploadUrlParams {
	projectId: string;
	userStoryId: string;
	organizationId: string | null;
	filename: string;
	mimeType: string;
	size: number;
}

/**
 * Get a signed upload URL for a story-media image. Mirrors `getUploadUrl`
 * but routes to the `stories.createMediaUploadUrl` procedure so the S3 key
 * lands under the `story-media/{projectId}/{userStoryId}/` keyspace.
 */
async function getStoryUploadUrl(
	params: GetStoryUploadUrlParams,
): Promise<UploadUrlResult> {
	return await orpcClient.projects.stories.createMediaUploadUrl(params);
}

interface ResolveStoryImageUrlsParams {
	projectId: string;
	userStoryId: string;
	organizationId: string | null;
	s3Keys: string[];
}

/**
 * Resolve story-media S3 keys to signed download URLs for the editor to
 * render. Mirrors `resolveImageUrls` for the story keyspace.
 */
export async function resolveStoryImageUrls(
	params: ResolveStoryImageUrlsParams,
): Promise<Record<string, string>> {
	if (params.s3Keys.length === 0) {
		return {};
	}

	const result = await orpcClient.projects.stories.resolveMediaUrls(params);
	return result.urls;
}

/**
 * Full upload pipeline for StoryWorkspace images. Mirrors `uploadImage`
 * but calls the `stories.createMediaUploadUrl` procedure so the resulting
 * S3 key sits under `story-media/{projectId}/{userStoryId}/` (spec §4.2,
 * §6.1). Reuses the same `validateImageFile` / `compressImage` /
 * `uploadToS3` helpers as the documents pipeline so the two surfaces stay
 * byte-for-byte consistent.
 */
export async function uploadStoryImage(params: {
	file: File;
	projectId: string;
	userStoryId: string;
	organizationId: string | null;
	onProgress?: (percent: number) => void;
}): Promise<string> {
	const { file, projectId, userStoryId, organizationId, onProgress } = params;

	// Step 1: Validate
	const validation = validateImageFile(file);
	if (!validation.valid) {
		throw new Error(validation.error);
	}

	// Step 2: Compress
	onProgress?.(0);
	const compressed = await compressImage(file);

	// Step 3: Get upload URL
	onProgress?.(5);
	const { signedUploadUrl, s3Key } = await getStoryUploadUrl({
		projectId,
		userStoryId,
		organizationId,
		filename: compressed.name,
		mimeType: compressed.type,
		size: compressed.size,
	});

	if (!signedUploadUrl) {
		throw new Error("Server upload is not supported for media files");
	}

	// Step 4: Upload to S3
	await uploadToS3({
		signedUrl: signedUploadUrl,
		file: compressed,
		onProgress: (percent) => {
			// Scale progress from 10-100 (first 10% was validation + URL generation)
			onProgress?.(10 + Math.round(percent * 0.9));
		},
	});

	onProgress?.(100);
	return s3Key;
}
