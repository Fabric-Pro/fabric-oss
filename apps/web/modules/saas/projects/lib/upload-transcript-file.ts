/**
 * Sending one transcript file to a project (Fizzy #1877): ask whether it is
 * wanted, send it, then have the server read it.
 */

import {
	formatSizeLimit,
	TRANSCRIPT_UPLOAD_FORMAT_LIST,
	TRANSCRIPT_UPLOAD_MAX_BYTES,
	transcriptUploadFormatOf,
} from "@repo/utils";
import { orpcClient } from "@shared/lib/orpc-client";

export type TranscriptUploadOutcome =
	| { status: "started" }
	| { status: "reprocessing" }
	| {
			status: "duplicate";
			meetingSubject: string | null;
			addedAt: Date;
	  };

/** What is wrong with a file before anything is sent, or null if nothing is. */
export function transcriptFileProblem(
	file: Pick<File, "name" | "size">,
): string | null {
	if (!transcriptUploadFormatOf(file.name)) {
		return `${file.name} can't be added. Supported formats: ${TRANSCRIPT_UPLOAD_FORMAT_LIST}.`;
	}
	if (file.size > TRANSCRIPT_UPLOAD_MAX_BYTES) {
		return `${file.name} is too large. ${formatSizeLimit(TRANSCRIPT_UPLOAD_MAX_BYTES)}.`;
	}
	return null;
}

async function sha256Hex(file: Blob): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		await file.arrayBuffer(),
	);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function uploadTranscriptFile(params: {
	file: File;
	projectId: string;
	organizationId: string | null;
	reprocess?: boolean;
}): Promise<TranscriptUploadOutcome> {
	const { file, projectId, organizationId, reprocess } = params;

	const answer =
		await orpcClient.projects.meetingTranscriptSync.createUploadUrl({
			projectId,
			organizationId,
			filename: file.name,
			size: file.size,
			contentSha256: await sha256Hex(file),
			...(reprocess ? { reprocess } : {}),
		});
	if (answer.status !== "upload") {
		return answer;
	}

	const { contextId, signedUploadUrl, contentType } = answer;
	// `fetch` rejects on a dropped connection rather than returning a response,
	// and that has to end in the same clean-up as a refused upload.
	const sent = signedUploadUrl
		? await fetch(signedUploadUrl, {
				method: "PUT",
				body: file,
				headers: { "Content-Type": contentType },
			}).catch(() => null)
		: null;
	if (!sent?.ok) {
		// The row was created for a file that never arrived, and nothing would
		// ever finish it. Best effort: the failure to report is the upload.
		await orpcClient.projects.contexts
			.delete({ id: contextId, projectId })
			.catch(() => undefined);
		throw new Error(
			signedUploadUrl
				? `${file.name} could not be uploaded.`
				: "Storage provider does not support direct uploads for project contexts",
		);
	}

	await orpcClient.projects.meetingTranscriptSync.startUploadIngest({
		projectId,
		organizationId,
		contextId,
	});
	return { status: "started" };
}
