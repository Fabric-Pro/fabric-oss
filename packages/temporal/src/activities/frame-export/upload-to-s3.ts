/**
 * Upload to S3 Activity
 *
 * Uploads the generated PDF to S3 and returns a presigned URL.
 */

import { getSignedUrl, uploadFile } from "@repo/storage";

const S3_BUCKET = process.env.S3_BUCKET || "fabric-exports";

export interface UploadToS3Input {
	buffer: Buffer;
	key: string;
	contentType: string;
}

export async function uploadToS3Activity(
	input: UploadToS3Input,
): Promise<string> {
	// Upload to S3 using the storage provider
	await uploadFile(input.key, input.buffer, {
		bucket: S3_BUCKET,
		contentType: input.contentType,
	});

	// Generate presigned URL for downloading (24 hour expiry)
	const url = await getSignedUrl(input.key, {
		bucket: S3_BUCKET,
		expiresIn: 24 * 60 * 60,
	});

	return url;
}
