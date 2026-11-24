/**
 * The sync's reads: which folders are due, and a read's start and finish.
 */

import { db } from "../../../client";
import type { DocumentFolderProblemCode } from "./constants";

/**
 * Whether the project has any connected document folder, which of them may be
 * read now, and the earliest time a throttled one may be read again.
 */
export async function listDocumentFolderSyncState(params: {
	projectId: string;
	now?: Date;
}): Promise<{
	anyConnected: boolean;
	dueFolderIds: string[];
	nextReadAfter: Date | null;
}> {
	const now = params.now ?? new Date();
	const folders = await db.projectDocumentFolder.findMany({
		where: { projectId: params.projectId, disconnectedAt: null },
		orderBy: { connectedAt: "asc" },
		select: { id: true, nextReadAfter: true },
	});
	let nextReadAfter: Date | null = null;
	const dueFolderIds: string[] = [];
	for (const folder of folders) {
		if (!folder.nextReadAfter || folder.nextReadAfter <= now) {
			dueFolderIds.push(folder.id);
		} else if (!nextReadAfter || folder.nextReadAfter < nextReadAfter) {
			nextReadAfter = folder.nextReadAfter;
		}
	}
	return { anyConnected: folders.length > 0, dueFolderIds, nextReadAfter };
}

/**
 * Mark a read as running and return what it needs, including the reader
 * epoch it must hand back to reconciliation. Null for a disconnected folder.
 */
export async function startDocumentFolderRead(params: {
	folderId: string;
	now?: Date;
}) {
	const started = await db.projectDocumentFolder.updateMany({
		where: { id: params.folderId, disconnectedAt: null },
		data: { readStartedAt: params.now ?? new Date() },
	});
	if (started.count === 0) {
		return null;
	}
	return await db.projectDocumentFolder.findUnique({
		where: { id: params.folderId },
		select: {
			id: true,
			projectId: true,
			provider: true,
			driveId: true,
			itemId: true,
			name: true,
			drivePath: true,
			userId: true,
			organizationId: true,
			readerEpoch: true,
		},
	});
}

/**
 * End a read, failed or not. A problem code is written when given (null
 * clears it); a throttled folder keeps its next-read-after time.
 *
 * Applies only while the folder is at the reader epoch the read started
 * with. A reconnect raises the epoch and clears the running marker itself,
 * so a read it superseded changes nothing when it ends: neither the new
 * reader's next-read-after and problem, nor the marker of a read the new
 * reader started since.
 */
export async function finishDocumentFolderRead(params: {
	folderId: string;
	/** The epoch `startDocumentFolderRead` or the connect returned. */
	readerEpoch: number;
	problemCode?: DocumentFolderProblemCode | null;
	nextReadAfter?: Date | null;
}): Promise<void> {
	await db.projectDocumentFolder.updateMany({
		where: { id: params.folderId, readerEpoch: params.readerEpoch },
		data: {
			readStartedAt: null,
			nextReadAfter: params.nextReadAfter ?? null,
			...(params.problemCode === undefined
				? {}
				: { problemCode: params.problemCode }),
		},
	});
}
