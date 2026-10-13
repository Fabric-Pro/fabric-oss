/**
 * Signs the original uploaded object of a Class A context — a project context
 * or a company context source — for a single download, under the filename it
 * was uploaded with.
 *
 * The object is checked before it is signed. A presigned URL is issued without
 * contacting storage, so a key whose object has gone would hand the browser a
 * storage error page saved under the user's filename, and nothing on the server
 * would record that an original was lost. The check turns that into a logged
 * `CONTENT_UNAVAILABLE` the caller can show, and a check storage did not
 * answer into a retriable `SERVICE_UNAVAILABLE` rather than either verdict.
 */

import { ORPCError } from "@orpc/server";
import { logger } from "@repo/logs";
import { getFileMetadata, getSignedUrl } from "@repo/storage";
import { buildContentDisposition } from "@repo/utils/attachment";
import { SINGLE_PRESIGN_EXPIRY_SECONDS } from "../procedures/contexts/constants";

/**
 * How long the existence check may take. The shared S3 client sets no request
 * timeout, so without a bound a stalled HEAD would hold every original download
 * open; a check that has not answered by then is treated as unanswered.
 */
const ORIGINAL_FILE_CHECK_TIMEOUT_MS = 5_000;

export async function signOriginalContextFile(args: {
	s3Path: string;
	bucket: string;
	filename: string;
	mimeType?: string | null;
	/** Names the row in the warning a missing object logs, e.g. `context ctx_1`. */
	logLabel: string;
}): Promise<string> {
	const { s3Path, bucket, filename, mimeType, logLabel } = args;

	let found: boolean;
	// The deadline cancels the HEAD request itself, so a stalled one does not
	// keep holding a storage connection after the caller has been answered.
	// The race settles the wait even if a provider ignores the signal.
	const deadline = new AbortController();
	const timer = setTimeout(
		() =>
			deadline.abort(
				new Error(
					`no answer within ${ORIGINAL_FILE_CHECK_TIMEOUT_MS} ms`,
				),
			),
		ORIGINAL_FILE_CHECK_TIMEOUT_MS,
	);
	try {
		const head = await Promise.race([
			getFileMetadata(s3Path, { bucket, abortSignal: deadline.signal }),
			new Promise<never>((_, reject) => {
				deadline.signal.addEventListener(
					"abort",
					() => reject(deadline.signal.reason),
					{ once: true },
				);
			}),
		]);
		found = head !== null;
	} catch (err) {
		// An unanswered check is neither "missing" nor "present". It is not
		// reported as missing, since nothing confirmed that. It is not signed
		// either: the HEAD needs the same read access the download does, so a
		// refused or failed HEAD predicts a refused download, and signing anyway
		// would hand back the storage error page this check exists to prevent.
		// The caller gets a retriable error instead.
		logger.warn(
			`[ContextDownload] Could not confirm the original file of ${logLabel} exists (${bucket}/${s3Path}): ${err instanceof Error ? err.message : String(err)}`,
		);
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: "Storage could not be reached to fetch the original file",
			cause: err,
		});
	} finally {
		clearTimeout(timer);
	}
	if (!found) {
		logger.warn(
			`[ContextDownload] The original file of ${logLabel} is missing from storage (${bucket}/${s3Path})`,
		);
		throw new ORPCError("BAD_REQUEST", {
			message: "The original file is no longer in storage",
			data: { code: "CONTENT_UNAVAILABLE" },
		});
	}

	try {
		return await getSignedUrl(s3Path, {
			bucket,
			expiresIn: SINGLE_PRESIGN_EXPIRY_SECONDS,
			responseContentDisposition: buildContentDisposition(filename),
			responseContentType: mimeType ?? undefined,
		});
	} catch (err) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: "Failed to generate download URL",
			cause: err,
		});
	}
}
