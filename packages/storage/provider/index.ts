/**
 * Storage Provider Exports
 *
 * Uses S3-compatible storage (MinIO for local dev, Cloudflare R2 for production).
 * Configure via STORAGE_PROVIDER env var:
 * - "minio" (default): Local MinIO for development
 * - "s3": S3-compatible cloud storage (AWS S3, Cloudflare R2, Backblaze B2)
 */

import type { StorageProvider, StorageProviderInterface } from "../types";
import {
	type getSignedDocumentUploadUrl as s3GetSignedDocumentUploadUrl,
	type getSignedUploadUrl as s3GetSignedUploadUrl,
	type getSignedUrl as s3GetSignedUrl,
	s3Provider,
} from "./s3";

// Re-export S3 provider for direct access
export * from "./s3";

/**
 * Get the configured storage provider type
 */
export const getStorageProviderType = (): StorageProvider => {
	const provider = process.env.STORAGE_PROVIDER as
		| StorageProvider
		| undefined;
	return provider || "minio"; // Default to MinIO for local development
};

/**
 * Get the storage provider instance
 * Both minio and s3 use the same S3-compatible provider
 */
export const getStorageProvider = (): StorageProviderInterface => {
	return s3Provider;
};

// Export typed provider functions that auto-select based on environment
// These maintain backward compatibility with existing code

/**
 * Get a signed upload URL
 */
export const getSignedUploadUrl: typeof s3GetSignedUploadUrl = async (
	path,
	options,
) => {
	const provider = getStorageProvider();
	if (!provider.getSignedUploadUrl) {
		throw new Error("Storage provider does not support presigned URLs");
	}
	return provider.getSignedUploadUrl(path, options);
};

/**
 * Get a signed document upload URL
 */
export const getSignedDocumentUploadUrl: typeof s3GetSignedDocumentUploadUrl =
	async (path, options) => {
		const provider = getStorageProvider();
		if (!provider.getSignedDocumentUploadUrl) {
			throw new Error("Storage provider does not support presigned URLs");
		}
		return provider.getSignedDocumentUploadUrl(path, options);
	};

/**
 * Get a signed download URL
 */
export const getSignedUrl: typeof s3GetSignedUrl = async (path, options) => {
	const provider = getStorageProvider();
	return provider.getSignedUrl(path, options);
};

/**
 * Upload file directly to storage
 */
export const uploadFile = async (
	path: string,
	data: Buffer | Blob | ReadableStream,
	options: {
		bucket: string;
		contentType: string;
		access?: "public" | "private";
	},
) => {
	const provider = getStorageProvider();
	return provider.uploadFile(path, data, options);
};

/**
 * Delete file from storage
 */
export const deleteFile = async (
	url: string,
	options?: {
		bucket?: string;
	},
) => {
	const provider = getStorageProvider();
	return provider.deleteFile(url, options);
};

/**
 * Copy a file within a bucket (server-side promote)
 */
export const copyFile = async (
	sourcePath: string,
	destinationPath: string,
	options: {
		bucket: string;
	},
) => {
	const provider = getStorageProvider();
	return provider.copyFile(sourcePath, destinationPath, options);
};

/**
 * List objects under a prefix (paginated)
 */
export const listObjects = async (options: {
	bucket: string;
	prefix: string;
	continuationToken?: string;
	maxKeys?: number;
}) => {
	const provider = getStorageProvider();
	return provider.listObjects(options);
};

/**
 * Batch-delete object keys (best-effort, chunked)
 */
export const deleteObjects = async (
	keys: string[],
	options: { bucket: string },
) => {
	const provider = getStorageProvider();
	return provider.deleteObjects(keys, options);
};

/**
 * Get file metadata
 */
export const getFileMetadata = async (
	url: string,
	options?: {
		bucket?: string;
	},
) => {
	const provider = getStorageProvider();
	return provider.getFileMetadata(url, options);
};

/**
 * Download file from storage
 */
export const downloadFile = async (
	path: string,
	options: {
		bucket: string;
	},
) => {
	const provider = getStorageProvider();
	return provider.downloadFile(path, options);
};
