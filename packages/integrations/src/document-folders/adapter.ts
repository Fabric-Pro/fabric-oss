/**
 * The drive behind a connected document folder (Fizzy #2808), one adapter per
 * provider. The folder API and the folder sync activity pick an adapter by the
 * folder's stored `provider` and call it the same way for every drive, so the
 * sync's status logic does not depend on which drive it reads.
 *
 * Every method is a read. The results are the provider-neutral shapes the
 * Microsoft reads already return: a failure comes back as an HTTP status and
 * a retry hint, never as a thrown error, so a folder's problem is worked out
 * the same way for every provider. A connection the person can no longer use
 * is thrown, and `isNotConnectedError` recognises it.
 */

import type { DocumentFolderProvider } from "@repo/database/prisma/queries/projects/document-folders/constants";
import type {
	DriveItemDetailsResult,
	DriveItemDownload,
	DriveItemPlacement,
	DriveReadProgress,
	DriveTreeListing,
} from "../microsoft/drive-folder";
import {
	browseGoogleDriveFolder,
	browseGoogleDrivePlaces,
	googleDriveDocumentFolderAdapter,
} from "./google";
import { microsoftDocumentFolderAdapter } from "./microsoft";

export type {
	DriveItemDownload,
	DriveItemPlacement,
	DriveReadProgress,
	DriveTreeListing,
};
export type {
	GoogleDriveFolderEntry,
	GoogleDrivePlaces,
} from "../google/drive-folder";
/** The Google Drive picker's reads: its places, and one folder's children. */
export { browseGoogleDriveFolder, browseGoogleDrivePlaces };
export { DOCUMENT_FOLDER_BROWSE_MAX_ITEMS } from "../drive-shared";

type DriveTreeFile = Extract<
	DriveTreeListing,
	{ status: "complete" }
>["files"][number];

/** A file a folder tree read found. */
export interface DocumentFolderTreeFile extends DriveTreeFile {
	/**
	 * The drive will not hand the file over (Google: `canDownload: false`),
	 * so it is skipped without a download. Absent for a file it will.
	 */
	notDownloadable?: true;
}

type WithTreeFiles<T> = T extends { files: unknown }
	? Omit<T, "files"> & { files: DocumentFolderTreeFile[] }
	: T;

/**
 * A folder tree read, as `DriveTreeListing` describes it, with one more way
 * to be cut short: `incomplete`, when the drive reports that a page was not
 * searched in full. Only `complete` lists everything below the folder.
 */
export type DocumentFolderTreeListing =
	| WithTreeFiles<DriveTreeListing>
	| {
			status: "truncated";
			reason: "incomplete";
			files: DocumentFolderTreeFile[];
	  };

/**
 * One file's bytes, as `DriveItemDownload` describes it, or
 * `not_downloadable` when the drive refuses to hand the file over: its owner
 * blocked downloads, or Google flagged it.
 */
export type DocumentFolderDownload =
	| DriveItemDownload
	| { status: "not_downloadable"; name: string };

/** Who a drive is read as: a person, through their own connection. */
export interface DocumentFolderConnection {
	userId: string;
	organizationId: string;
	connectionId: string;
}

/**
 * The person's own connection to the drive. Never one shared with the
 * organization: a folder is read as the person who connected it. A
 * connection the drive's folders cannot be read with, such as a Google grant
 * without `drive.readonly`, needs to be connected again.
 */
export type DocumentFolderConnectionResolution =
	| { status: "connected"; connection: DocumentFolderConnection }
	| { status: "not_connected" }
	| { status: "reconnect_required" };

type DriveItemDetailsFailure = Extract<
	DriveItemDetailsResult,
	{ status: "failed" }
>;
type DriveItemDetailsFields = Extract<
	DriveItemDetailsResult,
	{ status: "ok" }
>["item"];

/** A drive item, with what connecting it as a folder and showing it needs. */
export interface DocumentFolderItemDetails
	extends Omit<DriveItemDetailsFields, "provider"> {
	/** The provider the item's drive is, or null for a drive Fabric does not read. */
	provider: DocumentFolderProvider | null;
	/** The item's display path in its drive, such as `/Plans/Q3`; null at the root. */
	drivePath: string | null;
	/**
	 * The ids of the folders above the item, from its parent up to the
	 * drive's root, for a drive whose names cannot decide containment.
	 * Absent where the path decides it.
	 */
	ancestorIds?: string[];
}

export type DocumentFolderItemDetailsResult =
	| { status: "ok"; item: DocumentFolderItemDetails }
	| DriveItemDetailsFailure;

/** Reports progress after every request of a long read. */
export interface DocumentFolderReadOptions {
	onProgress?: (progress: DriveReadProgress) => void;
}

export interface DocumentFolderDriveAdapter {
	/** The person's own connection for this drive, if they can use one. */
	resolveOwnConnection(input: {
		userId: string;
		organizationId: string;
	}): Promise<DocumentFolderConnectionResolution>;
	/** One item: the probe a folder read starts with, and what connecting needs. */
	getItemDetails(
		connection: DocumentFolderConnection,
		item: { driveId: string; itemId: string },
	): Promise<DocumentFolderItemDetailsResult>;
	/** Every file below a folder, as far as the read's depth and size caps go. */
	listFolderTree(
		connection: DocumentFolderConnection,
		folder: { driveId: string; itemId: string },
		options?: DocumentFolderReadOptions,
	): Promise<DocumentFolderTreeListing>;
	/** Where each item is now relative to the folder, looked up by id. */
	lookupItemsInFolder(
		connection: DocumentFolderConnection,
		lookup: { driveId: string; folderItemId: string; itemIds: string[] },
		options?: DocumentFolderReadOptions,
	): Promise<{ items: DriveItemPlacement[] }>;
	/** One file's bytes, refused past `maxBytes`. */
	downloadFile(
		connection: DocumentFolderConnection,
		file: { driveId: string; itemId: string; maxBytes: number },
	): Promise<DocumentFolderDownload>;
	/** Whether a thrown error means the person has to connect the drive again. */
	isNotConnectedError(message: string): boolean;
}

const ADAPTERS = {
	onedrive: microsoftDocumentFolderAdapter,
	sharepoint: microsoftDocumentFolderAdapter,
	googledrive: googleDriveDocumentFolderAdapter,
} as const satisfies Record<DocumentFolderProvider, DocumentFolderDriveAdapter>;

/**
 * The adapter for a folder's stored provider. Throws for a provider Fabric
 * has no adapter for, rather than reading the folder as another drive.
 */
export function documentFolderDriveAdapter(
	provider: string,
): DocumentFolderDriveAdapter {
	if (!Object.hasOwn(ADAPTERS, provider)) {
		throw new Error(
			`No document-folder adapter for provider "${provider}".`,
		);
	}
	return ADAPTERS[provider as DocumentFolderProvider];
}
