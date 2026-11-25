/**
 * Importing a folder's files, recording what each import came to, and
 * releasing the contexts the deletion follow-up removed.
 */

import { contextUploadConfigFor, resolveContextUploadMime } from "@repo/utils";
import { db, type Prisma } from "../../../client";
import {
	DOCUMENT_FOLDER_CONTEXT_PROVIDER,
	DOCUMENT_FOLDER_DELETIONS_PER_PASS,
	DOCUMENT_FOLDER_FILE_STATUS,
	DOCUMENT_FOLDER_SKIP_CODE,
	type DocumentFolderFailureCode,
	type DocumentFolderFileStatus,
	type DocumentFolderProvider,
} from "./constants";
import { classifyDocumentFolderFile, toNumberOrNull } from "./helpers";
import { fileWriteWhere } from "./write-conditions";

/** Files of a connected folder waiting to be imported, newest first. */
export async function listPendingDocumentFolderFileIds(params: {
	folderId: string;
	limit: number;
}): Promise<string[]> {
	const files = await db.projectDocumentFolderFile.findMany({
		where: {
			folderId: params.folderId,
			retiredAt: null,
			status: {
				in: [
					DOCUMENT_FOLDER_FILE_STATUS.PENDING,
					DOCUMENT_FOLDER_FILE_STATUS.IMPORTING,
				],
			},
			folder: { disconnectedAt: null },
		},
		orderBy: [{ sourceModifiedAt: "desc" }, { id: "asc" }],
		take: params.limit,
		select: { id: true },
	});
	return files.map((file) => file.id);
}

/** A file with what importing it needs. Size is a number, not a BigInt. */
export async function getDocumentFolderFileForImport(fileId: string) {
	const file = await db.projectDocumentFolderFile.findUnique({
		where: { id: fileId },
		select: {
			id: true,
			folderId: true,
			projectId: true,
			driveItemId: true,
			name: true,
			relativePath: true,
			size: true,
			status: true,
			contextId: true,
			latestVersion: true,
			importedVersion: true,
			retiredAt: true,
			folder: {
				select: {
					id: true,
					provider: true,
					driveId: true,
					userId: true,
					organizationId: true,
					disconnectedAt: true,
				},
			},
		},
	});
	if (!file) {
		return null;
	}
	return {
		...file,
		size: toNumberOrNull(file.size),
		status: file.status as DocumentFolderFileStatus,
	};
}

/**
 * Claim a pending file for import, recording the version being imported. A
 * claim that crashed before its context was made can be taken again.
 */
export async function claimDocumentFolderFile(params: {
	fileId: string;
	version: string;
}): Promise<boolean> {
	const result = await db.projectDocumentFolderFile.updateMany({
		where: fileWriteWhere({
			fileId: params.fileId,
			status: [
				DOCUMENT_FOLDER_FILE_STATUS.PENDING,
				DOCUMENT_FOLDER_FILE_STATUS.IMPORTING,
			],
			contextId: null,
		}),
		data: {
			status: DOCUMENT_FOLDER_FILE_STATUS.IMPORTING,
			importedVersion: params.version,
			failureCode: null,
			skipCode: null,
		},
	});
	return result.count > 0;
}

class ClaimLostError extends Error {}

/**
 * Create the context a claimed file is imported into and attach it to the
 * row, in one transaction, so a crash between the two leaves no context that
 * nothing points at. The context is typed by the upload vocabulary, carries
 * the folder, item and path in its metadata, and gets the file's saved own
 * guidance back. Of two attempts only one attaches; the other gets the
 * context the first made.
 */
export async function createDocumentFolderFileContext(params: {
	fileId: string;
	s3Path: string;
	s3Bucket: string;
	originalFilename: string;
	mimeType: string;
	fileSize: number;
}): Promise<
	| { status: "created" | "existing"; contextId: string }
	| { status: "not_claimable" }
	| { status: "unsupported" }
> {
	const where = fileWriteWhere({
		fileId: params.fileId,
		status: DOCUMENT_FOLDER_FILE_STATUS.IMPORTING,
		contextId: null,
	});
	const resolvedMime = resolveContextUploadMime(
		params.mimeType,
		params.originalFilename,
	);
	const config = contextUploadConfigFor(resolvedMime);
	if (!config) {
		return { status: "unsupported" };
	}

	try {
		const created = await db.$transaction(async (tx) => {
			const file = await tx.projectDocumentFolderFile.findFirst({
				where,
				select: {
					id: true,
					projectId: true,
					folderId: true,
					driveItemId: true,
					relativePath: true,
					savedSourceType: true,
					savedAiInstructions: true,
					folder: {
						select: {
							provider: true,
							userId: true,
							organizationId: true,
						},
					},
				},
			});
			if (!file) {
				return null;
			}
			const provider =
				DOCUMENT_FOLDER_CONTEXT_PROVIDER[
					file.folder.provider as DocumentFolderProvider
				];
			if (!provider) {
				throw new Error(
					`Unknown document folder provider: ${file.folder.provider}`,
				);
			}
			const context = await tx.projectContext.create({
				data: {
					projectId: file.projectId,
					type: config.type,
					content: "",
					s3Path: params.s3Path,
					s3Bucket: params.s3Bucket,
					originalFilename: params.originalFilename,
					mimeType: resolvedMime,
					fileSize: params.fileSize,
					extractionStatus: "PENDING",
					metadata: {
						provider,
						folderId: file.folderId,
						driveItemId: file.driveItemId,
						relativePath: file.relativePath,
					},
					sourceType: file.savedSourceType,
					aiInstructions: file.savedAiInstructions,
					userId: file.folder.userId,
					organizationId: file.folder.organizationId,
				},
				select: { id: true },
			});
			const attached = await tx.projectDocumentFolderFile.updateMany({
				where,
				data: {
					contextId: context.id,
					storageKey: params.s3Path,
					savedSourceType: null,
					savedAiInstructions: null,
				},
			});
			if (attached.count === 0) {
				// Roll the context back: another attempt attached first.
				throw new ClaimLostError();
			}
			return context.id;
		});
		if (created) {
			return { status: "created", contextId: created };
		}
	} catch (error) {
		if (!(error instanceof ClaimLostError)) {
			throw error;
		}
	}

	const file = await db.projectDocumentFolderFile.findUnique({
		where: { id: params.fileId },
		select: { status: true, contextId: true, retiredAt: true },
	});
	if (
		file?.status === DOCUMENT_FOLDER_FILE_STATUS.IMPORTING &&
		file.contextId &&
		file.retiredAt === null
	) {
		return { status: "existing", contextId: file.contextId };
	}
	return { status: "not_claimable" };
}

/** What an import came to, for the claim holding `contextId`. */
export type DocumentFolderFileOutcome =
	| { contextId: string; outcome: "IMPORTED" }
	/** Null when the download failed before a context was made. */
	| {
			contextId: string | null;
			outcome: "FAILED";
			failureCode: DocumentFolderFailureCode;
	  }
	/**
	 * Found unsupported, over the byte cap mid-download, or refused by the
	 * drive: before a context.
	 */
	| {
			contextId: null;
			outcome: "SKIPPED";
			skipCode: "TOO_BIG" | "UNSUPPORTED" | "NOT_DOWNLOADABLE";
	  };

/**
 * Record what an import came to, for the claim that holds `contextId` (null
 * before a context was made). A context that someone removed while it was
 * being imported makes the file EXCLUDED at the version claimed. Returns the
 * status written, or null when the claim no longer holds.
 */
export async function recordDocumentFolderFileOutcome(
	params: { fileId: string } & DocumentFolderFileOutcome,
): Promise<DocumentFolderFileStatus | null> {
	const S = DOCUMENT_FOLDER_FILE_STATUS;
	const where = fileWriteWhere({
		fileId: params.fileId,
		status: S.IMPORTING,
		contextId: params.contextId,
	});
	const file = await db.projectDocumentFolderFile.findFirst({
		where,
		select: { importedVersion: true },
	});
	if (!file) {
		return null;
	}

	let status: DocumentFolderFileStatus;
	let data: Prisma.ProjectDocumentFolderFileUpdateManyMutationInput;
	const contextGone =
		params.contextId !== null &&
		!(await db.projectContext.findUnique({
			where: { id: params.contextId },
			select: { id: true },
		}));
	if (contextGone) {
		status = S.EXCLUDED;
		data = {
			status,
			excludedVersion: file.importedVersion,
			contextId: null,
			storageKey: null,
			failureCode: null,
			skipCode: null,
		};
	} else if (params.outcome === "IMPORTED") {
		status = S.IMPORTED;
		data = { status, failureCode: null, skipCode: null };
	} else if (params.outcome === "FAILED") {
		status = S.FAILED;
		data = { status, failureCode: params.failureCode, skipCode: null };
	} else {
		status = S.SKIPPED;
		data = { status, skipCode: params.skipCode, failureCode: null };
	}

	const result = await db.projectDocumentFolderFile.updateMany({
		where,
		data,
	});
	return result.count > 0 ? status : null;
}

// ---------------------------------------------------------------------------
// Deletion follow-up
// ---------------------------------------------------------------------------

/**
 * Rows of connected folders still holding a context that must be deleted:
 * tombstoned files, files being replaced by a new version, and files moved out
 * of the import window. At most one pass's worth.
 */
export async function listDocumentFolderFilesNeedingDeletion(params: {
	projectId: string;
	limit?: number;
}): Promise<
	Array<{
		fileId: string;
		folderId: string;
		contextId: string;
		storageKey: string | null;
	}>
> {
	const rows = await db.projectDocumentFolderFile.findMany({
		where: {
			projectId: params.projectId,
			contextId: { not: null },
			// Disconnecting keeps every imported file as ordinary context.
			folder: { disconnectedAt: null },
			OR: [
				{ retiredAt: { not: null } },
				{ status: DOCUMENT_FOLDER_FILE_STATUS.REFRESHING },
				{
					status: DOCUMENT_FOLDER_FILE_STATUS.SKIPPED,
					skipCode: DOCUMENT_FOLDER_SKIP_CODE.CAP_REACHED,
				},
			],
		},
		orderBy: { updatedAt: "asc" },
		take: params.limit ?? DOCUMENT_FOLDER_DELETIONS_PER_PASS,
		select: { id: true, folderId: true, contextId: true, storageKey: true },
	});
	return rows.flatMap((row) =>
		row.contextId
			? [
					{
						fileId: row.id,
						folderId: row.folderId,
						contextId: row.contextId,
						storageKey: row.storageKey,
					},
				]
			: [],
	);
}

/**
 * Release a row's context once the caller has confirmed the strict vector
 * delete, the absence of the context row and the stored copy's removal. A
 * file being refreshed returns to pending. A tombstoned file seen again since
 * it was tombstoned returns: excluded if it was excluded at the version now
 * seen, pending otherwise. Returns the row's status after the write, or null
 * when the row no longer holds that context.
 */
export async function completeDocumentFolderFileDeletion(params: {
	fileId: string;
	contextId: string;
	/** Only a confirmed deletion releases the context. */
	deletionConfirmed: true;
}): Promise<DocumentFolderFileStatus | null> {
	const where = { id: params.fileId, contextId: params.contextId };
	const file = await db.projectDocumentFolderFile.findFirst({
		where,
		select: {
			status: true,
			retiredAt: true,
			lastSeenAt: true,
			latestVersion: true,
			excludedVersion: true,
			name: true,
			size: true,
		},
	});
	if (!file || params.deletionConfirmed !== true) {
		return null;
	}
	const S = DOCUMENT_FOLDER_FILE_STATUS;
	let status = file.status as DocumentFolderFileStatus;
	const data: Prisma.ProjectDocumentFolderFileUpdateManyMutationInput = {
		contextId: null,
		storageKey: null,
	};
	if (file.retiredAt) {
		if (file.lastSeenAt && file.lastSeenAt > file.retiredAt) {
			data.retiredAt = null;
			data.missCount = 0;
			data.failureCode = null;
			if (
				file.excludedVersion !== null &&
				file.excludedVersion === file.latestVersion
			) {
				status = S.EXCLUDED;
				data.skipCode = null;
			} else {
				const classified = classifyDocumentFolderFile({
					name: file.name,
					mimeType: null,
					size: toNumberOrNull(file.size),
				});
				status = classified.status;
				data.skipCode = classified.skipCode;
				data.excludedVersion = null;
			}
			data.status = status;
		}
	} else if (file.status === S.REFRESHING) {
		status = S.PENDING;
		data.status = status;
		data.skipCode = null;
		data.failureCode = null;
	}
	const result = await db.projectDocumentFolderFile.updateMany({
		where,
		data,
	});
	return result.count > 0 ? status : null;
}
