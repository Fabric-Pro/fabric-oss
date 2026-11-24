/**
 * A project's connected document folders, as viewers and editors see them.
 */

import { db } from "../../../client";
import {
	ATTENTION_FILES_SHOWN,
	DOCUMENT_FOLDER_FILE_STATUS,
	type DocumentFolderFileStatus,
} from "./constants";

export interface DocumentFolderCounts {
	/** Files found in the folder and not removed from it. */
	found: number;
	imported: number;
	skipped: number;
	failed: number;
	excluded: number;
	/** Waiting, importing, or being replaced by a new version. */
	inProgress: number;
}

/** What anyone who can see the project sees of a folder. */
export interface DocumentFolderViewerItem {
	id: string;
	provider: string;
	name: string;
	drivePath: string | null;
	siteName: string | null;
	libraryName: string | null;
	description: string | null;
	connectedAt: Date;
	lastReadAt: Date | null;
	reading: boolean;
	/** False while the folder has not been listed in full yet. */
	discoveryComplete: boolean;
	lastListingComplete: boolean;
	problemCode: string | null;
	pausedRemovalsCode: string | null;
	heldRemovalCount: number | null;
	nextReadAfter: Date | null;
	counts: DocumentFolderCounts;
}

/** What an editor sees: also the reader, identifiers and problem files. */
export interface DocumentFolderEditorItem extends DocumentFolderViewerItem {
	driveId: string;
	itemId: string;
	siteId: string | null;
	webUrl: string | null;
	readerUserId: string;
	readerName: string | null;
	attention: Array<{
		id: string;
		name: string;
		relativePath: string;
		status: string;
		skipCode: string | null;
		failureCode: string | null;
	}>;
}

/**
 * A project's connected document folders. Viewers and guests get the place,
 * description, counts and state only: never the reader's identity, drive
 * identifiers or web addresses.
 */
export async function listDocumentFolders(params: {
	projectId: string;
	view: "editor";
}): Promise<DocumentFolderEditorItem[]>;
export async function listDocumentFolders(params: {
	projectId: string;
	view: "viewer";
}): Promise<DocumentFolderViewerItem[]>;
export async function listDocumentFolders(params: {
	projectId: string;
	view: "editor" | "viewer";
}): Promise<DocumentFolderViewerItem[] | DocumentFolderEditorItem[]> {
	const editor = params.view === "editor";
	const folders = await db.projectDocumentFolder.findMany({
		where: { projectId: params.projectId, disconnectedAt: null },
		orderBy: { connectedAt: "asc" },
		select: {
			id: true,
			provider: true,
			name: true,
			drivePath: true,
			siteName: true,
			libraryName: true,
			description: true,
			connectedAt: true,
			readStartedAt: true,
			lastReadAt: true,
			lastListingComplete: true,
			discoveredAt: true,
			pausedRemovalsCode: true,
			heldRemovalCount: true,
			problemCode: true,
			nextReadAfter: true,
			...(editor
				? {
						driveId: true,
						itemId: true,
						siteId: true,
						webUrl: true,
						userId: true,
						user: { select: { name: true } },
					}
				: {}),
		},
	});
	if (folders.length === 0) {
		return [];
	}

	const folderIds = folders.map((folder) => folder.id);
	const S = DOCUMENT_FOLDER_FILE_STATUS;
	const [counts, attentionByFolder] = await Promise.all([
		db.projectDocumentFolderFile.groupBy({
			by: ["folderId", "status"],
			where: { folderId: { in: folderIds }, retiredAt: null },
			_count: { _all: true },
		}),
		// Per folder, so one folder's many skipped files cannot crowd out
		// another's.
		editor
			? Promise.all(
					folderIds.map((folderId) =>
						db.projectDocumentFolderFile.findMany({
							where: {
								folderId,
								retiredAt: null,
								status: { in: [S.SKIPPED, S.FAILED] },
							},
							orderBy: { updatedAt: "desc" },
							take: ATTENTION_FILES_SHOWN,
							select: {
								id: true,
								folderId: true,
								name: true,
								relativePath: true,
								status: true,
								skipCode: true,
								failureCode: true,
							},
						}),
					),
				)
			: Promise.resolve([]),
	]);
	const attention = attentionByFolder.flat();

	return folders.map((folder) => {
		const byStatus = (status: DocumentFolderFileStatus) =>
			counts.find(
				(row) => row.folderId === folder.id && row.status === status,
			)?._count._all ?? 0;
		const imported = byStatus(S.IMPORTED);
		const skipped = byStatus(S.SKIPPED);
		const failed = byStatus(S.FAILED);
		const excluded = byStatus(S.EXCLUDED);
		const inProgress =
			byStatus(S.PENDING) +
			byStatus(S.IMPORTING) +
			byStatus(S.REFRESHING);
		const viewerItem: DocumentFolderViewerItem = {
			id: folder.id,
			provider: folder.provider,
			name: folder.name,
			drivePath: folder.drivePath,
			siteName: folder.siteName,
			libraryName: folder.libraryName,
			description: folder.description,
			connectedAt: folder.connectedAt,
			lastReadAt: folder.lastReadAt,
			reading: folder.readStartedAt !== null,
			discoveryComplete: folder.discoveredAt !== null,
			lastListingComplete: folder.lastListingComplete,
			problemCode: folder.problemCode,
			pausedRemovalsCode: folder.pausedRemovalsCode,
			heldRemovalCount: folder.heldRemovalCount,
			nextReadAfter: folder.nextReadAfter,
			counts: {
				found: imported + skipped + failed + excluded + inProgress,
				imported,
				skipped,
				failed,
				excluded,
				inProgress,
			},
		};
		if (!editor) {
			return viewerItem;
		}
		const full = folder as typeof folder & {
			driveId: string;
			itemId: string;
			siteId: string | null;
			webUrl: string | null;
			userId: string;
			user: { name: string | null } | null;
		};
		return {
			...viewerItem,
			driveId: full.driveId,
			itemId: full.itemId,
			siteId: full.siteId,
			webUrl: full.webUrl,
			readerUserId: full.userId,
			readerName: full.user?.name ?? null,
			attention: attention
				.filter((file) => file.folderId === folder.id)
				.slice(0, ATTENTION_FILES_SHOWN)
				.map((file) => ({
					id: file.id,
					name: file.name,
					relativePath: file.relativePath,
					status: file.status,
					skipCode: file.skipCode,
					failureCode: file.failureCode,
				})),
		} satisfies DocumentFolderEditorItem;
	});
}
