/**
 * Turning an uploaded transcript file into a transcript (Fizzy #1877).
 *
 * The upload itself already happened: the browser put the file in storage and a
 * MEETING_TRANSCRIPT context row is waiting for it. This reads the file and
 * files it exactly where the Teams sync files a transcript, so the digest,
 * insights and action items need nothing of their own.
 *
 * A file that cannot be used is the user's to fix, so it fails the row with a
 * reason and returns. Only a failure of ours throws, which Temporal retries.
 * Starting the pipelines is a step of its own, so a crash after the transcript
 * is stored retries that step instead of finding the work done and skipping it.
 */

import { createHash } from "node:crypto";
import {
	canCreateProjectContexts,
	createUploadedTranscript,
	db,
	findUploadedTranscript,
	UPLOADED_TRANSCRIPT_PROVIDER,
	updateContextExtractionStatus,
	uploadedTranscriptKeys,
} from "@repo/database";
import { contextContentHashOrNull } from "@repo/database/prisma/queries/projects/context-content-hash";
import { logger } from "@repo/logs";
import { LocalDocxExtractor } from "@repo/rag";
import { downloadFile } from "@repo/storage";
import {
	formatSizeLimit,
	ONEDRIVE_TRANSCRIPT_PROVIDER,
	TRANSCRIPT_UPLOAD_FORMAT_LIST,
	TRANSCRIPT_UPLOAD_MAX_BYTES,
	transcriptUploadFormatOf,
} from "@repo/utils";
import { heartbeat } from "@temporalio/activity";
import { sanitizeTextForStorage } from "./lib/context-file-text";
import {
	formatTranscriptHeader,
	startTranscriptPipelines,
} from "./lib/meeting-transcript-pipelines";
import {
	decodeTranscriptBytes,
	type ParsedTranscript,
	parsePlainTranscript,
	parseVttTranscript,
} from "./lib/transcript-file-text";
import { inferMeetingDate } from "./lib/transcript-meeting-date";
import {
	summarizeTranscript,
	TRANSCRIPT_SUMMARIZATION_THRESHOLD,
} from "./meeting-transcript-sync";

export const ALREADY_ADDED =
	"This file has already been added to this project.";
const NO_LONGER_ALLOWED =
	"This transcript was not added: you no longer have access to add context to this project.";
const INGEST_FAILED =
	"This transcript could not be processed. Remove it and try again.";

export interface IngestUploadedTranscriptInput {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
}

export interface IngestUploadedTranscriptOutput {
	outcome: "ingested" | "duplicate" | "rejected";
	transcriptRecordId?: string;
}

interface ReadTranscript extends ParsedTranscript {
	unreadableParts: number;
}

async function rejectUpload(
	contextId: string,
	reason: string,
): Promise<IngestUploadedTranscriptOutput> {
	await updateContextExtractionStatus(contextId, "FAILED", {
		extractionError: reason,
	});
	return { outcome: "rejected" };
}

async function reportDuplicate(
	contextId: string,
	transcriptRecordId?: string,
): Promise<IngestUploadedTranscriptOutput> {
	await updateContextExtractionStatus(contextId, "FAILED", {
		extractionError: ALREADY_ADDED,
	});
	return { outcome: "duplicate", transcriptRecordId };
}

function isUniqueViolation(error: unknown): boolean {
	return (error as { code?: string } | null)?.code === "P2002";
}

function readTextFile(bytes: Buffer, format: "txt" | "vtt"): ReadTranscript {
	const decoded = decodeTranscriptBytes(bytes);
	const text = sanitizeTextForStorage(decoded.text);
	const parsed =
		format === "vtt"
			? parseVttTranscript(text)
			: parsePlainTranscript(text);
	return {
		...parsed,
		unreadableParts: parsed.unreadableLines + decoded.unreadableCharacters,
	};
}

/**
 * The extractor itself rather than the factory: the factory reads provider
 * settings from the database first, which would make a brief database failure
 * look like a broken file and reject a good upload for good.
 */
async function readWordFile(
	bytes: Buffer,
	filename: string,
): Promise<ReadTranscript> {
	const extraction = await new LocalDocxExtractor().extract(bytes, filename);
	const parsed = parsePlainTranscript(
		sanitizeTextForStorage(extraction.text),
	);
	return { ...parsed, unreadableParts: 0 };
}

export async function ingestUploadedTranscript(
	input: IngestUploadedTranscriptInput,
): Promise<IngestUploadedTranscriptOutput> {
	const { contextId, projectId, userId, organizationId } = input;

	const context = await db.projectContext.findFirst({
		where: { id: contextId, projectId, type: "MEETING_TRANSCRIPT" },
		select: {
			s3Path: true,
			s3Bucket: true,
			originalFilename: true,
			extractionStatus: true,
			createdAt: true,
			metadata: true,
		},
	});
	if (!context?.s3Path || !context.s3Bucket || !context.originalFilename) {
		throw new Error(`No uploaded transcript file for context ${contextId}`);
	}
	if (context.extractionStatus === "COMPLETED") {
		const stored = await db.projectMeetingTranscript.findFirst({
			where: { projectId, contextId },
			select: { id: true },
		});
		return { outcome: "ingested", transcriptRecordId: stored?.id };
	}

	// The job can wait in a queue. It acts for this person now, not for who
	// they were when they pressed the button.
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true },
	});
	if (
		!project ||
		(project.organizationId ?? undefined) !== organizationId ||
		!(await canCreateProjectContexts(projectId, userId))
	) {
		return await rejectUpload(contextId, NO_LONGER_ALLOWED);
	}

	const format = transcriptUploadFormatOf(context.originalFilename);
	if (!format) {
		return await rejectUpload(
			contextId,
			`Unsupported file type. Supported formats: ${TRANSCRIPT_UPLOAD_FORMAT_LIST}.`,
		);
	}

	heartbeat("downloading transcript file");
	const { data: bytes } = await downloadFile(context.s3Path, {
		bucket: context.s3Bucket,
	});

	// The size was checked when the upload was requested, against what the
	// browser said. These are the bytes that actually arrived.
	if (bytes.length > TRANSCRIPT_UPLOAD_MAX_BYTES) {
		return await rejectUpload(
			contextId,
			`This file is too large. ${formatSizeLimit(TRANSCRIPT_UPLOAD_MAX_BYTES)}.`,
		);
	}

	const contentSha256 = createHash("sha256").update(bytes).digest("hex");
	const existing = await findUploadedTranscript(projectId, contentSha256);
	if (existing) {
		return await reportDuplicate(contextId, existing.id);
	}

	heartbeat("reading transcript file");
	let transcript: ReadTranscript;
	if (format === "docx") {
		try {
			transcript = await readWordFile(bytes, context.originalFilename);
		} catch (error) {
			logger.warn("[TranscriptUpload] Word file could not be read", {
				contextId,
				error: error instanceof Error ? error.message : String(error),
			});
			return await rejectUpload(
				contextId,
				"This Word file could not be opened.",
			);
		}
	} else {
		transcript = readTextFile(bytes, format);
	}

	if (transcript.text.trim().length === 0) {
		return await rejectUpload(contextId, "There is no text in this file.");
	}

	const metadata = (context.metadata ?? {}) as Record<string, unknown>;
	const meetingSubject =
		typeof metadata.meetingSubject === "string"
			? metadata.meetingSubject
			: context.originalFilename;
	const { meetingId, transcriptId } = uploadedTranscriptKeys(contentSha256);
	// A file someone uploads is dated by the upload, as it always was. A file
	// from a folder may be a year old: its date comes from the file, or stays
	// unknown, and never from the day it was imported (#3507).
	const fromFolder = metadata.provider === ONEDRIVE_TRANSCRIPT_PROVIDER;
	const meetingDate = fromFolder
		? inferMeetingDate({
				filename: context.originalFilename,
				text: transcript.text,
			})
		: context.createdAt;
	const header = formatTranscriptHeader({
		meetingSubject,
		formattedDate: meetingDate
			? meetingDate.toLocaleString()
			: "Unknown date",
		speakerNames: transcript.speakerNames,
	});
	const content = `${header}${transcript.text}`;

	// Alongside the transcript, as for Teams: the body is always kept whole.
	heartbeat("processing transcript content");
	const summary =
		content.length > TRANSCRIPT_SUMMARIZATION_THRESHOLD
			? ((await summarizeTranscript(
					transcript.text,
					meetingSubject,
					userId,
					organizationId,
					projectId,
				)) ?? undefined)
			: undefined;

	let stored: Awaited<ReturnType<typeof createUploadedTranscript>>;
	try {
		stored = await createUploadedTranscript({
			projectId,
			contextId,
			contentSha256,
			meetingSubject,
			meetingDate,
			content,
			contentHash: contextContentHashOrNull(content),
			sourceTitle: `Meeting Transcript: ${meetingSubject}`,
			metadata: {
				...metadata,
				provider: fromFolder
					? ONEDRIVE_TRANSCRIPT_PROVIDER
					: UPLOADED_TRANSCRIPT_PROVIDER,
				meetingId,
				transcriptId,
				meetingSubject,
				meetingDate: meetingDate ? meetingDate.toISOString() : null,
				speakerNames: transcript.speakerNames,
				wasSummarized: false,
				transcriptSource: fromFolder ? "onedrive" : "upload",
				...(transcript.unreadableParts > 0
					? { unreadableParts: transcript.unreadableParts }
					: {}),
			},
			speakerNames: transcript.speakerNames,
			summary,
			userId,
			organizationId,
		});
	} catch (error) {
		// The same file, finishing at the same moment.
		if (isUniqueViolation(error)) {
			return await reportDuplicate(contextId);
		}
		throw error;
	}

	logger.info("[TranscriptUpload] Transcript stored", {
		contextId,
		projectId,
		contentLength: content.length,
	});
	return {
		outcome: "ingested",
		transcriptRecordId: stored.transcriptRecordId,
	};
}

/**
 * Embedding, analysis and insights for a stored upload. Reads back what was
 * stored, so the transcript body stays out of the workflow's input. Every start
 * can safely run again, which is what makes this step retryable.
 */
export async function startUploadedTranscriptPipelines(input: {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
	transcriptRecordId: string;
}): Promise<void> {
	const { contextId, projectId, userId, organizationId } = input;

	const transcript = await db.projectMeetingTranscript.findFirst({
		where: { id: input.transcriptRecordId, projectId, contextId },
		select: {
			id: true,
			linkedMeetingId: true,
			meetingId: true,
			transcriptId: true,
			meetingSubject: true,
			meetingDate: true,
		},
	});
	const context = await db.projectContext.findFirst({
		where: { id: contextId, projectId },
		select: { content: true, metadata: true },
	});
	// Removed while it waited, which is the user's call, not a failure.
	if (!transcript || !context) {
		return;
	}
	const provider =
		(context.metadata as { provider?: unknown } | null)?.provider ===
		ONEDRIVE_TRANSCRIPT_PROVIDER
			? ONEDRIVE_TRANSCRIPT_PROVIDER
			: UPLOADED_TRANSCRIPT_PROVIDER;

	await startTranscriptPipelines({
		projectId,
		userId,
		organizationId,
		transcriptRecordId: transcript.id,
		contextId,
		linkedMeetingId: transcript.linkedMeetingId,
		meetingId: transcript.meetingId,
		transcriptId: transcript.transcriptId,
		meetingSubject: transcript.meetingSubject ?? "Uploaded transcript",
		meetingDate: transcript.meetingDate?.toISOString(),
		transcriptText: context.content,
		provider,
		embeddingWorkflowId: `context-embedding-${contextId}-upload`,
	});
}

/**
 * The last word when the attempts ran out on a failure of ours. Without it the
 * row would sit in EXTRACTING with nothing telling the user it had stopped.
 */
export async function markUploadedTranscriptFailed(input: {
	contextId: string;
}): Promise<void> {
	await updateContextExtractionStatus(input.contextId, "FAILED", {
		extractionError: INGEST_FAILED,
	});
}
