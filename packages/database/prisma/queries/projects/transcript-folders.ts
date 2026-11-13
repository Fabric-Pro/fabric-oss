/**
 * Database queries for OneDrive transcript folders (Fizzy #3507).
 *
 * A connected folder is read with the Microsoft connection of the person who
 * connected it. Each file found there gets one row, keyed by folder and drive
 * item, so a second read, a reconnect or a retry finds the row and does not
 * import the file again. What a file became is the row's status.
 *
 * NOTE: like `meeting-transcripts.ts`, these are called from procedures that
 * have already authorized the project and from Temporal activities, so tenant
 * filtering is not applied here.
 */

import { db, type Prisma } from "../../client";

export const TRANSCRIPT_FOLDER_FILE_STATUS = {
	PENDING: "PENDING",
	IMPORTING: "IMPORTING",
	IMPORTED: "IMPORTED",
	DUPLICATE: "DUPLICATE",
	SKIPPED: "SKIPPED",
	FAILED: "FAILED",
} as const;

export type TranscriptFolderFileStatus =
	(typeof TRANSCRIPT_FOLDER_FILE_STATUS)[keyof typeof TRANSCRIPT_FOLDER_FILE_STATUS];

/** How many skipped or failed files a folder lists by name. */
const PROBLEM_FILES_SHOWN = 5;

/** The largest size the INTEGER column holds. */
const MAX_STORED_SIZE = 2_147_483_647;

export interface TranscriptFolderSelection {
	driveId: string;
	itemId: string;
	name: string;
	webUrl?: string | null;
}

/**
 * Connect folders to a project, or reconnect them.
 *
 * A folder connected before keeps its file rows, so reconnecting does not
 * import what was already imported. It is read again as the person
 * reconnecting it, from scratch, which is what repairs a folder whose
 * connection had stopped working. A file that could not be copied is offered
 * again, which is the retry the card asks for; one that was copied and could
 * not be read is not, since its context already says why.
 */
export async function connectTranscriptFolders(params: {
	projectId: string;
	userId: string;
	organizationId?: string;
	folders: TranscriptFolderSelection[];
}) {
	const connected = await db.$transaction(
		params.folders.map((folder) =>
			db.projectTranscriptFolder.upsert({
				where: {
					projectId_driveId_itemId: {
						projectId: params.projectId,
						driveId: folder.driveId,
						itemId: folder.itemId,
					},
				},
				create: {
					projectId: params.projectId,
					driveId: folder.driveId,
					itemId: folder.itemId,
					name: folder.name,
					webUrl: folder.webUrl ?? null,
					userId: params.userId,
					organizationId: params.organizationId,
				},
				update: {
					name: folder.name,
					webUrl: folder.webUrl ?? null,
					userId: params.userId,
					disconnectedAt: null,
					lastSyncError: null,
					discoveredAt: null,
				},
				select: { id: true },
			}),
		),
	);
	await db.projectTranscriptFolderFile.updateMany({
		where: {
			folderId: { in: connected.map((folder) => folder.id) },
			status: TRANSCRIPT_FOLDER_FILE_STATUS.FAILED,
			contextId: null,
		},
		data: {
			status: TRANSCRIPT_FOLDER_FILE_STATUS.PENDING,
			reason: null,
		},
	});
	return connected;
}

/**
 * Stop reading a folder. What it supplied stays, as the card asks: the
 * transcripts and their file rows are left alone.
 */
export async function disconnectTranscriptFolder(params: {
	projectId: string;
	folderId: string;
}): Promise<boolean> {
	const result = await db.projectTranscriptFolder.updateMany({
		where: {
			id: params.folderId,
			projectId: params.projectId,
			disconnectedAt: null,
		},
		data: { disconnectedAt: new Date() },
	});
	return result.count > 0;
}

/** A project's connected folders with where their files stand. */
export async function listTranscriptFolders(projectId: string) {
	const folders = await db.projectTranscriptFolder.findMany({
		where: { projectId, disconnectedAt: null },
		orderBy: { connectedAt: "asc" },
		select: {
			id: true,
			driveId: true,
			itemId: true,
			name: true,
			webUrl: true,
			connectedAt: true,
			lastSyncAt: true,
			lastSyncError: true,
			discoveredAt: true,
			userId: true,
			user: { select: { name: true } },
		},
	});
	if (folders.length === 0) {
		return [];
	}

	const folderIds = folders.map((folder) => folder.id);
	const [counts, problems] = await Promise.all([
		db.projectTranscriptFolderFile.groupBy({
			by: ["folderId", "status"],
			where: { folderId: { in: folderIds } },
			_count: { _all: true },
		}),
		db.projectTranscriptFolderFile.findMany({
			where: {
				folderId: { in: folderIds },
				status: {
					in: [
						TRANSCRIPT_FOLDER_FILE_STATUS.SKIPPED,
						TRANSCRIPT_FOLDER_FILE_STATUS.FAILED,
						TRANSCRIPT_FOLDER_FILE_STATUS.DUPLICATE,
					],
				},
			},
			orderBy: { updatedAt: "desc" },
			select: {
				folderId: true,
				name: true,
				status: true,
				reason: true,
			},
		}),
	]);

	return folders.map((folder) => {
		const byStatus = (status: TranscriptFolderFileStatus) =>
			counts.find(
				(row) => row.folderId === folder.id && row.status === status,
			)?._count._all ?? 0;
		const imported = byStatus(TRANSCRIPT_FOLDER_FILE_STATUS.IMPORTED);
		const duplicate = byStatus(TRANSCRIPT_FOLDER_FILE_STATUS.DUPLICATE);
		const skipped = byStatus(TRANSCRIPT_FOLDER_FILE_STATUS.SKIPPED);
		const failed = byStatus(TRANSCRIPT_FOLDER_FILE_STATUS.FAILED);
		const inProgress =
			byStatus(TRANSCRIPT_FOLDER_FILE_STATUS.PENDING) +
			byStatus(TRANSCRIPT_FOLDER_FILE_STATUS.IMPORTING);
		return {
			id: folder.id,
			// What a reconnect sends back.
			driveId: folder.driveId,
			itemId: folder.itemId,
			name: folder.name,
			webUrl: folder.webUrl,
			connectedAt: folder.connectedAt,
			connectedByName: folder.user.name,
			lastSyncAt: folder.lastSyncAt,
			lastSyncError: folder.lastSyncError,
			/** False while the folder has not been listed in full yet. */
			discoveryComplete: folder.discoveredAt !== null,
			counts: {
				discovered:
					imported + duplicate + skipped + failed + inProgress,
				imported,
				// A file the project already had is not imported twice, and says so.
				skipped: skipped + duplicate,
				failed,
				inProgress,
			},
			problems: problems
				.filter((file) => file.folderId === folder.id)
				.slice(0, PROBLEM_FILES_SHOWN)
				.map((file) => ({
					name: file.name,
					status: file.status,
					reason: file.reason,
				})),
		};
	});
}

/** The folders a sync should read now. */
export async function listActiveTranscriptFolderIds(
	projectId: string,
): Promise<string[]> {
	const folders = await db.projectTranscriptFolder.findMany({
		where: { projectId, disconnectedAt: null },
		orderBy: { connectedAt: "asc" },
		select: { id: true },
	});
	return folders.map((folder) => folder.id);
}

export async function getTranscriptFolder(folderId: string) {
	return await db.projectTranscriptFolder.findUnique({
		where: { id: folderId },
		select: {
			id: true,
			projectId: true,
			driveId: true,
			itemId: true,
			name: true,
			disconnectedAt: true,
			userId: true,
			organizationId: true,
		},
	});
}

/** The outcome of reading a folder, for its admins to see. */
export async function recordTranscriptFolderRead(params: {
	folderId: string;
	error?: string;
	/** The read listed the whole folder, not just its first pages. */
	complete?: boolean;
}) {
	const now = new Date();
	await db.projectTranscriptFolder.update({
		where: { id: params.folderId },
		data: params.error
			? { lastSyncError: params.error }
			: {
					lastSyncAt: now,
					lastSyncError: null,
					...(params.complete ? { discoveredAt: now } : {}),
				},
	});
}

/**
 * Record the files a read found. A file already recorded is left as it is,
 * whatever it became, which is what makes a read safe to repeat.
 */
export async function recordDiscoveredFolderFiles(params: {
	folderId: string;
	projectId: string;
	userId: string;
	organizationId?: string | null;
	files: Array<{
		driveItemId: string;
		name: string;
		size: number | null;
		status:
			| typeof TRANSCRIPT_FOLDER_FILE_STATUS.PENDING
			| typeof TRANSCRIPT_FOLDER_FILE_STATUS.SKIPPED;
		reason?: string;
	}>;
}) {
	if (params.files.length === 0) {
		return;
	}
	await db.projectTranscriptFolderFile.createMany({
		data: params.files.map((file) => ({
			folderId: params.folderId,
			projectId: params.projectId,
			driveItemId: file.driveItemId,
			name: file.name,
			// A recording can be larger than the column holds. The size is only
			// shown, and such a file is skipped anyway, so it is left out rather
			// than failing the whole folder's write.
			size:
				file.size !== null && file.size <= MAX_STORED_SIZE
					? file.size
					: null,
			status: file.status,
			reason: file.reason ?? null,
			userId: params.userId,
			organizationId: params.organizationId ?? null,
		})),
		skipDuplicates: true,
	});
}

/** Files of a still-connected folder that are waiting to be imported. */
export async function listPendingFolderFileIds(
	folderId: string,
	limit: number,
): Promise<string[]> {
	const files = await db.projectTranscriptFolderFile.findMany({
		where: {
			folderId,
			status: {
				in: [
					TRANSCRIPT_FOLDER_FILE_STATUS.PENDING,
					TRANSCRIPT_FOLDER_FILE_STATUS.IMPORTING,
				],
			},
			folder: { disconnectedAt: null },
		},
		orderBy: { createdAt: "asc" },
		take: limit,
		select: { id: true },
	});
	return files.map((file) => file.id);
}

export async function getTranscriptFolderFile(fileId: string) {
	return await db.projectTranscriptFolderFile.findUnique({
		where: { id: fileId },
		select: {
			id: true,
			projectId: true,
			driveItemId: true,
			name: true,
			size: true,
			status: true,
			contextId: true,
			folder: {
				select: {
					id: true,
					name: true,
					driveId: true,
					disconnectedAt: true,
					userId: true,
					organizationId: true,
				},
			},
		},
	});
}

/**
 * Create the context a file is imported into and record it on the file, in one
 * transaction. Apart, a crash between the two left a context nothing pointed
 * at, and the retry made a second one. The file is claimed only while it has
 * no context, so of two attempts only one creates it; the other gets the
 * context the first made.
 */
export async function createFolderFileContext(params: {
	fileId: string;
	projectId: string;
	s3Path: string;
	s3Bucket: string;
	originalFilename: string;
	mimeType: string;
	fileSize: number;
	metadata: Prisma.InputJsonValue;
	userId: string;
	organizationId?: string;
}): Promise<{ contextId: string }> {
	try {
		return await db.$transaction(async (tx) => {
			const context = await tx.projectContext.create({
				data: {
					projectId: params.projectId,
					type: "MEETING_TRANSCRIPT",
					content: "",
					s3Path: params.s3Path,
					s3Bucket: params.s3Bucket,
					originalFilename: params.originalFilename,
					mimeType: params.mimeType,
					fileSize: params.fileSize,
					extractionStatus: "PENDING",
					metadata: params.metadata,
					userId: params.userId,
					organizationId: params.organizationId,
				},
				select: { id: true },
			});
			await tx.projectTranscriptFolderFile.update({
				where: { id: params.fileId, contextId: null },
				data: {
					contextId: context.id,
					status: TRANSCRIPT_FOLDER_FILE_STATUS.IMPORTING,
				},
			});
			return { contextId: context.id };
		});
	} catch (error) {
		// Another attempt attached its context first; this one rolled back.
		if ((error as { code?: string } | null)?.code === "P2025") {
			const file = await db.projectTranscriptFolderFile.findUnique({
				where: { id: params.fileId },
				select: { contextId: true },
			});
			if (file?.contextId) {
				return { contextId: file.contextId };
			}
		}
		throw error;
	}
}

export async function setFolderFileOutcome(params: {
	fileId: string;
	status: Exclude<
		TranscriptFolderFileStatus,
		| typeof TRANSCRIPT_FOLDER_FILE_STATUS.PENDING
		| typeof TRANSCRIPT_FOLDER_FILE_STATUS.IMPORTING
	>;
	reason?: string | null;
	/** The context made for the file was removed again. */
	clearContext?: boolean;
}) {
	await db.projectTranscriptFolderFile.update({
		where: { id: params.fileId },
		data: {
			status: params.status,
			reason: params.reason ?? null,
			...(params.clearContext ? { contextId: null } : {}),
		},
	});
}
