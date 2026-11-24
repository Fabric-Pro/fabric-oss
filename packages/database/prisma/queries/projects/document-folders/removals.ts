/**
 * Removing files that left a folder: tombstoning, a held mass removal and
 * its confirmation.
 */

import { db } from "../../../client";
import {
	DOCUMENT_FOLDER_MASS_REMOVAL_MIN,
	DOCUMENT_FOLDER_MASS_REMOVAL_RATIO,
	DOCUMENT_FOLDER_PAUSED_REMOVALS_CODE,
	MISSES_BEFORE_LOOKUP,
} from "./constants";
import { fileWriteWhere, lockFolder, type Tx } from "./write-conditions";

/**
 * Tombstone rows: save each context's own source type and guidance on the row,
 * so a later import of the file restores them, then set `retiredAt`. The
 * context itself is deleted afterwards by the deletion follow-up.
 */
async function retireRows(
	tx: Tx,
	projectId: string,
	rows: Array<{ id: string; contextId: string | null }>,
	now: Date,
): Promise<void> {
	const contextIds = rows.flatMap((row) =>
		row.contextId ? [row.contextId] : [],
	);
	const contexts =
		contextIds.length > 0
			? await tx.projectContext.findMany({
					where: { id: { in: contextIds }, projectId },
					select: {
						id: true,
						sourceType: true,
						aiInstructions: true,
					},
				})
			: [];
	const plain: string[] = [];
	for (const row of rows) {
		const context = row.contextId
			? contexts.find((c) => c.id === row.contextId)
			: undefined;
		if (!context) {
			plain.push(row.id);
			continue;
		}
		await tx.projectDocumentFolderFile.updateMany({
			where: fileWriteWhere({ fileId: row.id }),
			data: {
				retiredAt: now,
				removalHeldAt: null,
				savedSourceType: context.sourceType,
				savedAiInstructions: context.aiInstructions,
			},
		});
	}
	if (plain.length > 0) {
		await tx.projectDocumentFolderFile.updateMany({
			where: {
				id: { in: plain },
				retiredAt: null,
				folder: { disconnectedAt: null },
			},
			data: { retiredAt: now, removalHeldAt: null },
		});
	}
}

/**
 * Act on the lookups of a read's candidates. Files still in the folder get
 * their miss count reset. Files confirmed gone are tombstoned, unless they are
 * more than a fifth of the folder's files and at least ten: then nothing is
 * removed and the folder holds them for an editor to confirm. The hold marks
 * exactly those files, and no other of the folder's, so a confirmation never
 * reaches a file whose lookup did not answer. Only rows still missed twice are
 * taken, so a reconnect in between cancels the removal.
 */
export async function tombstoneDocumentFolderFiles(params: {
	folderId: string;
	goneFileIds: string[];
	presentFileIds: string[];
	now?: Date;
}): Promise<
	| { status: "disconnected" }
	| { status: "held"; heldCount: number }
	| { status: "retired"; retiredFileIds: string[] }
> {
	const now = params.now ?? new Date();
	return db.$transaction(async (tx) => {
		const folder = await lockFolder(tx, params.folderId);
		if (!folder || folder.disconnectedAt) {
			return { status: "disconnected" } as const;
		}
		if (params.presentFileIds.length > 0) {
			await tx.projectDocumentFolderFile.updateMany({
				where: {
					id: { in: params.presentFileIds },
					folderId: folder.id,
					retiredAt: null,
				},
				data: { missCount: 0 },
			});
		}
		const gone =
			params.goneFileIds.length > 0
				? await tx.projectDocumentFolderFile.findMany({
						where: {
							id: { in: params.goneFileIds },
							folderId: folder.id,
							retiredAt: null,
							missCount: { gte: MISSES_BEFORE_LOOKUP },
						},
						select: { id: true, contextId: true },
					})
				: [];
		const clearHold =
			folder.pausedRemovalsCode ===
			DOCUMENT_FOLDER_PAUSED_REMOVALS_CODE.MASS_REMOVAL;

		if (gone.length > 0) {
			const total = await tx.projectDocumentFolderFile.count({
				where: { folderId: folder.id, retiredAt: null },
			});
			if (
				gone.length >= DOCUMENT_FOLDER_MASS_REMOVAL_MIN &&
				gone.length > DOCUMENT_FOLDER_MASS_REMOVAL_RATIO * total
			) {
				const heldIds = gone.map((row) => row.id);
				await tx.projectDocumentFolderFile.updateMany({
					where: {
						id: { in: heldIds },
						folderId: folder.id,
						retiredAt: null,
					},
					data: { removalHeldAt: now },
				});
				await tx.projectDocumentFolderFile.updateMany({
					where: {
						folderId: folder.id,
						retiredAt: null,
						removalHeldAt: { not: null },
						id: { notIn: heldIds },
					},
					data: { removalHeldAt: null },
				});
				await tx.projectDocumentFolder.update({
					where: { id: folder.id },
					data: {
						pausedRemovalsCode:
							DOCUMENT_FOLDER_PAUSED_REMOVALS_CODE.MASS_REMOVAL,
						heldRemovalCount: gone.length,
					},
				});
				return { status: "held", heldCount: gone.length } as const;
			}
			await retireRows(tx, folder.projectId, gone, now);
		}
		if (clearHold) {
			await tx.projectDocumentFolder.update({
				where: { id: folder.id },
				data: { pausedRemovalsCode: null, heldRemovalCount: null },
			});
		}
		return {
			status: "retired",
			retiredFileIds: gone.map((row) => row.id),
		} as const;
	});
}

/**
 * An editor confirms a held mass removal: the files the hold covers that are
 * still missing from two complete listings are tombstoned, and the hold is
 * cleared. A file missing twice that the hold does not cover, such as one
 * whose lookup did not answer, stays.
 *
 * The editor confirms the count they were shown. When the hold no longer
 * covers that many files, because a read changed it in between, nothing is
 * removed: the folder shows the count it does cover, which a new
 * confirmation must name, or no hold when it covers none.
 */
export async function confirmDocumentFolderRemovals(params: {
	projectId: string;
	folderId: string;
	/** The held count the editor was shown. */
	expectedCount: number;
	now?: Date;
}): Promise<
	| { status: "not_found" }
	| { status: "nothing_held" }
	| { status: "stale"; heldRemovalCount: number }
	| { status: "confirmed"; retired: number }
> {
	const now = params.now ?? new Date();
	return db.$transaction(async (tx) => {
		const folder = await lockFolder(tx, params.folderId);
		if (
			!folder ||
			folder.projectId !== params.projectId ||
			folder.disconnectedAt
		) {
			return { status: "not_found" } as const;
		}
		if (
			folder.pausedRemovalsCode !==
			DOCUMENT_FOLDER_PAUSED_REMOVALS_CODE.MASS_REMOVAL
		) {
			return { status: "nothing_held" } as const;
		}
		const rows = await tx.projectDocumentFolderFile.findMany({
			where: {
				folderId: folder.id,
				retiredAt: null,
				removalHeldAt: { not: null },
				missCount: { gte: MISSES_BEFORE_LOOKUP },
			},
			select: { id: true, contextId: true },
		});
		if (rows.length !== params.expectedCount) {
			// A hold that covers no file any more is over.
			await tx.projectDocumentFolder.update({
				where: { id: folder.id },
				data:
					rows.length > 0
						? { heldRemovalCount: rows.length }
						: { pausedRemovalsCode: null, heldRemovalCount: null },
			});
			return { status: "stale", heldRemovalCount: rows.length } as const;
		}
		await retireRows(tx, folder.projectId, rows, now);
		await tx.projectDocumentFolder.update({
			where: { id: folder.id },
			data: { pausedRemovalsCode: null, heldRemovalCount: null },
		});
		return { status: "confirmed", retired: rows.length } as const;
	});
}

/**
 * Show that removals are paused because Graph throttled a read's lookups, so
 * nothing was removed. A held mass removal keeps its own code. The next
 * complete listing clears this.
 */
export async function recordDocumentFolderLookupsThrottled(params: {
	folderId: string;
}): Promise<void> {
	await db.projectDocumentFolder.updateMany({
		where: {
			id: params.folderId,
			disconnectedAt: null,
			// A plain `not` would skip the folders with no code at all.
			OR: [
				{ pausedRemovalsCode: null },
				{
					pausedRemovalsCode: {
						not: DOCUMENT_FOLDER_PAUSED_REMOVALS_CODE.MASS_REMOVAL,
					},
				},
			],
		},
		data: {
			pausedRemovalsCode: DOCUMENT_FOLDER_PAUSED_REMOVALS_CODE.THROTTLED,
		},
	});
}
