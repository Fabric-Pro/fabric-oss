/**
 * Apply one read of a folder to its ledger.
 */

import { db, type Prisma } from "../../../client";
import {
	DOCUMENT_FOLDER_PAUSED_REMOVALS_CODE,
	type DocumentFolderFileStatus,
	INSERT_CHUNK,
	MISSES_BEFORE_LOOKUP,
	RECONCILE_TRANSACTION,
} from "./constants";
import { toBigIntOrNull, toNumberOrNull } from "./helpers";
import {
	type DocumentFolderLedgerRow,
	type DocumentFolderListedFile,
	type DocumentFolderReconcilePlan,
	type DocumentFolderRowPatch,
	EMPTY_COUNTS,
	planDocumentFolderReconcile,
} from "./plan";
import { fileWriteWhere, lockFolder, type Tx } from "./write-conditions";

export type DocumentFolderReconcileResult =
	| { status: "disconnected" }
	/** The folder was reconnected after the read started. */
	| { status: "stale" }
	| {
			status: "applied" | "already_applied";
			counts: DocumentFolderReconcilePlan["counts"];
			/** Files missing from two complete listings, to look up by id. */
			candidates: Array<{ fileId: string; driveItemId: string }>;
	  };

async function currentCandidates(tx: Tx, folderId: string) {
	const rows = await tx.projectDocumentFolderFile.findMany({
		where: {
			folderId,
			retiredAt: null,
			missCount: { gte: MISSES_BEFORE_LOOKUP },
		},
		select: { id: true, driveItemId: true },
	});
	return rows.map((row) => ({
		fileId: row.id,
		driveItemId: row.driveItemId,
	}));
}

function rowData(
	patch: DocumentFolderRowPatch,
): Prisma.ProjectDocumentFolderFileUpdateManyMutationInput {
	const { size, ...rest } = patch;
	return {
		...rest,
		...(size === undefined ? {} : { size: toBigIntOrNull(size) }),
	};
}

function metadataObject(value: Prisma.JsonValue | null): Prisma.JsonObject {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Prisma.JsonObject)
		: {};
}

/**
 * Apply one read of a folder to its ledger. One call per read, under the
 * folder row's lock.
 *
 * Applies nothing when the folder was reconnected since the read started, and
 * counts nothing again for a pass it already applied; either way it returns
 * the current candidates so a retried activity can go on. The folder's name,
 * path and web address are refreshed from the root item. A truncated listing
 * records why removals are paused; a complete one clears that, except a held
 * mass removal, which only tombstoning or a confirmation settles.
 */
export async function reconcileDocumentFolderListing(
	params: {
		folderId: string;
		/** Generated once per pass by the workflow. */
		passId: string;
		/** The epoch `startDocumentFolderRead` returned. */
		readerEpoch: number;
		root: { name: string; webUrl: string | null; drivePath: string | null };
		files: DocumentFolderListedFile[];
		now?: Date;
	} & (
		| { complete: true }
		| {
				complete: false;
				pausedRemovalsCode: "TOO_LARGE" | "THROTTLED" | "PARTIAL_READ";
		  }
	),
): Promise<DocumentFolderReconcileResult> {
	const now = params.now ?? new Date();
	return db.$transaction(async (tx) => {
		const folder = await lockFolder(tx, params.folderId);
		if (!folder || folder.disconnectedAt) {
			return { status: "disconnected" } as const;
		}
		if (folder.readerEpoch !== params.readerEpoch) {
			return { status: "stale" } as const;
		}
		if (folder.lastPassId === params.passId) {
			return {
				status: "already_applied",
				counts: { ...EMPTY_COUNTS },
				candidates: params.complete
					? await currentCandidates(tx, folder.id)
					: [],
			} as const;
		}

		const stored = await tx.projectDocumentFolderFile.findMany({
			where: { folderId: folder.id },
			select: {
				id: true,
				driveItemId: true,
				name: true,
				relativePath: true,
				size: true,
				sourceModifiedAt: true,
				status: true,
				skipCode: true,
				contextId: true,
				importedVersion: true,
				latestVersion: true,
				latestVersionSeenCount: true,
				excludedVersion: true,
				missCount: true,
				retiredAt: true,
			},
		});
		const rows: DocumentFolderLedgerRow[] = stored.map((row) => ({
			...row,
			size: toNumberOrNull(row.size),
			status: row.status as DocumentFolderFileStatus,
		}));
		const contextIds = rows.flatMap((row) =>
			row.contextId ? [row.contextId] : [],
		);
		const contexts =
			contextIds.length > 0
				? await tx.projectContext.findMany({
						where: {
							id: { in: contextIds },
							projectId: folder.projectId,
						},
						select: {
							id: true,
							metadata: true,
							sourceType: true,
							aiInstructions: true,
						},
					})
				: [];
		const contextById = new Map(contexts.map((c) => [c.id, c]));

		const plan = planDocumentFolderReconcile({
			rows,
			files: params.files,
			complete: params.complete,
			liveContextIds: new Set(contextById.keys()),
		});

		for (let i = 0; i < plan.inserts.length; i += INSERT_CHUNK) {
			await tx.projectDocumentFolderFile.createMany({
				data: plan.inserts.slice(i, i + INSERT_CHUNK).map((insert) => ({
					folderId: folder.id,
					projectId: folder.projectId,
					driveItemId: insert.driveItemId,
					name: insert.name,
					relativePath: insert.relativePath,
					size: toBigIntOrNull(insert.size),
					sourceModifiedAt: insert.sourceModifiedAt,
					status: insert.status,
					skipCode: insert.skipCode,
					latestVersion: insert.latestVersion,
					latestVersionSeenCount: 1,
					lastSeenAt: now,
					userId: folder.userId,
					organizationId: folder.organizationId,
				})),
				skipDuplicates: true,
			});
		}

		for (const update of plan.updates) {
			const context = update.saveGuidanceFromContextId
				? contextById.get(update.saveGuidanceFromContextId)
				: undefined;
			await tx.projectDocumentFolderFile.updateMany({
				where: fileWriteWhere({
					fileId: update.id,
					status: update.fromStatus,
					retired: update.fromRetired,
				}),
				data: {
					...rowData(update.data),
					...(context
						? {
								savedSourceType: context.sourceType,
								savedAiInstructions: context.aiInstructions,
							}
						: {}),
				},
			});
		}

		if (plan.seenIds.length > 0) {
			// A file seen again is no longer covered by a mass-removal hold.
			await tx.projectDocumentFolderFile.updateMany({
				where: { id: { in: plan.seenIds } },
				data: { lastSeenAt: now, removalHeldAt: null },
			});
		}
		if (plan.resetMissIds.length > 0) {
			await tx.projectDocumentFolderFile.updateMany({
				where: { id: { in: plan.resetMissIds }, retiredAt: null },
				data: { missCount: 0 },
			});
		}
		if (plan.missedIds.length > 0) {
			await tx.projectDocumentFolderFile.updateMany({
				where: { id: { in: plan.missedIds }, retiredAt: null },
				data: { missCount: { increment: 1 } },
			});
		}

		for (const renamed of plan.renamedContexts) {
			const context = contextById.get(renamed.contextId);
			if (!context) {
				continue;
			}
			await tx.projectContext.updateMany({
				where: { id: renamed.contextId, projectId: folder.projectId },
				data: {
					originalFilename: renamed.name,
					metadata: {
						...metadataObject(context.metadata),
						relativePath: renamed.relativePath,
					},
				},
			});
		}

		const MASS = DOCUMENT_FOLDER_PAUSED_REMOVALS_CODE.MASS_REMOVAL;
		await tx.projectDocumentFolder.update({
			where: { id: folder.id },
			data: {
				name: params.root.name,
				webUrl: params.root.webUrl,
				drivePath: params.root.drivePath,
				lastPassId: params.passId,
				lastReadAt: now,
				lastListingComplete: params.complete,
				problemCode: null,
				...(params.complete
					? {
							discoveredAt: folder.discoveredAt ?? now,
							...(folder.pausedRemovalsCode === MASS
								? {}
								: {
										pausedRemovalsCode: null,
										heldRemovalCount: null,
									}),
						}
					: // A held mass removal stays held: its rows keep their
						// hold, and only tombstoning or a confirmation settles it.
						folder.pausedRemovalsCode === MASS
						? {}
						: {
								pausedRemovalsCode: params.pausedRemovalsCode,
								heldRemovalCount: null,
							}),
			},
		});

		return {
			status: "applied",
			counts: plan.counts,
			candidates: plan.candidates,
		} as const;
	}, RECONCILE_TRANSACTION);
}
