/**
 * Google Drive document folders, read through typed Drive v3 calls as the
 * person who connected the folder, with their own `GOOGLE_DRIVE` connection.
 * Each request takes its token from the shared token helper, by connection
 * id, reusing it for up to 50 seconds, so a long read picks up a refreshed
 * token rather than failing midway.
 *
 * Folders are found by id alone: Drive item ids are global, so the stored
 * `driveId` (a shared drive's id, or the person's My Drive root folder id)
 * is not needed to read one.
 */

import { resolveOwnWorkflowIntegrationForProvider } from "@repo/database";
import {
	downloadGoogleDriveFile,
	type GoogleDriveClient,
	type GoogleDriveFolderEntry,
	type GoogleDrivePlaces,
	getGoogleDriveItemDetails,
	listGoogleDriveFolderChildren,
	listGoogleDriveFolderTree,
	listGoogleDrivePlaces,
	lookupGoogleDriveItemsInFolder,
} from "../google/drive-folder";
import {
	getGoogleDriveAccessToken,
	hasGoogleDriveReadonlyScope,
	isGoogleDriveNotConnectedError,
} from "../google/token";
import type {
	DocumentFolderConnection,
	DocumentFolderDriveAdapter,
} from "./adapter";

/**
 * How long one client reuses a token. The token helper refreshes any token
 * with less than a minute left, so one it returned outlives this.
 */
const TOKEN_REUSE_MS = 50_000;

function driveClient(connection: DocumentFolderConnection): GoogleDriveClient {
	let cached: { token: string; fetchedAt: number } | null = null;
	return {
		async getAccessToken() {
			const now = Date.now();
			if (cached && now - cached.fetchedAt < TOKEN_REUSE_MS) {
				return cached.token;
			}
			const token = await getGoogleDriveAccessToken({
				userId: connection.userId,
				organizationId: connection.organizationId,
				connectionId: connection.connectionId,
			});
			cached = { token, fetchedAt: now };
			return token;
		},
	};
}

export const googleDriveDocumentFolderAdapter: DocumentFolderDriveAdapter = {
	async resolveOwnConnection({ userId, organizationId }) {
		// The person's own connection only, never the OAuth app's row or
		// one shared with the organization.
		const own = await resolveOwnWorkflowIntegrationForProvider(
			"GOOGLE_DRIVE",
			userId,
			organizationId,
		);
		if (!own) {
			return { status: "not_connected" };
		}
		const connection = { userId, organizationId, connectionId: own.id };
		// A grant without `drive.readonly` lists an empty folder instead of
		// failing, which would read as every file removed.
		if (!(await hasGoogleDriveReadonlyScope(connection))) {
			return { status: "reconnect_required" };
		}
		return { status: "connected", connection };
	},

	getItemDetails(connection, { itemId }) {
		return getGoogleDriveItemDetails(driveClient(connection), { itemId });
	},

	listFolderTree(connection, { itemId }, options) {
		return listGoogleDriveFolderTree(driveClient(connection), {
			itemId,
			onProgress: options?.onProgress,
		});
	},

	lookupItemsInFolder(connection, { folderItemId, itemIds }, options) {
		return lookupGoogleDriveItemsInFolder(driveClient(connection), {
			folderItemId,
			itemIds,
			onProgress: options?.onProgress,
		});
	},

	downloadFile(connection, { itemId, maxBytes }) {
		return downloadGoogleDriveFile(driveClient(connection), {
			itemId,
			maxBytes,
		});
	},

	isNotConnectedError: isGoogleDriveNotConnectedError,
};

/** The Google picker's top level: My Drive and the person's shared drives. */
export function browseGoogleDrivePlaces(
	connection: DocumentFolderConnection,
): Promise<GoogleDrivePlaces> {
	return listGoogleDrivePlaces(driveClient(connection));
}

/** One level of the Google picker: a folder's folders and files. */
export function browseGoogleDriveFolder(
	connection: DocumentFolderConnection,
	folder: { folderId: string; maxItems?: number },
): Promise<{ items: GoogleDriveFolderEntry[]; truncated: boolean }> {
	return listGoogleDriveFolderChildren(driveClient(connection), folder);
}
