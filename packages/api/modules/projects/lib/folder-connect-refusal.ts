import { ORPCError } from "@orpc/client";
import {
	DOCUMENT_FOLDER_MAX_PER_PROJECT,
	FolderConnectRefusedError,
} from "@repo/database";
import { driveItemPath } from "@repo/integrations/microsoft";

/**
 * A folder's path in its drive, as the overlap refusal compares it, from the
 * parent path Graph reports: `/` for the drive's root, which has no parent.
 */
export function folderDrivePath(item: {
	name: string;
	parentPath: string | null;
}): string {
	return driveItemPath(item) ?? "/";
}

/**
 * A folder connect the database refused, as the client error it shows: a
 * folder that is, holds or lies inside another connected folder, document or
 * transcript, names that folder; one past the folder limit says the limit.
 * Shared by the document-folder and the transcript-folder connects, which
 * refuse each other's folders.
 *
 * Anything else is returned unchanged, for the caller to rethrow.
 */
export function folderConnectRefusal(error: unknown): unknown {
	if (!(error instanceof FolderConnectRefusedError)) {
		return error;
	}
	const { reason, folderName, existingFolderName } = error;
	const existing = existingFolderName ?? folderName;
	const data = { code: reason, folderName, existingFolderName };
	switch (reason) {
		case "SAME_AS_TRANSCRIPT_FOLDER":
			return new ORPCError("CONFLICT", {
				message: `"${existing}" is already connected as a meeting transcript folder.`,
				data,
			});
		case "OVERLAPS_TRANSCRIPT_FOLDER":
			return new ORPCError("CONFLICT", {
				message: `"${folderName}" holds or lies inside the meeting transcript folder "${existing}". Choose a folder that does not overlap it.`,
				data,
			});
		case "SAME_AS_DOCUMENT_FOLDER":
			return new ORPCError("CONFLICT", {
				message: `"${existing}" is already connected as a document folder.`,
				data,
			});
		case "OVERLAPS_DOCUMENT_FOLDER":
			return new ORPCError("CONFLICT", {
				message: `"${folderName}" holds or lies inside the document folder "${existing}". Choose a folder that does not overlap it.`,
				data,
			});
		case "TOO_MANY_FOLDERS":
			return new ORPCError("BAD_REQUEST", {
				message: `A project can have at most ${DOCUMENT_FOLDER_MAX_PER_PROJECT} document folders. Disconnect one before connecting "${folderName}".`,
				data,
			});
	}
}
