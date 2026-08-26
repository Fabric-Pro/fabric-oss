/**
 * Storage Provider Types
 *
 * Supports S3-compatible storage backends:
 * - minio: Local MinIO (default for local development)
 * - s3: S3-compatible cloud storage (AWS S3, Cloudflare R2, Backblaze B2)
 */

export type StorageProvider = "minio" | "s3";

export type CreateBucketHandler = (
	name: string,
	options?: {
		public?: boolean;
	},
) => Promise<void>;

export type GetSignedUploadUrlHandler = (
	path: string,
	options: {
		bucket: string;
		contentType?: string;
		contentLength?: number;
		expiresIn?: number;
	},
) => Promise<string>;

export type GetSignedDocumentUploadUrlHandler = (
	path: string,
	options: {
		bucket: string;
		contentType: string;
		contentLength: number;
		expiresIn?: number;
	},
) => Promise<string>;

export type GetSignedUrlHander = (
	path: string,
	options: {
		bucket: string;
		expiresIn?: number;
		/**
		 * Override `Content-Disposition` response header on the presigned GET.
		 * Use to force a browser download with a specific filename:
		 *   `attachment; filename="my-file.zip"`
		 * Without this, cross-origin downloads fall back to the object key (UUID).
		 */
		responseContentDisposition?: string;
		/**
		 * Override `Content-Type` response header on the presigned GET.
		 */
		responseContentType?: string;
	},
) => Promise<string>;

/**
 * Upload result from direct upload (used by Vercel Blob)
 */
export interface UploadResult {
	url: string;
	pathname: string;
	downloadUrl?: string;
	contentType?: string;
	size?: number;
}

/**
 * Server-side upload handler (for providers that don't use presigned URLs)
 */
export type UploadFileHandler = (
	path: string,
	data: Buffer | Blob | ReadableStream,
	options: {
		bucket: string;
		contentType: string;
		access?: "public" | "private";
	},
) => Promise<UploadResult>;

/**
 * Delete file handler
 */
export type DeleteFileHandler = (
	url: string,
	options?: {
		bucket?: string;
	},
) => Promise<void>;

/**
 * Copy an object within a bucket (server-side). Used to promote a staged temp
 * upload to its immutable final key. CopyObject preserves the source object's
 * Content-Type, so no contentType parameter is needed.
 *
 * `sourcePath`/`destinationPath` are object keys WITHIN `bucket` (not full S3
 * URLs). The CopySource is URL-encoded with `encodeURI`, which does not escape
 * `#`, `?`, `+`, or `%` — callers must pass pre-validated keys, not arbitrary
 * user input.
 */
export type CopyFileHandler = (
	sourcePath: string,
	destinationPath: string,
	options: {
		bucket: string;
	},
) => Promise<void>;

/**
 * List objects under a prefix (one page per call). `maxKeys` defaults to 1000
 * (the S3 maximum) when omitted. Drive pagination by passing the returned
 * `nextContinuationToken` back in via `continuationToken`; `undefined` means
 * end-of-list. `lastModified` is the S3-server-set object time; entries
 * missing a `Key` or `LastModified` are omitted (an undateable object is
 * never a deletion candidate).
 */
export type ListObjectsHandler = (options: {
	bucket: string;
	prefix: string;
	continuationToken?: string;
	maxKeys?: number;
}) => Promise<{
	objects: { key: string; lastModified: Date; size: number }[];
	nextContinuationToken?: string;
}>;

/**
 * Result of a batch delete: `deleted` is the count S3 reported as removed;
 * `errors` carries per-key failures (S3 `Errors` plus whole-chunk send
 * failures). Best-effort — the handler never throws on delete failures.
 */
export interface DeleteObjectsResult {
	deleted: number;
	errors: { key: string; message: string }[];
}

/**
 * Batch-delete object keys (chunked at the S3 1000-key limit). Best-effort:
 * never throws on delete failures; returns an aggregate result.
 */
export type DeleteObjectsHandler = (
	keys: string[],
	options: { bucket: string },
) => Promise<DeleteObjectsResult>;

/**
 * Get file metadata handler
 */
export type GetFileMetadataHandler = (
	url: string,
	options?: {
		bucket?: string;
	},
) => Promise<{
	size: number;
	contentType: string;
	uploadedAt: Date;
	pathname: string;
	url: string;
} | null>;

/**
 * Download file handler - returns file content as Buffer
 */
export type DownloadFileHandler = (
	path: string,
	options: {
		bucket: string;
	},
) => Promise<{
	data: Buffer;
	contentType: string;
	size: number;
}>;

/**
 * Storage provider interface
 */
export interface StorageProviderInterface {
	/**
	 * Provider type
	 */
	type: StorageProvider;

	/**
	 * Whether this provider supports presigned URLs for direct client uploads
	 */
	supportsPresignedUrls: boolean;

	/**
	 * Get a signed upload URL (S3-compatible providers only)
	 * Returns null if provider doesn't support presigned URLs
	 */
	getSignedUploadUrl: GetSignedUploadUrlHandler | null;

	/**
	 * Get a signed document upload URL (S3-compatible providers only)
	 * Returns null if provider doesn't support presigned URLs
	 */
	getSignedDocumentUploadUrl: GetSignedDocumentUploadUrlHandler | null;

	/**
	 * Get a signed download URL
	 */
	getSignedUrl: GetSignedUrlHander;

	/**
	 * Upload file directly (for providers without presigned URL support)
	 */
	uploadFile: UploadFileHandler;

	/**
	 * Delete a file
	 */
	deleteFile: DeleteFileHandler;

	/**
	 * Copy a file within a bucket (server-side promote: temp -> final)
	 */
	copyFile: CopyFileHandler;

	/**
	 * List objects under a prefix (paginated). Used by the attachment
	 * temp-orphan sweep.
	 */
	listObjects: ListObjectsHandler;

	/**
	 * Batch-delete object keys (used by bulk story/project deletion cleanup)
	 */
	deleteObjects: DeleteObjectsHandler;

	/**
	 * Get file metadata
	 */
	getFileMetadata: GetFileMetadataHandler;

	/**
	 * Download file content
	 */
	downloadFile: DownloadFileHandler;
}
