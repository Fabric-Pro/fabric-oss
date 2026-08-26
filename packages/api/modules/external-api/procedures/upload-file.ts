/**
 * File Upload for External API
 *
 * Accepts multipart/form-data with a single `file` field.
 * Validates image types and size, uploads to S3, and returns a fileId
 * that can be referenced in execute requests.
 */

import { randomUUID } from "node:crypto";
import { config } from "@repo/config";
import { uploadFile } from "@repo/storage";
import type { ExternalApiContext } from "../types";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
]);

export interface UploadFileResult {
	fileId: string;
	name: string;
	size: number;
	mimeType: string;
}

/**
 * Encode a storage path as a URL-safe fileId.
 * Consumers pass this fileId back in execute requests.
 */
function encodeFileId(storagePath: string): string {
	return Buffer.from(storagePath, "utf-8").toString("base64url");
}

/**
 * Decode a fileId back to the original storage path.
 */
function decodeFileId(fileId: string): string {
	return Buffer.from(fileId, "base64url").toString("utf-8");
}

/**
 * Get the tenant-specific storage prefix for a given API context.
 */
function getTenantPrefix(ctx: ExternalApiContext): string {
	return ctx.organizationId || ctx.userId;
}

export async function handleFileUpload(
	file: File,
	ctx: ExternalApiContext,
): Promise<
	| { data: UploadFileResult; status: 200 }
	| { error: string; status: 400 | 500 }
> {
	if (!file || !(file instanceof File)) {
		return { error: "No file provided", status: 400 };
	}

	if (!ALLOWED_TYPES.has(file.type)) {
		return {
			error: `Unsupported file type: ${file.type}. Supported: PNG, JPEG, WebP, GIF`,
			status: 400,
		};
	}

	if (file.size > MAX_FILE_SIZE) {
		return { error: "File size must be less than 10MB", status: 400 };
	}

	try {
		const extension = file.type.split("/")[1] || "png";
		// UUID so fileId (base64url of path) isn't enumerable across neighbors.
		const uniqueName = randomUUID();
		const ownerPrefix = getTenantPrefix(ctx);
		const storagePath = `${ownerPrefix}/api-images/${uniqueName}.${extension}`;
		const bucket = config.storage.bucketNames.chatDocuments;

		const arrayBuffer = await file.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);

		await uploadFile(storagePath, buffer, {
			bucket,
			contentType: file.type,
		});

		return {
			data: {
				fileId: encodeFileId(storagePath),
				name: file.name,
				size: file.size,
				mimeType: file.type,
			},
			status: 200,
		};
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : "Upload failed",
			status: 500,
		};
	}
}

/**
 * Validate that a fileId belongs to the given tenant prefix.
 * Prevents cross-tenant access via fileId manipulation.
 */
export function validateFileIdTenant(
	fileId: string,
	ctx: ExternalApiContext,
): { valid: true; storagePath: string } | { valid: false; error: string } {
	let storagePath: string;
	try {
		storagePath = decodeFileId(fileId);
	} catch {
		return { valid: false, error: "Invalid fileId encoding" };
	}

	const expectedPrefix = getTenantPrefix(ctx);
	if (!storagePath.startsWith(`${expectedPrefix}/`)) {
		return {
			valid: false,
			error: "File does not belong to this tenant",
		};
	}

	return { valid: true, storagePath };
}
