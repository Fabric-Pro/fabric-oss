import {
	DEFAULT_ATTACHMENT_MIME_ALLOWLIST,
	DEFAULT_MAX_ATTACHMENT_BYTES,
	EXCALIDRAW_MIME,
	isValidExcalidrawContent,
	resolveAttachmentMime,
	type StoryAttachmentDesignation,
} from "@repo/utils/attachment";
import { orpcClient } from "@shared/lib/orpc-client";
import { uploadToS3 } from "./image-upload-utils";

export interface StoryAttachmentDto {
	id: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
	designation: StoryAttachmentDesignation;
	/** "FABRIC" for an in-app upload, "PM_SYNCED" for a row synced in from a PM tool. */
	source: "FABRIC" | "PM_SYNCED";
	/** PM server key ("jira", "azure-devops", "fizzy") that owns a PM_SYNCED row; null for FABRIC. */
	sourceTool: string | null;
	/** Set once a PM_SYNCED row is promoted to a full Fabric-managed asset; always null for FABRIC. */
	promotedAt: string | Date | null;
	externalAuthor: string | null;
	externalCreatedAt: string | Date | null;
	createdAt: string | Date;
	downloadUrl?: string | null;
}

/**
 * Browser upload pipeline for story attachments.
 *
 * Flow: client-side pre-validation (advisory) → createAttachmentUploadUrl →
 * direct PUT via uploadToS3 → createAttachment (persist row) → return dto.
 *
 * The server is the authoritative validator; client-side checks are
 * advisory and guard against obvious mistakes before any network call.
 */
export async function uploadStoryAttachment(params: {
	file: File;
	projectId: string;
	userStoryId: string;
	organizationId: string | null;
	/**
	 * At-creation designation. Omit for the default (LOCKED). The feature-creation
	 * flow passes UNLOCKED for "Context only" files. #1702 v1.
	 */
	designation?: StoryAttachmentDesignation;
	onProgress?: (percent: number) => void;
}): Promise<StoryAttachmentDto> {
	const {
		file,
		projectId,
		userStoryId,
		organizationId,
		designation,
		onProgress,
	} = params;

	// Client-side pre-validation (advisory; server is authoritative). Resolve the
	// canonical mime so empty/ambiguous browser mimes (e.g. .md) are rescued and
	// the PUT Content-Type matches the presigned binding.
	const resolvedMime = resolveAttachmentMime(
		file.name,
		file.type,
		DEFAULT_ATTACHMENT_MIME_ALLOWLIST,
	);
	if (!resolvedMime) {
		throw new Error(
			`Unsupported file type for "${file.name}": ${file.type || "unknown"}`,
		);
	}
	if (file.size > DEFAULT_MAX_ATTACHMENT_BYTES) {
		throw new Error(
			`File must be at most ${Math.floor(DEFAULT_MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB`,
		);
	}

	// Excalidraw content pre-check (#1942): advisory. Reject a malformed
	// .excalidraw before any network call; the server re-validates authoritatively.
	if (resolvedMime === EXCALIDRAW_MIME) {
		const text = await file.text();
		if (!isValidExcalidrawContent(text)) {
			throw new Error("The file is not a valid Excalidraw document.");
		}
	}

	onProgress?.(5);
	const { signedUploadUrl, storageKey, contentType } =
		await orpcClient.projects.stories.createAttachmentUploadUrl({
			projectId,
			userStoryId,
			organizationId,
			filename: file.name,
			mimeType: resolvedMime,
			size: file.size,
		});
	if (!signedUploadUrl) {
		throw new Error("Uploads are temporarily unavailable");
	}

	await uploadToS3({
		signedUrl: signedUploadUrl,
		file,
		contentType: contentType ?? resolvedMime,
		onProgress: (p) => onProgress?.(10 + Math.round(p * 0.85)),
	});

	const { attachment } = await orpcClient.projects.stories.createAttachment({
		projectId,
		userStoryId,
		organizationId,
		storageKey,
		filename: file.name,
		...(designation ? { designation } : {}),
	});
	onProgress?.(100);
	// createAttachment only selects the columns a fresh upload can set — the
	// PM-provenance columns don't exist yet for a row that was just created here.
	// A Fabric-origin upload is always FABRIC/implicitly-promoted, so those are
	// filled in rather than cast away (Fizzy #1746).
	return {
		...attachment,
		source: "FABRIC",
		sourceTool: null,
		promotedAt: null,
		externalAuthor: null,
		externalCreatedAt: null,
	} satisfies StoryAttachmentDto;
}
