/**
 * Vision image attachments for the orchestrator agent loop.
 *
 * The Nexus / Loom orchestrator historically fed the model only the RAG-extracted
 * *text* of an attached image (an OCR/description), never the pixels — so a
 * vision-capable model could not actually SEE the image. This helper resolves the
 * image-typed chat documents attached to the current turn into raw bytes and
 * splices them onto the last user message so the model receives the real pixels,
 * matching what the direct-chat path (`direct-chat/ai-execution.ts`) already does.
 * The RAG description remains the fallback for non-vision models.
 *
 * Storing raw `Uint8Array` (NOT a `data:` URL string): Vercel AI SDK 5's
 * `convertToLanguageModelPrompt` runs `downloadAssets` over every string-typed
 * `image` part, and `validateDownloadUrl` rejects the `data:` scheme with
 * "URL scheme must be http or https". Passing the raw bytes skips the URL fetcher
 * entirely — the provider adapters (OpenAI / Anthropic / Azure) base64-encode the
 * buffer themselves before sending.
 *
 * (The direct-chat path carries an equivalent inline implementation; it can adopt
 * this helper in a future consolidation.)
 */

import { logger } from "@repo/logs";

export type ResolvedImageAttachment = {
	filename: string | null;
	mediaType: string;
	bytes: Uint8Array;
};

/**
 * Download the image-typed chat documents among `documentIds`, tenant-scoped to
 * the caller. Non-image documents are ignored. Individual download failures are
 * logged and skipped so one bad blob never aborts the whole response. Restricted
 * to the IDs explicitly forwarded for the current message — older attachments are
 * intentionally not re-resolved here (the caller gates on the first iteration so
 * we don't pay vision-token cost on every follow-up turn).
 */
export async function resolveImageAttachments(
	documentIds: string[],
	userId: string,
	organizationId?: string,
): Promise<ResolvedImageAttachment[]> {
	if (documentIds.length === 0) {
		return [];
	}

	const { db } = await import("@repo/database");
	const docs = await db.chatDocument.findMany({
		where: {
			id: { in: documentIds },
			userId,
			organizationId: organizationId ?? null,
			mimeType: { startsWith: "image/" },
		},
		select: { id: true, filename: true, mimeType: true, s3Path: true },
	});

	if (docs.length === 0) {
		return [];
	}

	const { downloadFile } = await import("@repo/storage");
	const { config } = await import("@repo/config");
	const bucket = config.storage.bucketNames.chatDocuments;

	const settled = await Promise.all(
		docs.map(async (doc) => {
			if (!doc.s3Path || !doc.mimeType) {
				return null;
			}
			try {
				const { data } = await downloadFile(doc.s3Path, { bucket });
				const bytes = new Uint8Array(
					data.buffer,
					data.byteOffset,
					data.byteLength,
				);
				return {
					filename: doc.filename,
					mediaType: doc.mimeType,
					bytes,
				} satisfies ResolvedImageAttachment;
			} catch (err) {
				logger.warn(
					"[VisionAttachments] Failed to download image attachment — model will not see this image",
					{
						documentId: doc.id,
						error: err instanceof Error ? err.message : String(err),
					},
				);
				return null;
			}
		}),
	);

	return settled.filter(
		(att): att is NonNullable<typeof att> => att !== null,
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

	const target = messages[lastUserIdx] as { role: "user"; content: unknown };
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
