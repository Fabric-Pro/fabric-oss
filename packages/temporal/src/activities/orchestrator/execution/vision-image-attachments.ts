/**
 * Image bytes for Advisor rounds. Patched callers pin the SHA-256, MIME type,
 * and transformation version to the source user message. Legacy callers use
 * the last-user splice on their first round. Raw byte arrays let provider
 * adapters encode file parts without an SDK URL download.
 */

import { createHash } from "node:crypto";
import { logger } from "@repo/logs";
import type { ImageAttachmentReference } from "../../../workflows/orchestrator/types";

export type ResolvedImageAttachment = {
	filename: string | null;
	mediaType: string;
	bytes: Uint8Array;
	reference?: ImageAttachmentReference;
};

/**
 * Resolve caller-owned image documents in the request's organization. Pinned
 * requests follow documentIds order and reject changed byte identities. Failed
 * downloads are logged and omitted so the answer can continue with other images.
 */
export type ImageAttachmentResolution =
	| {
			status: "resolved";
			documentId: string;
			attachment: ResolvedImageAttachment;
	  }
	| {
			status: "permanently_gone";
			documentId: string;
			reason:
				| "missing"
				| "hash_mismatch"
				| "mime_mismatch"
				| "transformation_mismatch"
				| "missing_reference";
	  }
	| {
			status: "temporarily_unavailable";
			documentId: string;
			reason: "query_error" | "download_error";
	  };

interface PinnedImageOptions {
	references?: ImageAttachmentReference[];
	/** IDs whose initial byte capture has not succeeded yet. */
	captureDocumentIds?: string[];
}

export function resolveImageAttachments(
	documentIds: string[],
	userId: string,
	organizationId?: string,
): Promise<ResolvedImageAttachment[]>;
export function resolveImageAttachments(
	documentIds: string[],
	userId: string,
	organizationId: string | undefined,
	pinned: PinnedImageOptions,
): Promise<ImageAttachmentResolution[]>;
export async function resolveImageAttachments(
	documentIds: string[],
	userId: string,
	organizationId?: string,
	pinned?: PinnedImageOptions,
): Promise<ResolvedImageAttachment[] | ImageAttachmentResolution[]> {
	if (documentIds.length === 0) {
		return [];
	}
	let docs: Array<{
		id: string;
		filename: string | null;
		mimeType: string | null;
		s3Path: string | null;
	}>;
	try {
		const { db } = await import("@repo/database");
		docs = await db.chatDocument.findMany({
			where: {
				id: { in: documentIds },
				userId,
				organizationId: organizationId ?? null,
				mimeType: { startsWith: "image/" },
			},
			select: { id: true, filename: true, mimeType: true, s3Path: true },
			orderBy: { id: "asc" },
		});
	} catch (error) {
		if (!pinned) {
			throw error;
		}
		return documentIds.map((documentId): ImageAttachmentResolution => {
			logger.warn("[VisionAttachments] Image temporarily unavailable", {
				documentId,
				reason: "query_error",
			});
			return {
				status: "temporarily_unavailable",
				documentId,
				reason: "query_error",
			};
		});
	}
	const orderedDocs = pinned
		? documentIds.map((id) => docs.find((doc) => doc.id === id))
		: docs;
	const { downloadFile } = await import("@repo/storage");
	const { config } = await import("@repo/config");
	const bucket = config.storage.bucketNames.chatDocuments;
	const outcomes = await Promise.all(
		orderedDocs.map(
			async (doc, index): Promise<ImageAttachmentResolution> => {
				const documentId = doc?.id ?? documentIds[index];
				const gone = (
					reason: Extract<
						ImageAttachmentResolution,
						{ status: "permanently_gone" }
					>["reason"],
				): ImageAttachmentResolution => {
					if (pinned) {
						logger.warn("[VisionAttachments] Image omitted", {
							documentId,
							reason,
						});
					}
					return { status: "permanently_gone", documentId, reason };
				};
				if (!doc || !doc.s3Path || !doc.mimeType) {
					return gone("missing");
				}
				const expected = pinned?.references?.find(
					(ref) => ref.documentId === doc.id,
				);
				if (expected) {
					if (expected.mimeType !== doc.mimeType) {
						return gone("mime_mismatch");
					}
					if (expected.transformationVersion !== "original-v1") {
						return gone("transformation_mismatch");
					}
				} else if (
					pinned?.references &&
					!pinned.captureDocumentIds?.includes(doc.id)
				) {
					return gone("missing_reference");
				}
				try {
					const { data } = await downloadFile(doc.s3Path, { bucket });
					const bytes = new Uint8Array(
						data.buffer,
						data.byteOffset,
						data.byteLength,
					);
					let reference: ImageAttachmentReference | undefined;
					if (pinned) {
						reference = {
							documentId: doc.id,
							contentHash: createHash("sha256")
								.update(bytes)
								.digest("hex"),
							mimeType: doc.mimeType,
							transformationVersion: "original-v1",
						};
						if (
							expected &&
							expected.contentHash !== reference.contentHash
						) {
							return gone("hash_mismatch");
						}
					}
					return {
						status: "resolved",
						documentId,
						attachment: {
							filename: doc.filename,
							mediaType: doc.mimeType,
							bytes,
							...(reference ? { reference } : {}),
						},
					};
				} catch (error) {
					logger.warn(
						"[VisionAttachments] Failed to download image attachment — model will not see this image",
						{
							documentId,
							error:
								error instanceof Error
									? error.message
									: String(error),
						},
					);
					return {
						status: "temporarily_unavailable",
						documentId,
						reason: "download_error",
					};
				}
			},
		),
	);
	return pinned
		? outcomes
		: outcomes.flatMap((outcome) =>
				outcome.status === "resolved" ? [outcome.attachment] : [],
			);
}

/**
 * Per-request image budget, checked on the server after download (review
 * F37). The paperclip shapes images in the browser, but paste/drop did not,
 * and nothing here bounded size or count — one oversize screenshot reached
 * the provider over its per-image cap and failed the whole turn. Images over
 * budget are left out and the model is told which, so the turn still
 * answers.
 *
 * Measured base64-encoded, as the provider receives them. 5 MiB is the
 * strictest per-image cap among the providers in use (Anthropic); the count
 * and total bound what one turn may spend on vision.
 */
export const MAX_ENCODED_BYTES_PER_IMAGE = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_REQUEST = 8;
export const MAX_ENCODED_IMAGE_BYTES_PER_REQUEST = 20 * 1024 * 1024;

export interface OmittedImage {
	filename: string | null;
	reason: "too_large" | "too_many" | "request_budget";
}

function encodedBytes(rawBytes: number): number {
	return Math.ceil(rawBytes / 3) * 4;
}

export function budgetImageAttachments<
	T extends { filename: string | null; bytes: Uint8Array },
>(attachments: T[]): { kept: T[]; omitted: OmittedImage[] } {
	const kept: T[] = [];
	const omitted: OmittedImage[] = [];
	let total = 0;
	for (const attachment of attachments) {
		const size = encodedBytes(attachment.bytes.byteLength);
		if (size > MAX_ENCODED_BYTES_PER_IMAGE) {
			omitted.push({
				filename: attachment.filename,
				reason: "too_large",
			});
		} else if (kept.length >= MAX_IMAGES_PER_REQUEST) {
			omitted.push({ filename: attachment.filename, reason: "too_many" });
		} else if (total + size > MAX_ENCODED_IMAGE_BYTES_PER_REQUEST) {
			omitted.push({
				filename: attachment.filename,
				reason: "request_budget",
			});
		} else {
			kept.push(attachment);
			total += size;
		}
	}
	return { kept, omitted };
}

const OMITTED_REASON_COPY: Record<OmittedImage["reason"], string> = {
	too_large: "larger than the 5 MB a single image may be",
	too_many: `more than ${MAX_IMAGES_PER_REQUEST} images in one message`,
	request_budget: "over the total image size one message may carry",
};

/**
 * Tells the model which attached images it cannot see and why, so it says
 * so to the user instead of answering as if it had looked at them.
 */
export function omittedImagesNote(omitted: OmittedImage[]): string | null {
	if (omitted.length === 0) {
		return null;
	}
	const lines = omitted.map(
		(image) =>
			`- ${image.filename ?? "an attached image"}: ${OMITTED_REASON_COPY[image.reason]}`,
	);
	return `[Note: ${omitted.length} attached image${omitted.length === 1 ? " was" : "s were"} not shown to you:\n${lines.join("\n")}\nTell the user which image${omitted.length === 1 ? "" : "s"} you could not see and suggest sending a smaller version.]`;
}

/**
 * Append resolved image parts to the LAST user message in `messages` (mutated in
 * place), plus an optional text note (e.g. which images were left out). The
 * provider adapters accept `Uint8Array` file parts directly. Returns the number
 * of images attached (0 when there is nothing to attach or no user message to
 * attach to).
 */
export function spliceImagePartsIntoLastUserMessage(
	messages: Array<{ role?: string; content?: unknown }>,
	attachments: ResolvedImageAttachment[],
	note?: string | null,
): number {
	if (attachments.length === 0 && !note) {
		return 0;
	}

	let lastUserIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			lastUserIdx = i;
			break;
		}
	}
	if (lastUserIdx < 0) {
		return 0;
	}

	return spliceImagePartsIntoMessage(
		messages[lastUserIdx],
		attachments,
		note,
	);
}

/** Expand images on the workflow's source message without changing its text or neighbors. */
export function spliceImagePartsIntoMessage(
	target: { content?: unknown },
	attachments: ResolvedImageAttachment[],
	note?: string | null,
): number {
	if (attachments.length === 0 && !note) {
		return 0;
	}
	const existingText =
		typeof target.content === "string"
			? [{ type: "text" as const, text: target.content }]
			: Array.isArray(target.content)
				? (target.content as Array<{
						type: string;
						[k: string]: unknown;
					}>)
				: [];
	// AI SDK 7 deprecates the `image` message part in favour of the canonical
	// flat `file` part (FilePart: { type, data, mediaType }), where mediaType is
	// required. Keep the attachment's real MIME type.
	const imageParts = attachments.map((att) => ({
		type: "file" as const,
		data: att.bytes,
		mediaType: att.mediaType,
	}));
	target.content = [
		...existingText,
		...(note ? [{ type: "text" as const, text: note }] : []),
		...imageParts,
	];
	return imageParts.length;
}
