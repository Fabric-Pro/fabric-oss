/**
 * Connect, reconnect, describe and disconnect document folders, and the
 * project-wide connect lock transcript folders share.
 */

import { db } from "../../../client";
import { advisoryObjectKey } from "../../lib/refresh-lock-key";
import {
	DOCUMENT_FOLDER_FILE_STATUS,
	DOCUMENT_FOLDER_MAX_PER_PROJECT,
	type DocumentFolderProvider,
	FOLDER_CONNECT_ADVISORY_CLASS,
	FOLDER_CONNECT_TRANSACTION,
} from "./constants";
import { foldersOverlap, normalizeDocumentFolderDescription } from "./helpers";
import type { Tx } from "./write-conditions";

/**
 * Serialize every folder connect of one project, document or transcript, so
 * the overlap and count checks read a state no other connect is changing.
 * `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock()` returns `void`,
 * which the driver adapter's `$queryRaw` cannot deserialize.
 */
export async function lockProjectFolderConnects(
	tx: Tx,
	projectId: string,
): Promise<void> {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FOLDER_CONNECT_ADVISORY_CLASS}::int, ${advisoryObjectKey(`folders:${projectId}`)}::int)`;
}

export type FolderConnectRefusal =
	| "SAME_AS_TRANSCRIPT_FOLDER"
	| "OVERLAPS_TRANSCRIPT_FOLDER"
	| "SAME_AS_DOCUMENT_FOLDER"
	| "OVERLAPS_DOCUMENT_FOLDER"
	| "TOO_MANY_FOLDERS";

/** A connect that would overlap another folder, or exceed the folder limit. */
export class FolderConnectRefusedError extends Error {
	constructor(
		readonly reason: FolderConnectRefusal,
		/** The folder being connected. */
		readonly folderName: string,
		/** The connected folder it collides with; null for the folder limit. */
		readonly existingFolderName: string | null,
	) {
		super(
			existingFolderName
				? `Folder "${folderName}" overlaps connected folder "${existingFolderName}" (${reason}).`
				: `Folder "${folderName}" cannot be connected (${reason}).`,
		);
		this.name = "FolderConnectRefusedError";
	}
}

export interface DocumentFolderSelection {
	provider: DocumentFolderProvider;
	driveId: string;
	itemId: string;
	name: string;
	webUrl?: string | null;
	/** The folder's path in its drive, such as `/Sales`; `/` for the root. */
	drivePath: string | null;
	/**
	 * Google Drive only: the ids of the folder's ancestors, which the overlap
	 * check compares instead of paths. Left out for OneDrive and SharePoint.
	 */
	ancestorIds?: string[];
	siteId?: string | null;
	siteName?: string | null;
	libraryName?: string | null;
	/** Left out on a reconnect, the stored description stays. */
	description?: string | null;
}

/** A connected transcript folder's drive path, which only Graph knows. */
export interface TranscriptFolderDrivePath {
	driveId: string;
	itemId: string;
	drivePath: string | null;
}

/** Whether two references name the same drive item. */
export const sameItem = (
	a: { driveId: string; itemId: string },
	b: { driveId: string; itemId: string },
) => a.driveId === b.driveId && a.itemId === b.itemId;

/**
 * Connect document folders to a project, or reconnect them.
 *
 * Refused, naming the folder in the way, when a folder is a connected
 * transcript folder, or holds or lies in a connected transcript or document
 * folder of the same drive, or when the project would pass the folder limit.
 * Transcript folders store no path, so the caller passes theirs from Graph;
 * document folders use the path every read refreshes, and Google Drive
 * folders their stored ancestor ids.
 *
 * Reconnecting makes the person the reader: of the folder, of its file rows
 * and of every context those rows hold, so deleting the previous reader's
 * account cannot cascade away contexts the ledger still tracks. It raises the
 * reader epoch, so a read still running as the previous reader applies
 * nothing, and resets miss counts, which were counted from the old view.
 */
export async function connectDocumentFolders(params: {
	projectId: string;
	userId: string;
	organizationId: string;
	folders: DocumentFolderSelection[];
	transcriptFolderPaths?: TranscriptFolderDrivePath[];
}): Promise<
	Array<{
		folderId: string;
		driveId: string;
		itemId: string;
		name: string;
		reconnected: boolean;
		previousUserId: string | null;
		/** The epoch a finish recorded for this connect must name. */
		readerEpoch: number;
	}>
> {
	const selections = params.folders.filter(
		(folder, index) =>
			params.folders.findIndex((other) => sameItem(other, folder)) ===
			index,
	);

	return db.$transaction(async (tx) => {
		await lockProjectFolderConnects(tx, params.projectId);
		const existing = await tx.projectDocumentFolder.findMany({
			where: { projectId: params.projectId },
			select: {
				id: true,
				driveId: true,
				itemId: true,
				name: true,
				drivePath: true,
				ancestorIds: true,
				disconnectedAt: true,
				userId: true,
			},
		});
		const transcripts = await tx.projectTranscriptFolder.findMany({
			where: { projectId: params.projectId, disconnectedAt: null },
			select: { driveId: true, itemId: true, name: true },
		});

		const connected = existing.filter((f) => f.disconnectedAt === null);
		for (const folder of selections) {
			for (const transcript of transcripts) {
				if (sameItem(transcript, folder)) {
					throw new FolderConnectRefusedError(
						"SAME_AS_TRANSCRIPT_FOLDER",
						folder.name,
						transcript.name,
					);
				}
				const path =
					params.transcriptFolderPaths?.find((p) =>
						sameItem(p, transcript),
					)?.drivePath ?? null;
				if (
					foldersOverlap(folder, {
						driveId: transcript.driveId,
						drivePath: path,
					})
				) {
					throw new FolderConnectRefusedError(
						"OVERLAPS_TRANSCRIPT_FOLDER",
						folder.name,
						transcript.name,
					);
				}
			}
			const others = [
				...connected.filter((f) => !sameItem(f, folder)),
				...selections.filter((f) => !sameItem(f, folder)),
			];
			const overlapping = others.find((other) =>
				foldersOverlap(folder, other),
			);
			if (overlapping) {
				throw new FolderConnectRefusedError(
					"OVERLAPS_DOCUMENT_FOLDER",
					folder.name,
					overlapping.name,
				);
			}
		}
		const kept = connected.filter(
			(f) => !selections.some((s) => sameItem(s, f)),
		).length;
		const last = selections[selections.length - 1];
		if (
			last &&
			kept + selections.length > DOCUMENT_FOLDER_MAX_PER_PROJECT
		) {
			throw new FolderConnectRefusedError(
				"TOO_MANY_FOLDERS",
				last.name,
				null,
			);
		}

		const results = [];
		for (const folder of selections) {
			const previous = existing.find((f) => sameItem(f, folder));
			const place = {
				provider: folder.provider,
				name: folder.name,
				webUrl: folder.webUrl ?? null,
				drivePath: folder.drivePath,
				ancestorIds: folder.ancestorIds ?? [],
				siteId: folder.siteId ?? null,
				siteName: folder.siteName ?? null,
				libraryName: folder.libraryName ?? null,
			};
			const saved = await tx.projectDocumentFolder.upsert({
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
					...place,
					description: normalizeDocumentFolderDescription(
						folder.description,
					),
					userId: params.userId,
					organizationId: params.organizationId,
				},
				update: {
					...place,
					...(folder.description === undefined
						? {}
						: {
								description: normalizeDocumentFolderDescription(
									folder.description,
								),
							}),
					userId: params.userId,
					disconnectedAt: null,
					readerEpoch: { increment: 1 },
					// The previous reader's read applies nothing now.
					readStartedAt: null,
					problemCode: null,
					pausedRemovalsCode: null,
					heldRemovalCount: null,
					nextReadAfter: null,
				},
				select: { id: true, readerEpoch: true },
			});
			if (previous) {
				await restampReader(tx, {
					folderId: saved.id,
					projectId: params.projectId,
					userId: params.userId,
				});
			}
			results.push({
				folderId: saved.id,
				driveId: folder.driveId,
				itemId: folder.itemId,
				name: folder.name,
				reconnected: previous !== undefined,
				previousUserId: previous?.userId ?? null,
				readerEpoch: saved.readerEpoch,
			});
		}
		return results;
	}, FOLDER_CONNECT_TRANSACTION);
}

async function restampReader(
	tx: Tx,
	params: { folderId: string; projectId: string; userId: string },
) {
	const held = await tx.projectDocumentFolderFile.findMany({
		where: { folderId: params.folderId, contextId: { not: null } },
		select: { contextId: true },
	});
	await tx.projectDocumentFolderFile.updateMany({
		where: { folderId: params.folderId },
		data: { userId: params.userId, missCount: 0 },
	});
	// A file whose download failed is offered again; one whose context exists
	// waits for a new version instead.
	await tx.projectDocumentFolderFile.updateMany({
		where: {
			folderId: params.folderId,
			status: DOCUMENT_FOLDER_FILE_STATUS.FAILED,
			contextId: null,
			retiredAt: null,
		},
		data: {
			status: DOCUMENT_FOLDER_FILE_STATUS.PENDING,
			failureCode: null,
		},
	});
	const contextIds = held.flatMap((file) =>
		file.contextId ? [file.contextId] : [],
	);
	if (contextIds.length > 0) {
		await tx.projectContext.updateMany({
			where: { id: { in: contextIds }, projectId: params.projectId },
			data: { userId: params.userId },
		});
	}
}

/** Set a connected folder's description. Null when there is no such folder. */
export async function describeDocumentFolder(params: {
	projectId: string;
	folderId: string;
	description: string | null;
}): Promise<{
	name: string;
	previous: string | null;
	description: string | null;
} | null> {
	const where = {
		id: params.folderId,
		projectId: params.projectId,
		disconnectedAt: null,
	};
	const folder = await db.projectDocumentFolder.findFirst({
		where,
		select: { name: true, description: true },
	});
	if (!folder) {
		return null;
	}
	const description = normalizeDocumentFolderDescription(params.description);
	const result = await db.projectDocumentFolder.updateMany({
		where,
		data: { description },
	});
	if (result.count === 0) {
		return null;
	}
	return { name: folder.name, previous: folder.description, description };
}

/**
 * Stop reading a folder. Its imported files stay as ordinary context, and its
 * description stops applying to them because only connected folders lend it.
 */
export async function disconnectDocumentFolder(params: {
	projectId: string;
	folderId: string;
}): Promise<{ name: string } | null> {
	const where = {
		id: params.folderId,
		projectId: params.projectId,
		disconnectedAt: null,
	};
	const folder = await db.projectDocumentFolder.findFirst({
		where,
		select: { name: true },
	});
	if (!folder) {
		return null;
	}
	const result = await db.projectDocumentFolder.updateMany({
		where,
		data: { disconnectedAt: new Date() },
	});
	return result.count > 0 ? { name: folder.name } : null;
}
