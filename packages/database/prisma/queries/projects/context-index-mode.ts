/**
 * Living Memory "Store only" write folders (ADR-022): how the choice a folder
 * makes reaches the rows under it.
 *
 * `ProjectContextWriteTarget.indexMode` is the source of truth. A repository-
 * managed row carries a derived copy, `indexingExcluded`, because every query
 * that must honour the choice (the awaiting-index scans, the summarization
 * reads, a grouped SQL volume count) is a plain predicate on the row, and a
 * path-prefix join against the folders would not fit in any of them.
 *
 * `reconcileContextIndexing` recomputes the copy from the folders in one
 * statement and is idempotent, so it runs wherever either side can have moved,
 * always inside a transaction that holds lock 1 of the sync (the one every
 * folder change and every apply batch already holds): after a folder is
 * created, changed or removed, and after each batch of files is applied, which
 * is how a file that arrives, moves between folders or is adopted lands on the
 * right side.
 *
 * A row that BECAME store-only and held vectors is marked unindexed
 * (`embeddedAt`, `qdrantId` cleared) and its vectors are queued for deletion
 * in the same transaction (`createPendingVectorCleanup`), in chunks the
 * vector store's delete takes comfortably. The caller drains the returned
 * records after commit; the pending-cleanup sweep finishes what it cannot.
 * A row that became indexable again needs nothing here: it has
 * `embeddedAt IS NULL`, so the next index pass finds it. A store-only row
 * still reading PENDING is settled to COMPLETED (`settleStoreOnlyRows`).
 */
import { Prisma } from "../../client";
import {
	createPendingVectorCleanup,
	type PendingVectorCleanupRecord,
} from "./pending-vector-cleanup";

/** Ids per cleanup record: the size a prune batch queues, and one vector delete batch. */
export const CONTEXT_INDEX_CLEANUP_CHUNK = 200;

/** Ids per `updateMany`, far below the bind-parameter limit. */
const CLEAR_INDEX_MARKS_CHUNK = 10_000;

export interface ContextIndexReconcileResult {
	/** Rows that became store-only. */
	excluded: number;
	/** Rows that stopped being store-only and are to be indexed. */
	included: number;
	/** Vector cleanups queued for the rows that became store-only. */
	cleanups: PendingVectorCleanupRecord[];
}

export async function reconcileContextIndexing(
	tx: Prisma.TransactionClient,
	input: {
		projectId: string;
		organizationId: string;
		syncId: string;
		/** Recorded on the cleanup records; an organization's carry no user. */
		actingUserId: string;
		/** Only these paths, when a batch knows exactly which rows it touched. */
		sourcePaths?: readonly string[];
	},
): Promise<ContextIndexReconcileResult> {
	const underStoreOnlyFolder = Prisma.sql`EXISTS (
		SELECT 1 FROM "project_context_write_target" t
		WHERE t."syncId" = c."repositorySyncId"
			AND t."indexMode" = 'STORE_ONLY'
			AND starts_with(c."sourcePath", t."folder" || '/')
	)`;
	const onlyPaths =
		input.sourcePaths === undefined
			? Prisma.empty
			: Prisma.sql`AND c."sourcePath" = ANY(${[...input.sourcePaths]})`;
	const changed = await tx.$queryRaw<
		Array<{ id: string; indexingExcluded: boolean; hadVectors: boolean }>
	>`
		UPDATE "project_context" c
		SET "indexingExcluded" = ${underStoreOnlyFolder}
		WHERE c."projectId" = ${input.projectId}
			AND c."organizationId" = ${input.organizationId}
			AND c."repositorySyncId" = ${input.syncId}
			${onlyPaths}
			AND c."indexingExcluded" IS DISTINCT FROM ${underStoreOnlyFolder}
		RETURNING c."id", c."indexingExcluded",
			(c."embeddedAt" IS NOT NULL OR c."qdrantId" IS NOT NULL) AS "hadVectors"
	`;

	const becameExcluded = changed.filter((row) => row.indexingExcluded);
	const withVectors = becameExcluded
		.filter((row) => row.hadVectors)
		.map((row) => row.id);

	for (let i = 0; i < withVectors.length; i += CLEAR_INDEX_MARKS_CHUNK) {
		await tx.projectContext.updateMany({
			where: {
				id: { in: withVectors.slice(i, i + CLEAR_INDEX_MARKS_CHUNK) },
				projectId: input.projectId,
				organizationId: input.organizationId,
				indexingExcluded: true,
			},
			data: { embeddedAt: null, qdrantId: null },
		});
	}

	await settleStoreOnlyRows(tx, input);

	const cleanups: PendingVectorCleanupRecord[] = [];
	for (let i = 0; i < withVectors.length; i += CONTEXT_INDEX_CLEANUP_CHUNK) {
		const contextIds = withVectors.slice(
			i,
			i + CONTEXT_INDEX_CLEANUP_CHUNK,
		);
		const id = await createPendingVectorCleanup(tx, {
			projectId: input.projectId,
			contextIds,
			tenant: {
				userId: input.actingUserId,
				organizationId: input.organizationId,
			},
		});
		cleanups.push({
			id,
			projectId: input.projectId,
			contextIds,
			userId: null,
			organizationId: input.organizationId,
		});
	}

	return {
		excluded: becameExcluded.length,
		included: changed.length - becameExcluded.length,
		cleanups,
	};
}

/**
 * A synced file's extraction is marked COMPLETED by the embedding pass, which
 * a store-only file never gets. Its text is stored and readable as soon as it
 * syncs, so it is settled here instead. Left PENDING, it reads as "Pending" in
 * the file list, counts as a source still processing wherever sources in
 * flight are counted, and is reported as a stalled source 40 minutes later.
 * Not tied to the flag changing, so rows marked before this existed settle
 * on the next reconcile that covers them.
 */
async function settleStoreOnlyRows(
	tx: Prisma.TransactionClient,
	input: {
		projectId: string;
		organizationId: string;
		syncId: string;
		sourcePaths?: readonly string[];
	},
): Promise<void> {
	await tx.projectContext.updateMany({
		where: {
			projectId: input.projectId,
			organizationId: input.organizationId,
			repositorySyncId: input.syncId,
			...(input.sourcePaths === undefined
				? {}
				: { sourcePath: { in: [...input.sourcePaths] } }),
			indexingExcluded: true,
			extractionStatus: "PENDING",
		},
		data: { extractionStatus: "COMPLETED", extractedAt: new Date() },
	});
}

/**
 * Release a sync's rows from the store-only mark when the sync is deleted
 * (disable, or the repository integration is disconnected). The foreign key
 * turns them into ordinary synced files, which nothing could ever clear the
 * mark from. Call it in the transaction that deletes the sync, before the
 * delete. The rows are then found by the project-wide index pass like any
 * other unindexed synced file.
 */
export async function releaseStoreOnlyContexts(
	tx: Prisma.TransactionClient,
	input: { projectId: string; organizationId: string; syncId: string },
): Promise<void> {
	await tx.projectContext.updateMany({
		where: {
			projectId: input.projectId,
			organizationId: input.organizationId,
			repositorySyncId: input.syncId,
			indexingExcluded: true,
		},
		data: { indexingExcluded: false },
	});
}
