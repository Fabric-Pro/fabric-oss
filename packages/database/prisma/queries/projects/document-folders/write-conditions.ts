/**
 * Conditions shared by the writes on folder and file rows.
 */

import type { Prisma } from "../../../client";
import type { DocumentFolderFileStatus } from "./constants";

export type Tx = Prisma.TransactionClient;

/**
 * The one condition every status write on a file row carries: the row is
 * keyed by id, is not retired (unless the write is about a retired row), its
 * folder is still connected, and it is in the status the writer read. After a
 * claim, the writer also names the context it attached. A write that no longer
 * matches changes nothing, which is how a late retry, a disconnect or a
 * tombstone wins over an import still in flight.
 */
export function fileWriteWhere(params: {
	fileId: string;
	status?: DocumentFolderFileStatus | DocumentFolderFileStatus[];
	retired?: boolean;
	contextId?: string | null;
}): Prisma.ProjectDocumentFolderFileWhereInput {
	return {
		id: params.fileId,
		retiredAt: params.retired ? { not: null } : null,
		folder: { disconnectedAt: null },
		...(params.status === undefined
			? {}
			: {
					status: Array.isArray(params.status)
						? { in: params.status }
						: params.status,
				}),
		...(params.contextId === undefined
			? {}
			: { contextId: params.contextId }),
	};
}

interface LockedFolder {
	id: string;
	projectId: string;
	userId: string;
	organizationId: string;
	readerEpoch: number;
	lastPassId: string | null;
	disconnectedAt: Date | null;
	discoveredAt: Date | null;
	pausedRemovalsCode: string | null;
}

/** Lock a folder row for the rest of the transaction. */
export async function lockFolder(
	tx: Tx,
	folderId: string,
): Promise<LockedFolder | null> {
	const rows = await tx.$queryRaw<LockedFolder[]>`
		SELECT "id", "projectId", "userId", "organizationId", "readerEpoch",
			"lastPassId", "disconnectedAt", "discoveredAt", "pausedRemovalsCode"
		FROM "project_document_folder"
		WHERE "id" = ${folderId}
		FOR UPDATE`;
	return rows[0] ?? null;
}
