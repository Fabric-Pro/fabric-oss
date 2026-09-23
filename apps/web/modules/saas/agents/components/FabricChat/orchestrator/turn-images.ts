import { buildAiChatAttachmentEntry } from "@repo/utils/ai-chat-attachment";

/**
 * Most images one Orchestrator turn sends. Matches the composer's paste cap,
 * so nothing the user could attach in one go is silently dropped.
 */
export const ORCHESTRATOR_TURN_IMAGE_CAP = 5;

const GENERATED_IMAGE_PROXY_PATTERN = /\/api\/storage\/image\?path=([^&\s)]+)/g;

/**
 * Storage path of the most recent image the assistant generated in this
 * conversation (the last one in its latest reply that has any), so a follow-up
 * like "make it bluer" still has an input image. Generated images reach the
 * transcript only as storage-proxy links in assistant replies; user uploads
 * never do, so they cannot be picked up here.
 */
export function latestGeneratedImagePath(
	messages: ReadonlyArray<{ role: string; content?: string | null }>,
): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant" || !message.content) {
			continue;
		}
		let latest: string | undefined;
		for (const match of message.content.matchAll(
			GENERATED_IMAGE_PROXY_PATTERN,
		)) {
			try {
				latest = decodeURIComponent(match[1]);
			} catch {
				// Skip a malformed percent-encoded fragment
			}
		}
		if (latest) {
			return latest;
		}
	}
	return undefined;
}

/**
 * The image storage paths a turn sends to the workflow: this turn's uploads,
 * then the latest generated image (an edit target only — it is never turned
 * into a vision document), de-duplicated and capped. Earlier turns' uploads are
 * not re-sent — the model saw them on their own turn, and re-sending every one
 * on every later turn re-billed (and re-routed on) stale pictures.
 */
export function selectTurnImagePaths(
	currentTurnPaths: readonly string[] | undefined,
	latestGeneratedPath?: string,
): string[] | undefined {
	const paths = [
		...new Set([
			...(currentTurnPaths ?? []),
			...(latestGeneratedPath ? [latestGeneratedPath] : []),
		]),
	].slice(0, ORCHESTRATOR_TURN_IMAGE_CAP);
	return paths.length > 0 ? paths : undefined;
}

interface ChatDocumentClient {
	createUploadUrl(input: {
		chatId?: string;
		organizationId?: string;
		filename: string;
		mimeType: string;
		size: number;
	}): Promise<{
		documentId: string;
		signedUploadUrl?: string | null;
		useServerUpload?: boolean;
		chatId?: string | null;
	}>;
	upload(input: {
		documentId: string;
		fileData: string;
		mimeType: string;
	}): Promise<unknown>;
	process(input: {
		documentId: string;
	}): Promise<{ extractedContent?: string | null } | null | undefined>;
}

export interface TurnImageDocumentsRequest {
	images: ReadonlyArray<{ file: File; name: string }>;
	chatId: string | undefined;
	organizationId: string | undefined;
	documents: ChatDocumentClient;
	fetchFn?: typeof fetch;
	onUploadError?: (name: string, error: unknown) => void;
}

/**
 * Store this turn's images as chat documents — the same pipeline Loom Direct
 * sends images through — so their ids can ride `attachedDocumentIds`, the only
 * channel that reaches a vision model as pixels. A failed image is reported and
 * skipped; the turn still goes out with the rest.
 */
export async function uploadTurnImagesAsDocuments({
	images,
	chatId,
	organizationId,
	documents,
	fetchFn = fetch,
	onUploadError,
}: TurnImageDocumentsRequest): Promise<{
	documentIds: string[];
	inlineContexts: string[];
	chatId: string | undefined;
}> {
	const documentIds: string[] = [];
	const inlineContexts: string[] = [];
	let aiChatId = chatId;

	for (const image of images.slice(0, ORCHESTRATOR_TURN_IMAGE_CAP)) {
		try {
			const mimeType = image.file.type || "application/octet-stream";
			const created = await documents.createUploadUrl({
				chatId: aiChatId,
				organizationId,
				filename: image.name,
				mimeType,
				size: image.file.size,
			});
			if (!aiChatId && created.chatId) {
				aiChatId = created.chatId;
			}

			if (created.signedUploadUrl) {
				const response = await fetchFn(created.signedUploadUrl, {
					method: "PUT",
					body: image.file,
					headers: { "Content-Type": mimeType },
				});
				if (!response.ok) {
					throw new Error(
						`Upload failed with status ${response.status}`,
					);
				}
			} else if (created.useServerUpload) {
				const bytes = new Uint8Array(await image.file.arrayBuffer());
				const base64 = btoa(
					bytes.reduce(
						(data, byte) => data + String.fromCharCode(byte),
						"",
					),
				);
				await documents.upload({
					documentId: created.documentId,
					fileData: base64,
					mimeType,
				});
			} else {
				throw new Error("No upload method available");
			}

			// The stored blob is all the vision loader needs, so a failed
			// extraction costs only the text description, never the pixels.
			documentIds.push(created.documentId);
			const extractedContent = await documents
				.process({ documentId: created.documentId })
				.then((processed) => processed?.extractedContent ?? "")
				.catch(() => "");
			inlineContexts.push(
				buildAiChatAttachmentEntry(image.name, extractedContent),
			);
		} catch (error) {
			onUploadError?.(image.name, error);
		}
	}

	return { documentIds, inlineContexts, chatId: aiChatId };
}
