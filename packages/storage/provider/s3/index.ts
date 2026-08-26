import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import {
	CopyObjectCommand,
	CreateBucketCommand,
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl as getS3SignedUrl } from "@aws-sdk/s3-request-presigner";
import { logger } from "@repo/logs";
import { withProviderBreaker } from "@repo/observability";
import type {
	CopyFileHandler,
	DeleteFileHandler,
	DeleteObjectsHandler,
	DownloadFileHandler,
	GetFileMetadataHandler,
	GetSignedDocumentUploadUrlHandler,
	GetSignedUploadUrlHandler,
	GetSignedUrlHander,
	ListObjectsHandler,
	StorageProviderInterface,
	UploadFileHandler,
} from "../../types";

let s3Client: S3Client | null = null;

/**
 * Return the raw configured `S3Client` instance. Exported so callers that
 * need to pipe streams through `@aws-sdk/lib-storage`'s `Upload` (e.g. the
 * batch context download procedure streaming an `archiver` ZIP into S3) can
 * obtain the same client the provider uses, without re-instantiating config.
 */
export const getS3Client = (): S3Client => {
	return getS3ClientInternal();
};

const getS3ClientInternal = () => {
	if (s3Client) {
		return s3Client;
	}

	const s3Endpoint = process.env.S3_ENDPOINT as string;
	if (!s3Endpoint) {
		throw new Error("Missing env variable S3_ENDPOINT");
	}

	const s3Region = (process.env.S3_REGION as string) || "auto";

	// When both static credentials are provided (MinIO, R2, static-IAM-user AWS),
	// pass them explicitly. When either is missing, omit the `credentials` field
	// so the AWS SDK falls back to its default credential chain — which is the
	// IRSA path on EKS (the projected service-account token resolves to a role
	// via STS AssumeRoleWithWebIdentity).
	const s3AccessKeyId = process.env.S3_ACCESS_KEY_ID;
	const s3SecretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
	const hasStaticCreds = Boolean(s3AccessKeyId && s3SecretAccessKey);

	s3Client = new S3Client({
		region: s3Region,
		endpoint: s3Endpoint,
		forcePathStyle: true,
		// AWS SDK >=3.729.0 turns request/response checksums on by default
		// (WHEN_SUPPORTED, CRC32). Against S3-compatible backends (Cloudflare
		// R2 in prod, MinIO in dev) that injects a SIGNED empty-body
		// x-amz-checksum-crc32 into presigned PUT URLs — breaking every
		// browser upload — and wraps streamed bodies in aws-chunked encoding.
		// WHEN_REQUIRED restores the pre-3.729 wire format for PutObject,
		// multipart upload, and presigned URLs. It does NOT cover
		// DeleteObjects (a checksum-required operation) — see the middleware
		// below.
		requestChecksumCalculation: "WHEN_REQUIRED",
		responseChecksumValidation: "WHEN_REQUIRED",
		// putObjectStream() pipes a live Readable (an `archiver` ZIP) through
		// lib-storage's Upload. When the SDK applies aws-chunked encoding,
		// every non-final chunk must be >=8192 bytes; archiver frequently
		// emits smaller ones, which throws InvalidChunkSizeError. Buffering
		// the stream is AWS's documented mitigation (not on by default):
		// https://github.com/aws/aws-sdk-js-v3/issues/7596
		requestStreamBufferSize: 64 * 1024,
		...(hasStaticCreds
			? {
					credentials: {
						accessKeyId: s3AccessKeyId as string,
						secretAccessKey: s3SecretAccessKey as string,
					},
				}
			: {}),
	});

	// DeleteObjects is the one operation `requestChecksumCalculation` cannot
	// suppress: S3 classifies it checksum-REQUIRED, so since 3.729.0 the SDK
	// sends x-amz-checksum-crc32 instead of the legacy Content-MD5 no matter
	// what the config says. MinIO's open-source image rejects that with
	// MissingContentMD5 (never fixed — the repo was archived 2026-04-24), and
	// R2 support is undocumented. Strip the checksum headers and restore
	// Content-MD5, per AWS's own fallback recipe:
	// https://github.com/aws/aws-sdk-js-v3/blob/main/supplemental-docs/MD5_FALLBACK.md
	type Md5FallbackArgs = {
		request?: { headers?: Record<string, string>; body?: unknown };
	};
	const md5FallbackMiddleware =
		(
			next: (args: Md5FallbackArgs) => Promise<unknown>,
			context: { commandName?: string },
		) =>
		async (args: Md5FallbackArgs) => {
			if (context.commandName !== "DeleteObjectsCommand") {
				return next(args);
			}
			const request = args.request;
			const body = request?.body;
			// The serialized DeleteObjects body is an XML string; if the SDK
			// ever hands us something we cannot hash, leave the request
			// untouched rather than strip the integrity header entirely.
			if (
				!request?.headers ||
				(typeof body !== "string" && !(body instanceof Uint8Array))
			) {
				return next(args);
			}
			for (const header of Object.keys(request.headers)) {
				const lower = header.toLowerCase();
				if (
					lower.startsWith("x-amz-checksum-") ||
					lower.startsWith("x-amz-sdk-checksum-")
				) {
					delete request.headers[header];
				}
			}
			request.headers["Content-MD5"] = createHash("md5")
				.update(typeof body === "string" ? Buffer.from(body) : body)
				.digest("base64");
			return next(args);
		};
	// Registered absolutely at build/low — NOT with AWS's documented
	// addRelativeTo(flexibleChecksumsMiddleware) recipe: since the 3.10xx
	// schema-based clients, that middleware is attached per-command (only on
	// checksum-capable operations), so a client-level relative registration
	// throws "flexibleChecksumsMiddleware is not found" on every other
	// command (HeadBucket, ListBuckets, ...). build/low runs after the
	// checksum injection and before finalizeRequest signing, so Content-MD5
	// lands inside SignedHeaders (verified empirically against 3.1094:
	// finalizeRequest-based registration produces an UNSIGNED Content-MD5).
	// The method cast bridges our defensively-typed structural signature to
	// the SDK's overloaded MiddlewareType union, which TypeScript cannot
	// reconcile with a standalone function type (Parameters<> only sees the
	// last overload). The middleware validates its own inputs.
	(
		s3Client.middlewareStack.add as (
			middleware: typeof md5FallbackMiddleware,
			options: {
				step: string;
				priority: string;
				name: string;
				tags: string[];
			},
		) => void
	)(md5FallbackMiddleware, {
		step: "build",
		priority: "low",
		name: "deleteObjectsMd5FallbackMiddleware",
		tags: ["MD5_FALLBACK"],
	});

	return s3Client;
};

export const getSignedUploadUrl: GetSignedUploadUrlHandler = async (
	path,
	{ bucket, contentType = "image/jpeg", expiresIn = 60 },
) => {
	const client = getS3Client();
	try {
		return await getS3SignedUrl(
			client,
			new PutObjectCommand({
				Bucket: bucket,
				Key: path,
				ContentType: contentType,
			}),
			{
				expiresIn,
			},
		);
	} catch (e) {
		logger.error(e);

		throw new Error("Could not get signed upload url");
	}
};

export const getSignedUrl: GetSignedUrlHander = async (
	path,
	{ bucket, expiresIn, responseContentDisposition, responseContentType },
) => {
	const client = getS3Client();
	try {
		return getS3SignedUrl(
			client,
			new GetObjectCommand({
				Bucket: bucket,
				Key: path,
				ResponseContentDisposition: responseContentDisposition,
				ResponseContentType: responseContentType,
			}),
			{ expiresIn },
		);
	} catch (e) {
		logger.error(e);
		throw new Error("Could not get signed url");
	}
};

/**
 * Get a signed URL for uploading documents with custom content type and size
 */
export const getSignedDocumentUploadUrl: GetSignedDocumentUploadUrlHandler =
	async (path, { bucket, contentType, contentLength, expiresIn = 3600 }) => {
		const client = getS3Client();
		try {
			return await getS3SignedUrl(
				client,
				new PutObjectCommand({
					Bucket: bucket,
					Key: path,
					ContentType: contentType,
					ContentLength: contentLength,
				}),
				{
					expiresIn,
				},
			);
		} catch (e) {
			logger.error(e);
			throw new Error("Could not get signed document upload url");
		}
	};

/**
 * Upload file directly to S3
 */
export const uploadFile: UploadFileHandler = async (
	path,
	data,
	{ bucket, contentType },
) => {
	const client = getS3Client();
	const s3Endpoint = process.env.S3_ENDPOINT as string;

	try {
		// Convert data to buffer if needed
		let body: Buffer | Uint8Array;
		if (Buffer.isBuffer(data)) {
			body = data;
		} else if (data instanceof Blob) {
			const arrayBuffer = await data.arrayBuffer();
			body = new Uint8Array(arrayBuffer);
		} else {
			// ReadableStream
			const chunks: Uint8Array[] = [];
			const reader = data.getReader();
			let done = false;
			while (!done) {
				const result = await reader.read();
				done = result.done;
				if (result.value) {
					chunks.push(result.value);
				}
			}
			body = Buffer.concat(chunks);
		}

		await withProviderBreaker("aws_s3", "put_object", () =>
			client.send(
				new PutObjectCommand({
					Bucket: bucket,
					Key: path,
					Body: body,
					ContentType: contentType,
				}),
			),
		);

		// Construct the URL
		const url = `${s3Endpoint}/${bucket}/${path}`;

		return {
			url,
			pathname: path,
			contentType,
			size: body.length,
		};
	} catch (e) {
		logger.error(e);
		throw new Error("Could not upload file to S3");
	}
};

/**
 * Delete file from S3
 */
export const deleteFile: DeleteFileHandler = async (url, options) => {
	const client = getS3Client();

	try {
		// Extract bucket and key from URL or use provided bucket
		let bucket: string;
		let key: string;

		if (url.startsWith("http")) {
			// Parse URL to extract bucket and key
			const urlObj = new URL(url);
			const pathParts = urlObj.pathname.split("/").filter(Boolean);
			bucket = options?.bucket || pathParts[0];
			key = pathParts.slice(1).join("/");
		} else {
			// Assume url is the key
			if (!options?.bucket) {
				throw new Error(
					"Bucket is required when url is not a full URL",
				);
			}
			bucket = options.bucket;
			key = url;
		}

		await withProviderBreaker("aws_s3", "delete_object", () =>
			client.send(
				new DeleteObjectCommand({
					Bucket: bucket,
					Key: key,
				}),
			),
		);
	} catch (e) {
		logger.error(e);
		throw new Error("Could not delete file from S3");
	}
};

/**
 * Copy an object within a bucket (server-side). Used to promote a staged temp
 * upload to its immutable final key. The destination inherits the source
 * object's Content-Type (CopyObject defaults to MetadataDirective COPY).
 */
export const copyFile: CopyFileHandler = async (
	sourcePath,
	destinationPath,
	{ bucket },
) => {
	const client = getS3Client();
	try {
		await withProviderBreaker("aws_s3", "copy_object", () =>
			client.send(
				new CopyObjectCommand({
					Bucket: bucket,
					// CopySource must be a URL-encoded `bucket/key`. Our keys are
					// [A-Za-z0-9-/._]-only, so encodeURI (which preserves `/`) is correct.
					CopySource: encodeURI(`${bucket}/${sourcePath}`),
					Key: destinationPath,
				}),
			),
		);
	} catch (e) {
		logger.error(e);
		throw new Error("Could not copy file in S3");
	}
};

/**
 * Pure mapping from a `ListObjectsV2Command` response to our provider-neutral
 * shape. Extracted so the risky bits (missing Key/LastModified handling and
 * the empty-string continuation-token coercion) are unit-testable without an
 * S3 client. `NextContinuationToken` is set by the SDK only when the result is
 * truncated; we coerce an empty string to `undefined` so a paginating caller's
 * `while (token)` loop terminates on any S3-compatible backend.
 */
export const mapListObjectsV2Page = (res: {
	Contents?: { Key?: string; LastModified?: Date; Size?: number }[];
	NextContinuationToken?: string;
}): {
	objects: { key: string; lastModified: Date; size: number }[];
	nextContinuationToken?: string;
} => {
	const objects = (res.Contents ?? [])
		.filter(
			(o): o is { Key: string; LastModified: Date; Size?: number } =>
				typeof o.Key === "string" && o.LastModified instanceof Date,
		)
		.map((o) => ({
			key: o.Key,
			lastModified: o.LastModified,
			size: o.Size ?? 0,
		}));
	return {
		objects,
		nextContinuationToken: res.NextContinuationToken || undefined,
	};
};

/**
 * List objects under a prefix (one page per call). See `ListObjectsHandler`.
 */
export const listObjects: ListObjectsHandler = async ({
	bucket,
	prefix,
	continuationToken,
	maxKeys,
}) => {
	const client = getS3Client();
	try {
		const response = await withProviderBreaker(
			"aws_s3",
			"list_objects_v2",
			() =>
				client.send(
					new ListObjectsV2Command({
						Bucket: bucket,
						Prefix: prefix,
						ContinuationToken: continuationToken,
						MaxKeys: maxKeys ?? 1000,
					}),
				),
		);
		return mapListObjectsV2Page(response);
	} catch (e) {
		logger.error(e);
		throw new Error("Could not list objects in S3");
	}
};

/**
 * Pure mapping from a `DeleteObjectsCommand` response to our provider-neutral
 * shape. `deleted` counts the `Deleted` entries (we send with Quiet=false so
 * every removed key is listed); `Errors` map to per-key failures. Extracted so
 * the mapping is unit-testable without an S3 client.
 */
export const mapDeleteObjectsResult = (res: {
	Deleted?: { Key?: string }[];
	Errors?: { Key?: string; Message?: string; Code?: string }[];
}): { deleted: number; errors: { key: string; message: string }[] } => ({
	deleted: (res.Deleted ?? []).length,
	errors: (res.Errors ?? []).map((e) => ({
		key: e.Key ?? "",
		message: e.Message ?? e.Code ?? "unknown error",
	})),
});

/**
 * Batch-delete keys, chunked at the S3 1000-key limit. Best-effort: a whole
 * chunk whose send rejects records all its keys as errors and the loop
 * continues; per-object S3 `Errors` are accumulated. Never throws — a client
 * build failure (e.g. missing `S3_ENDPOINT`) records every key as an error too,
 * so callers that rely on this not throwing (the bulk-clear helper, the PM-sync
 * prune, the project-cleanup activity) do not crash. Empty input is a no-op (no
 * S3 call). See `DeleteObjectsHandler`.
 */
export const deleteObjects: DeleteObjectsHandler = async (keys, { bucket }) => {
	if (keys.length === 0) {
		return { deleted: 0, errors: [] };
	}
	let client: S3Client;
	try {
		client = getS3Client();
	} catch (e) {
		// Honour the never-throws contract even when the client cannot be built.
		logger.error(e);
		return {
			deleted: 0,
			errors: keys.map((key) => ({
				key,
				message: e instanceof Error ? e.message : String(e),
			})),
		};
	}
	let deleted = 0;
	const errors: { key: string; message: string }[] = [];
	for (let i = 0; i < keys.length; i += 1000) {
		const chunk = keys.slice(i, i + 1000);
		try {
			const res = await withProviderBreaker(
				"aws_s3",
				"delete_objects",
				() =>
					client.send(
						new DeleteObjectsCommand({
							Bucket: bucket,
							Delete: { Objects: chunk.map((Key) => ({ Key })) },
						}),
					),
			);
			const mapped = mapDeleteObjectsResult(res);
			deleted += mapped.deleted;
			errors.push(...mapped.errors);
		} catch (e) {
			logger.error(e);
			for (const key of chunk) {
				errors.push({
					key,
					message: e instanceof Error ? e.message : String(e),
				});
			}
		}
	}
	return { deleted, errors };
};

/**
 * Get file metadata from S3
 */
export const getFileMetadata: GetFileMetadataHandler = async (url, options) => {
	const client = getS3Client();
	const s3Endpoint = process.env.S3_ENDPOINT as string;

	try {
		// Extract bucket and key from URL or use provided bucket
		let bucket: string;
		let key: string;

		if (url.startsWith("http")) {
			// Parse URL to extract bucket and key
			const urlObj = new URL(url);
			const pathParts = urlObj.pathname.split("/").filter(Boolean);
			bucket = options?.bucket || pathParts[0];
			key = pathParts.slice(1).join("/");
		} else {
			// Assume url is the key
			if (!options?.bucket) {
				throw new Error(
					"Bucket is required when url is not a full URL",
				);
			}
			bucket = options.bucket;
			key = url;
		}

		const response = await withProviderBreaker(
			"aws_s3",
			"head_object",
			() =>
				client.send(
					new HeadObjectCommand({
						Bucket: bucket,
						Key: key,
					}),
				),
		);

		return {
			size: response.ContentLength || 0,
			contentType: response.ContentType || "application/octet-stream",
			uploadedAt: response.LastModified || new Date(),
			pathname: key,
			url: `${s3Endpoint}/${bucket}/${key}`,
		};
	} catch (e) {
		// Return null if file not found
		if ((e as Error).name === "NotFound") {
			return null;
		}
		logger.error(e);
		throw new Error("Could not get file metadata from S3");
	}
};

/**
 * Download file from S3
 */
export const downloadFile: DownloadFileHandler = async (path, { bucket }) => {
	const client = getS3Client();

	try {
		const response = await withProviderBreaker("aws_s3", "get_object", () =>
			client.send(
				new GetObjectCommand({
					Bucket: bucket,
					Key: path,
				}),
			),
		);

		if (!response.Body) {
			throw new Error("Empty response from S3");
		}

		const buffer = Buffer.from(await response.Body.transformToByteArray());

		return {
			data: buffer,
			contentType: response.ContentType || "application/octet-stream",
			size: response.ContentLength || buffer.length,
		};
	} catch (e) {
		logger.error(e);
		throw new Error(
			`Could not download file from S3: ${(e as Error).message}`,
		);
	}
};

/**
 * Return a Node `Readable` stream for the object at `path` in the given
 * bucket. Callers MUST consume or destroy the returned stream to avoid
 * leaking HTTP connections. Intended for piping an S3 object into another
 * stream sink (e.g. an `archiver` ZIP) without buffering the full body in
 * memory.
 *
 * Throws on HTTP errors from `GetObject`. Missing keys surface as
 * `NoSuchKey` from the underlying SDK; callers decide whether to treat a
 * missing source as fatal or skipped.
 */
export const getObjectStream = async (
	path: string,
	options: { bucket: string },
): Promise<Readable> => {
	const client = getS3Client();
	const response = await withProviderBreaker("aws_s3", "get_object", () =>
		client.send(
			new GetObjectCommand({
				Bucket: options.bucket,
				Key: path,
			}),
		),
	);
	if (!response.Body) {
		throw new Error(`Empty response body for ${options.bucket}/${path}`);
	}
	// In Node.js runtimes the AWS SDK returns a `Readable` stream here.
	return response.Body as Readable;
};

/**
 * Stream-upload a `Readable` (or `archiver`-style) body to S3 using the
 * multipart uploader from `@aws-sdk/lib-storage`. The helper awaits the
 * final upload and never buffers the full body in memory. Used by the
 * project-contexts batch download procedure so `packages/api`
 * does not need a direct `@aws-sdk/*` dependency.
 */
export const putObjectStream = async (
	path: string,
	body: Readable,
	options: { bucket: string; contentType?: string },
): Promise<void> => {
	const client = getS3Client();
	const upload = new Upload({
		client,
		params: {
			Bucket: options.bucket,
			Key: path,
			Body: body,
			ContentType: options.contentType ?? "application/octet-stream",
		},
	});
	await withProviderBreaker("aws_s3", "put_object_stream", () =>
		upload.done(),
	);
};

/**
 * Ensure all required storage buckets exist, creating any that are missing.
 * Safe to call on every startup — uses HeadBucket to check existence first.
 */
export const ensureBuckets = async (bucketNames: string[]): Promise<void> => {
	const client = getS3Client();

	for (const bucket of bucketNames) {
		try {
			await withProviderBreaker("aws_s3", "head_bucket", () =>
				client.send(new HeadBucketCommand({ Bucket: bucket })),
			);
		} catch (e: unknown) {
			const httpStatus = (
				e as { $metadata?: { httpStatusCode?: number } }
			).$metadata?.httpStatusCode;
			const name = (e as { name?: string }).name;
			const code = httpStatus ?? name;

			// Bucket doesn't exist (404) or we got NotFound/NoSuchBucket.
			// S3-compatible endpoints (MinIO, R2) may return UnknownError when
			// the 404 response body isn't parseable AWS XML — treat it the same.
			if (
				code === 404 ||
				code === "NotFound" ||
				code === "NoSuchBucket" ||
				name === "UnknownError"
			) {
				logger.info(`Creating missing storage bucket: ${bucket}`);
				try {
					await withProviderBreaker("aws_s3", "create_bucket", () =>
						client.send(
							new CreateBucketCommand({ Bucket: bucket }),
						),
					);
				} catch (createErr: unknown) {
					// BucketAlreadyOwnedByYou is fine (race condition)
					if (
						(createErr as { name?: string }).name !==
						"BucketAlreadyOwnedByYou"
					) {
						logger.error(
							`Failed to create bucket ${bucket}:`,
							createErr,
						);
					}
				}
			} else {
				logger.error(`Failed to check bucket ${bucket}:`, e);
			}
		}
	}
};

/**
 * S3 Storage Provider
 */
export const s3Provider: StorageProviderInterface = {
	type: "s3",
	supportsPresignedUrls: true,
	getSignedUploadUrl,
	getSignedDocumentUploadUrl,
	getSignedUrl,
	uploadFile,
	deleteFile,
	copyFile,
	listObjects,
	deleteObjects,
	getFileMetadata,
	downloadFile,
};
