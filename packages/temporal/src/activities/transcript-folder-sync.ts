/**
 * Importing transcript files from connected OneDrive folders (Fizzy #3507).
 *
 * A folder is read with the Microsoft connection of the person who connected
 * it. Every file found is recorded once; a supported file is then copied into
 * storage as a MEETING_TRANSCRIPT context and handed to the same ingest an
 * uploaded file goes through, so the reading, the duplicate check, the digest
 * and the insights are the upload's, not a second copy of them.
 *
 * A folder that cannot be read says why on the folder and returns: the next
 * read tries again, and only a person can fix a revoked connection. A file
 * that cannot be used is skipped with a reason. Only a failure of ours throws.
 */

import { config } from "@repo/config";
import {
	canCreateProjectContexts,
	createFolderFileContext,
	db,
	getTranscriptFolder,
	getTranscriptFolderFile,
	listActiveTranscriptFolderIds,
	listPendingFolderFileIds,
	recordDiscoveredFolderFiles,
	recordTranscriptFolderRead,
	resolveOwnWorkflowIntegrationForProvider,
	setFolderFileOutcome,
	TRANSCRIPT_FOLDER_FILE_STATUS,
} from "@repo/database";
import {
	type DriveFolderItem,
	type DriveItemDownload,
	executeMicrosoftTeamsTool,
	isMicrosoftNotConnectedError,
} from "@repo/integrations/microsoft";
import { logger } from "@repo/logs";
import { deleteFile, uploadFile } from "@repo/storage";
import {
	formatSizeLimit,
	ONEDRIVE_TRANSCRIPT_PROVIDER,
	TRANSCRIPT_UPLOAD_FORMAT_LIST,
	TRANSCRIPT_UPLOAD_FORMATS,
	TRANSCRIPT_UPLOAD_MAX_BYTES,
	transcriptUploadFormatOf,
} from "@repo/utils";
import { heartbeat } from "@temporalio/activity";
import { ALREADY_ADDED } from "./meeting-transcript-upload";

const RECONNECT =
	"The Microsoft connection that reads this folder has stopped working. Reconnect the folder to keep importing from it.";
const NO_LONGER_ALLOWED =
	"The person who connected this folder can no longer add context to this project. Reconnect it as someone who can.";

/** Why a file found in a folder will not be imported, or null if it will. */
export function folderFileProblem(item: {
	name: string;
	size: number | null;
}): string | null {
	if (!transcriptUploadFormatOf(item.name)) {
		return `Not a supported transcript format. Supported formats: ${TRANSCRIPT_UPLOAD_FORMAT_LIST}.`;
	}
	if ((item.size ?? 0) > TRANSCRIPT_UPLOAD_MAX_BYTES) {
		return `Too large. ${formatSizeLimit(TRANSCRIPT_UPLOAD_MAX_BYTES)}.`;
	}
	return null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The Microsoft connection of the person who connected the folder, and theirs
 * only. The tool would otherwise fall back to a connection shared with the
 * organization, and read the folder as somebody else.
 */
async function connectorConnectionId(folder: {
	userId: string;
	organizationId: string | null;
}): Promise<string | null> {
	const own = await resolveOwnWorkflowIntegrationForProvider(
		"MICROSOFT_GRAPH",
		folder.userId,
		folder.organizationId,
	);
	return own?.id ?? null;
}

/** May this folder's connector still add context to its project? */
async function connectorMayImport(folder: {
	projectId: string;
	userId: string;
	organizationId: string | null;
}): Promise<boolean> {
	const project = await db.project.findUnique({
		where: { id: folder.projectId },
		select: { organizationId: true },
	});
	return (
		!!project &&
		project.organizationId === folder.organizationId &&
		(await canCreateProjectContexts(folder.projectId, folder.userId))
	);
}

export async function listTranscriptFoldersToSync(input: {
	projectId: string;
}): Promise<{ folderIds: string[] }> {
	return {
		folderIds: await listActiveTranscriptFolderIds(input.projectId),
	};
}

/**
 * List one folder, record what it holds, and name the files waiting to be
 * imported. Safe to repeat: a file already recorded keeps its outcome.
 */
export async function readTranscriptFolder(input: {
	folderId: string;
	/** How many waiting files to name, so a pass imports a batch. */
	limit: number;
}): Promise<{ pendingFileIds: string[] }> {
	const folder = await getTranscriptFolder(input.folderId);
	if (!folder || folder.disconnectedAt) {
		return { pendingFileIds: [] };
	}

	if (!(await connectorMayImport(folder))) {
		await recordTranscriptFolderRead({
			folderId: folder.id,
			error: NO_LONGER_ALLOWED,
		});
		return { pendingFileIds: [] };
	}

	const connectionId = await connectorConnectionId(folder);
	if (!connectionId) {
		await recordTranscriptFolderRead({
			folderId: folder.id,
			error: RECONNECT,
		});
		return { pendingFileIds: [] };
	}

	heartbeat("listing folder");
	let listing: { items: DriveFolderItem[]; truncated: boolean };
	try {
		listing = (await executeMicrosoftTeamsTool(
			"list_drive_children",
			{ driveId: folder.driveId, itemId: folder.itemId },
			folder.userId,
			folder.organizationId ?? undefined,
			connectionId,
		)) as { items: DriveFolderItem[]; truncated: boolean };
	} catch (error) {
		const message = errorMessage(error);
		logger.warn("[TranscriptFolder] Folder could not be read", {
			folderId: folder.id,
			projectId: folder.projectId,
			error: message,
		});
		await recordTranscriptFolderRead({
			folderId: folder.id,
			error: isMicrosoftNotConnectedError(message) ? RECONNECT : message,
		});
		return { pendingFileIds: [] };
	}

	// Files directly in the folder only; a nested folder is not read.
	const files = listing.items.filter((item) => !item.isFolder);
	await recordDiscoveredFolderFiles({
		folderId: folder.id,
		projectId: folder.projectId,
		userId: folder.userId,
		organizationId: folder.organizationId,
		files: files.map((item) => {
			const problem = folderFileProblem(item);
			return problem
				? {
						driveItemId: item.id,
						name: item.name,
						size: item.size,
						status: TRANSCRIPT_FOLDER_FILE_STATUS.SKIPPED,
						reason: problem,
					}
				: {
						driveItemId: item.id,
						name: item.name,
						size: item.size,
						status: TRANSCRIPT_FOLDER_FILE_STATUS.PENDING,
					};
		}),
	});
	await recordTranscriptFolderRead({
		folderId: folder.id,
		complete: !listing.truncated,
	});

	return {
		pendingFileIds: await listPendingFolderFileIds(folder.id, input.limit),
	};
}

export type ImportTranscriptFolderFileOutput =
	| {
			outcome: "ingest";
			contextId: string;
			projectId: string;
			userId: string;
			organizationId?: string;
	  }
	/** Settled here: skipped, gone, or already past this step. */
	| { outcome: "done" }
	/** Still pending, waiting on a reconnect; nothing was settled. */
	| { outcome: "waiting" };

/**
 * Copy one file into storage as a pending transcript context. A file already
 * copied returns the context it was given, so a retried step does not copy it
 * twice; one that is gone, too large or no longer wanted is settled here.
 */
export async function importTranscriptFolderFile(input: {
	fileId: string;
}): Promise<ImportTranscriptFolderFileOutput> {
	const file = await getTranscriptFolderFile(input.fileId);
	if (!file) {
		return { outcome: "done" };
	}
	const { folder } = file;
	const organizationId = folder.organizationId ?? undefined;

	if (file.contextId) {
		return {
			outcome: "ingest",
			contextId: file.contextId,
			projectId: file.projectId,
			userId: folder.userId,
			organizationId,
		};
	}
	if (
		file.status !== TRANSCRIPT_FOLDER_FILE_STATUS.PENDING &&
		file.status !== TRANSCRIPT_FOLDER_FILE_STATUS.IMPORTING
	) {
		return { outcome: "done" };
	}
	// Disconnected while it waited: it stays pending, and a reconnect resumes it.
	if (folder.disconnectedAt) {
		return { outcome: "waiting" };
	}

	// Checked again here, not only when the folder was listed: this file may
	// have waited behind others for minutes, and nothing private is read or
	// stored for someone who has since lost access.
	const owner = {
		projectId: file.projectId,
		userId: folder.userId,
		organizationId: folder.organizationId,
	};
	if (!(await connectorMayImport(owner))) {
		await recordTranscriptFolderRead({
			folderId: folder.id,
			error: NO_LONGER_ALLOWED,
		});
		return { outcome: "waiting" };
	}
	const connectionId = await connectorConnectionId(owner);
	if (!connectionId) {
		await recordTranscriptFolderRead({
			folderId: folder.id,
			error: RECONNECT,
		});
		return { outcome: "waiting" };
	}

	const format = transcriptUploadFormatOf(file.name);
	if (!format) {
		await setFolderFileOutcome({
			fileId: file.id,
			status: TRANSCRIPT_FOLDER_FILE_STATUS.SKIPPED,
			reason: folderFileProblem({ name: file.name, size: file.size }),
		});
		return { outcome: "done" };
	}

	heartbeat("downloading transcript file");
	let download: DriveItemDownload;
	try {
		download = (await executeMicrosoftTeamsTool(
			"download_drive_item",
			{
				driveId: folder.driveId,
				itemId: file.driveItemId,
				maxBytes: TRANSCRIPT_UPLOAD_MAX_BYTES,
			},
			folder.userId,
			organizationId,
			connectionId,
		)) as DriveItemDownload;
	} catch (error) {
		const message = errorMessage(error);
		if (isMicrosoftNotConnectedError(message)) {
			// The file is fine; the connection is not. It waits for a reconnect.
			await recordTranscriptFolderRead({
				folderId: folder.id,
				error: RECONNECT,
			});
			return { outcome: "waiting" };
		}
		throw error;
	}

	if (download.status === "gone") {
		await setFolderFileOutcome({
			fileId: file.id,
			status: TRANSCRIPT_FOLDER_FILE_STATUS.SKIPPED,
			reason: "Deleted from the folder before it could be imported.",
		});
		return { outcome: "done" };
	}
	if (download.status === "too_large") {
		await setFolderFileOutcome({
			fileId: file.id,
			status: TRANSCRIPT_FOLDER_FILE_STATUS.SKIPPED,
			reason: `Too large. ${formatSizeLimit(TRANSCRIPT_UPLOAD_MAX_BYTES)}.`,
		});
		return { outcome: "done" };
	}

	const contentType = TRANSCRIPT_UPLOAD_FORMATS[format];
	// Fixed per file, so a retried step writes the same object again rather
	// than leaving a copy behind. Under the project's context prefix, like an
	// upload, so storage cleanup treats both the same.
	const s3Path = `projects/${file.projectId}/ctx_folder_${file.id}.${format}`;
	const bucket = config.storage.bucketNames.projectContexts;
	heartbeat("storing transcript file");
	await uploadFile(s3Path, download.bytes, { bucket, contentType });

	const meetingSubject = file.name.replace(/\.[^/.]+$/, "");
	const { contextId } = await createFolderFileContext({
		fileId: file.id,
		projectId: file.projectId,
		s3Path,
		s3Bucket: bucket,
		originalFilename: file.name,
		mimeType: contentType,
		fileSize: download.size,
		metadata: {
			title: meetingSubject,
			provider: ONEDRIVE_TRANSCRIPT_PROVIDER,
			transcriptSource: "onedrive",
			meetingSubject,
			transcriptFolderId: folder.id,
			transcriptFolderName: folder.name,
			driveItemId: file.driveItemId,
			importedAt: new Date().toISOString(),
		},
		userId: folder.userId,
		organizationId,
	});

	logger.info("[TranscriptFolder] File copied for import", {
		fileId: file.id,
		contextId,
		projectId: file.projectId,
	});
	return {
		outcome: "ingest",
		contextId,
		projectId: file.projectId,
		userId: folder.userId,
		organizationId,
	};
}

/**
 * The last word when copying a file kept failing. Without it the file would be
 * offered again on every pass and fail again on every pass.
 */
export async function markTranscriptFolderFileFailed(input: {
	fileId: string;
}): Promise<void> {
	await setFolderFileOutcome({
		fileId: input.fileId,
		status: TRANSCRIPT_FOLDER_FILE_STATUS.FAILED,
		reason: "This file could not be copied from OneDrive. Reconnect the folder to try it again.",
	});
}

/** What the ingest made of a file, recorded on the file. */
export async function recordTranscriptFolderFileOutcome(input: {
	fileId: string;
}): Promise<void> {
	const file = await getTranscriptFolderFile(input.fileId);
	if (!file?.contextId) {
		return;
	}
	const context = await db.projectContext.findUnique({
		where: { id: file.contextId },
		select: {
			extractionStatus: true,
			extractionError: true,
			s3Path: true,
			s3Bucket: true,
		},
	});

	if (!context) {
		await setFolderFileOutcome({
			fileId: file.id,
			status: TRANSCRIPT_FOLDER_FILE_STATUS.FAILED,
			reason: "Removed from the project before it was read.",
		});
		return;
	}
	if (context.extractionStatus === "COMPLETED") {
		await setFolderFileOutcome({
			fileId: file.id,
			status: TRANSCRIPT_FOLDER_FILE_STATUS.IMPORTED,
		});
		return;
	}
	if (context.extractionStatus === "FAILED") {
		if (context.extractionError === ALREADY_ADDED) {
			// The project already has this transcript, from an upload or another
			// folder. The copy made for it is only noise on the Context tab.
			await setFolderFileOutcome({
				fileId: file.id,
				status: TRANSCRIPT_FOLDER_FILE_STATUS.DUPLICATE,
				reason: "Already in this project.",
				clearContext: true,
			});
			await db.projectContext.deleteMany({
				where: { id: file.contextId, extractionStatus: "FAILED" },
			});
			if (context.s3Path && context.s3Bucket) {
				await deleteFile(context.s3Path, {
					bucket: context.s3Bucket,
				}).catch((error: unknown) =>
					logger.warn(
						"[TranscriptFolder] Duplicate copy not deleted",
						{
							contextId: file.contextId,
							error: errorMessage(error),
						},
					),
				);
			}
			return;
		}
		await setFolderFileOutcome({
			fileId: file.id,
			status: TRANSCRIPT_FOLDER_FILE_STATUS.FAILED,
			reason: context.extractionError,
		});
	}
	// Still being read: the next pass records it.
}
