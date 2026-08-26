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
 * Append resolved image parts to the LAST user message in `messages` (mutated in
 * place). The provider adapters accept `Uint8Array` `image` parts directly.
 * Returns the number of images attached (0 when there is nothing to attach or no
 * user message to attach to).
 */
export function spliceImagePartsIntoLastUserMessage(
	messages: Array<{ role?: string; content?: unknown }>,
	attachments: ResolvedImageAttachment[],
): number {
	if (attachments.length === 0) {
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
	const imageParts = attachments.map((att) => ({
		type: "image" as const,
		image: att.bytes,
		mediaType: att.mediaType,
	}));
	target.content = [...existingText, ...imageParts];
	return imageParts.length;
}
