import { randomUUID } from "node:crypto";
import { config } from "@repo/config";
import { logger } from "@repo/logs";
import { deleteFile, uploadFile } from "@repo/storage";

/**
 * Server-side upload of plain text into the project-context bucket.
 *
 * The existing file-upload flow (`create-context-upload-url.ts`) has the
 * CLIENT push bytes to S3 via a presigned URL, then `process-context-file`
 * runs `projectContextProcessingWorkflow`, which DOWNLOADS the object and
 * extracts it. For server-side integrations (Google Docs) we already hold
 * the exported text in memory, so we materialise it into the same bucket /
 * key convention here and let the unchanged processing workflow pick it up.
 *
 * Mirrors the key scheme in `create-context-upload-url.ts`:
 *   bucket = config.storage.bucketNames.projectContexts
 *   key    = projects/<projectId>/ctx_<uuid>.txt
 * (UUID so paths aren't enumerable from a leaked neighbour.)
 */
export async function uploadContextText(input: {
	projectId: string;
	text: string;
}): Promise<{ s3Path: string; s3Bucket: string; fileSize: number }> {
	const { projectId, text } = input;

	const s3Bucket = config.storage.bucketNames.projectContexts;
	const s3Path = `projects/${projectId}/ctx_${randomUUID()}.txt`;
	const body = Buffer.from(text, "utf-8");

	await uploadFile(s3Path, body, {
		bucket: s3Bucket,
		contentType: "text/plain",
		access: "private",
	});

	return { s3Path, s3Bucket, fileSize: body.byteLength };
}

/**
 * Best-effort cleanup for an S3 object we wrote via `uploadContextText` but
 * whose owning `ProjectContext` row never made it (or never advanced past
 * PENDING). Never throws — a missed cleanup is leaked storage, not a user-
 * facing failure.
 */
export async function deleteUploadedContextText(input: {
	s3Path: string;
	s3Bucket: string;
}): Promise<void> {
	try {
		await deleteFile(input.s3Path, { bucket: input.s3Bucket });
	} catch (error) {
		logger.warn(
			`[uploadContextText] Failed to clean up orphaned S3 object ${input.s3Bucket}/${input.s3Path}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}
