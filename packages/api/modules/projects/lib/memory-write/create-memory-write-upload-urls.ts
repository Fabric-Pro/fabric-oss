/**
 * Signed URLs to stage the files of a Living Memory write straight into
 * storage (ADR-022), shared by the app's procedure and the v1 REST route.
 *
 * A request body cannot carry a whole write (Vercel Function bodies are capped
 * at 4.5 MB), so a write stages its files first and names them in `submit`,
 * the way the Coding Instructions uploads do: the same bucket and the same
 * signed PUT, under `memory-writes/<projectId>/<uuid>`. One URL is signed per
 * file, for text of at most the file bound (2 MiB), and the declared size is
 * part of the signature, so a URL cannot be used for a larger object. The URL
 * expires quickly; nothing is registered, because a staged file is nothing
 * until `submit` names it, and `submit` reads it back and checks its size and
 * SHA-256 before it admits anything.
 */
import { getStorageProvider } from "@repo/storage";
import {
	MEMORY_WRITE_STAGING_BUCKET,
	newMemoryWriteStagingKey,
	STAGED_CONTENT_TYPE,
} from "@repo/temporal/memory-write/staging";

/**
 * How long a signed PUT stays usable: ten minutes, long enough for a slow
 * uplink to send a few files of at most 2 MiB each, short enough that staged
 * bytes do not stay writable for long. The write's workflow verifies the hash
 * again before it commits, so the window is not a correctness boundary.
 */
const UPLOAD_URL_EXPIRY_SECONDS = 10 * 60;

/** `null` when the storage provider cannot sign uploads. */
export async function createMemoryWriteUploadUrls(input: {
	projectId: string;
	files: ReadonlyArray<{ bytes: number }>;
}) {
	const storage = getStorageProvider();
	if (!(storage.supportsPresignedUrls && storage.getSignedUploadUrl)) {
		return null;
	}
	const getSignedUploadUrl = storage.getSignedUploadUrl;

	const uploads = await Promise.all(
		input.files.map(async (file) => {
			const stagedKey = newMemoryWriteStagingKey(input.projectId);
			const url = await getSignedUploadUrl(stagedKey, {
				bucket: MEMORY_WRITE_STAGING_BUCKET,
				contentType: STAGED_CONTENT_TYPE,
				contentLength: file.bytes,
				expiresIn: UPLOAD_URL_EXPIRY_SECONDS,
			});
			return {
				stagedKey,
				url,
				contentType: STAGED_CONTENT_TYPE,
				bytes: file.bytes,
			};
		}),
	);
	return { expiresInSeconds: UPLOAD_URL_EXPIRY_SECONDS, uploads };
}
