/**
 * OneDrive and SharePoint document folders, read through the Microsoft Graph
 * reads the folder picker and sync have always used. A thin wrapper: each
 * call is forwarded to `executeMicrosoftTeamsTool` as the reader, through
 * their own connection, with exactly the arguments the callers passed before.
 */

import { resolveOwnWorkflowIntegrationForProvider } from "@repo/database";
import { isMicrosoftNotConnectedError } from "../microsoft/connection-errors";
import {
	type DriveItemDetailsResult,
	type DriveItemDownload,
	type DriveItemPlacement,
	type DriveTreeListing,
	driveItemPath,
} from "../microsoft/drive-folder";
import { executeMicrosoftTeamsTool } from "../microsoft/index";
import type {
	DocumentFolderConnection,
	DocumentFolderDriveAdapter,
	DocumentFolderReadOptions,
} from "./adapter";

function callGraph(
	connection: DocumentFolderConnection,
	method: string,
	args: Record<string, unknown>,
	options?: DocumentFolderReadOptions,
): Promise<unknown> {
	return executeMicrosoftTeamsTool(
		method,
		args,
		connection.userId,
		connection.organizationId,
		connection.connectionId,
		...(options?.onProgress ? [{ onProgress: options.onProgress }] : []),
	);
}

export const microsoftDocumentFolderAdapter: DocumentFolderDriveAdapter = {
	async resolveOwnConnection({ userId, organizationId }) {
		// The person's own connection only: the Graph tool would otherwise
		// fall back to one shared with the organization, and read the folder
		// as someone else.
		const own = await resolveOwnWorkflowIntegrationForProvider(
			"MICROSOFT_GRAPH",
			userId,
			organizationId,
		);
		if (!own) {
			return { status: "not_connected" };
		}
		return {
			status: "connected",
			connection: { userId, organizationId, connectionId: own.id },
		};
	},

	async getItemDetails(connection, { driveId, itemId }) {
		const found = (await callGraph(connection, "get_drive_item", {
			driveId,
			itemId,
		})) as DriveItemDetailsResult;
		if (found.status === "failed") {
			return found;
		}
		return {
			status: "ok",
			item: { ...found.item, drivePath: driveItemPath(found.item) },
		};
	},

	async listFolderTree(connection, { driveId, itemId }, options) {
		return (await callGraph(
			connection,
			"list_drive_tree",
			{ driveId, itemId },
			options,
		)) as DriveTreeListing;
	},

	async lookupItemsInFolder(
		connection,
		{ driveId, folderItemId, itemIds },
		options,
	) {
		return (await callGraph(
			connection,
			"lookup_drive_items",
			{ driveId, folderItemId, itemIds },
			options,
		)) as { items: DriveItemPlacement[] };
	},

	async downloadFile(connection, { driveId, itemId, maxBytes }) {
		return (await callGraph(connection, "download_drive_item", {
			driveId,
			itemId,
			maxBytes,
		})) as DriveItemDownload;
	},

	isNotConnectedError: isMicrosoftNotConnectedError,
};
