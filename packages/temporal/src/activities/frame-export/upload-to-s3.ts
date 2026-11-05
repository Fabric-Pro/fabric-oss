/**
 * Upload to S3 Activity
 *
 * Uploads the generated PDF to S3 and returns a presigned URL.
 */

import { createHash } from "node:crypto";
import { deleteFile, getSignedUrl, uploadFile } from "@repo/storage";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { isManagedFrameExportKey } from "../../lib/frame-export-contract";
import {
	type GetFrameContentInput,
	getFrameContentActivity,
} from "./get-frame-content";

const S3_BUCKET = process.env.S3_BUCKET || "fabric-exports";

export interface UploadToS3Input {
	buffer: Buffer;
	key: string;
	contentType: string;
	managed?: GetFrameContentInput & { expiresAt: string };
}

export async function uploadToS3Activity(
	input: UploadToS3Input,
): Promise<string> {
	const signal = input.managed
		? Context.current().cancellationSignal
		: undefined;
	if (input.managed) {
		assertOwnKey(input.key);
		const prefix = createHash("sha256")
			.update(JSON.stringify(input.managed.organizationId))
			.digest("hex")
			.slice(0, 32);
		if (
			!input.key.startsWith(`exports/frames-managed/${prefix}/`) ||
			!Number.isFinite(Date.parse(input.managed.expiresAt)) ||
			Date.parse(input.managed.expiresAt) <= Date.now()
		) {
			throw ApplicationFailure.nonRetryable(
				"Export expired or unavailable.",
				"FRAME_EXPORT_INVALID",
			);
		}
		await getFrameContentActivity(input.managed);
		signal?.throwIfAborted();
	}
	// Upload to S3 using the storage provider
	await uploadFile(input.key, input.buffer, {
		bucket: S3_BUCKET,
		contentType: input.contentType,
		access: "private",
	});

	signal?.throwIfAborted();
	if (input.managed) {
		return input.key;
	}
	// Legacy histories retain their original result shape; new exports never store bearer links.
	// Generate presigned URL for downloading (24 hour expiry)
	const url = await getSignedUrl(input.key, {
		bucket: S3_BUCKET,
		expiresIn: 24 * 60 * 60,
	});

	return url;
}

function assertOwnKey(key: string) {
	if (
		!isManagedFrameExportKey(key) ||
		!key.endsWith(
			`/${Context.current().info.workflowExecution?.workflowId}.pdf`,
		)
	) {
		throw ApplicationFailure.nonRetryable(
			"Invalid export storage identity.",
			"FRAME_EXPORT_INVALID",
		);
	}
}
export async function deleteFrameExportActivity(input: {
	key: string;
}): Promise<void> {
	assertOwnKey(input.key);
	await deleteFile(input.key, { bucket: S3_BUCKET });
}
