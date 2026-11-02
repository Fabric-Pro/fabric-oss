import {
	type ChatMediaKind,
	isBeforeChatMediaLegacyCutoff,
	recordChatMediaObject,
	resolveChatMediaAccess,
} from "@repo/database";
import { deleteFile, getFileMetadata, uploadFile } from "@repo/storage";

const CHAT_MEDIA_BUCKET =
	process.env.NEXT_PUBLIC_CHAT_DOCUMENTS_BUCKET_NAME || "chat-documents";

export class ChatMediaPersistenceError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ChatMediaPersistenceError";
	}
}

export async function uploadRecordedChatMedia({
	data,
	contentType,
	extension,
	storageKind,
	recordKind,
	userId,
	organizationId,
	conversationId,
}: {
	data: Buffer;
	contentType: string;
	extension: string;
	storageKind: "chat-images" | "generated-images" | "tts-audio";
	recordKind: ChatMediaKind;
	userId: string;
	organizationId?: string;
	conversationId?: string;
}): Promise<string> {
	const ownerPrefix = organizationId || userId;
	const timestamp = Date.now();
	const hash = Math.random().toString(36).substring(2, 10);
	const storagePath = `${ownerPrefix}/${storageKind}/${timestamp}-${hash}.${extension}`;

	await uploadFile(storagePath, data, {
		bucket: CHAT_MEDIA_BUCKET,
		contentType,
	});
	try {
		await recordChatMediaObject({
			storageKey: storagePath,
			kind: recordKind,
			userId,
			organizationId: organizationId ?? null,
			conversationId: conversationId ?? null,
		});
	} catch (error) {
		try {
			await deleteFile(storagePath, { bucket: CHAT_MEDIA_BUCKET });
		} catch (cleanupError) {
			console.error(
				"[ChatMedia] Failed to clean up an unrecorded object",
				cleanupError,
			);
		}
		throw new ChatMediaPersistenceError(
			"Uploaded chat media could not be bound to its owner",
			{ cause: error },
		);
	}

	return storagePath;
}

export async function canUseChatMedia({
	storageKey,
	userId,
	organizationId,
}: {
	storageKey: string;
	userId: string;
	organizationId?: string;
}): Promise<boolean> {
	const access = await resolveChatMediaAccess({
		storageKey,
		userId,
		organizationId: organizationId ?? null,
	});
	if (access !== "deny") {
		return true;
	}

	// External API image refs written by older workers use UUID filenames, so
	// their age cannot be recovered from the key. S3's LastModified is the
	// fail-closed rollout evidence for this one legacy shape.
	const ownerPrefix = organizationId || userId;
	if (
		!new RegExp(
			`^${ownerPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/api-images\\/[0-9a-f-]+\\.[a-z0-9]+$`,
		).test(storageKey)
	) {
		return false;
	}
	try {
		const metadata = await getFileMetadata(storageKey, {
			bucket: CHAT_MEDIA_BUCKET,
		});
		return metadata
			? isBeforeChatMediaLegacyCutoff(metadata.uploadedAt)
			: false;
	} catch {
		return false;
	}
}

export function chatMediaProxyUrl(
	storagePath: string,
	organizationId?: string,
): string {
	const orgParam = organizationId
		? `&orgId=${encodeURIComponent(organizationId)}`
		: "";
	return `/api/storage/image?path=${encodeURIComponent(storagePath)}${orgParam}`;
}
