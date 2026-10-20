/**
 * What a write folder's indexing choice sets in motion once the transaction
 * that recomputed its rows has committed (ADR-022).
 *
 *  - Rows that became Store only had their unindexed marks cleared and their
 *    vectors queued for deletion in that transaction. Each queued record gets
 *    one bounded drain here; whatever does not finish is left to the
 *    pending-vector-cleanup sweep, exactly as a synced-file delete does.
 *  - Files that stopped being Store only are embedded through the same
 *    guarded, deduplicated pass the sync's index step uses
 *    (`startContextEmbeddingWorkflow` with `dedupe`). At most
 *    {@link MAX_INDEX_STARTS_PER_CHANGE} are started here so the request stays
 *    short; the rest are found by the next sync run's index step, which embeds
 *    every file still unindexed.
 *
 * The change is already committed, so nothing here fails the request: a
 * failure is logged and the sweep or the next run finishes the work.
 */
import {
	type ContextIndexReconcileResult,
	listContextRepositorySyncAwaitingIndex,
	type PendingVectorCleanupRecord,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { startContextEmbeddingWorkflow } from "@repo/temporal/context-embedding-start";
import { drainPendingVectorCleanup } from "@repo/temporal/delete-channel-context";
import { withCorrelationMemo } from "../../../../../../lib/temporal-correlation";

/** How long one cleanup record is awaited before it is left to the sweep. */
const CLEANUP_DRAIN_MS = 15_000;
/** Embeddings started by one change. */
export const MAX_INDEX_STARTS_PER_CHANGE = 500;
/** Rows read per page while starting them. */
const INDEX_START_PAGE_SIZE = 100;

async function drainOnce(record: PendingVectorCleanupRecord): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const drain = drainPendingVectorCleanup(record);
	drain.catch(() => undefined);
	try {
		const outcome = await Promise.race([
			drain.then(() => "drained" as const),
			new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), CLEANUP_DRAIN_MS);
			}),
		]);
		if (outcome === "timeout") {
			logger.warn(
				`[WriteFolderIndexing] Draining cleanup ${record.id} took longer than ${CLEANUP_DRAIN_MS} ms; leaving it to the pending-vector-cleanup sweep`,
			);
		}
	} catch (error) {
		logger.warn(
			`[WriteFolderIndexing] Could not drain cleanup ${record.id}; leaving it to the pending-vector-cleanup sweep: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timer);
	}
}

async function startIndexing(input: {
	projectId: string;
	organizationId: string;
	syncId: string;
	userId: string;
}): Promise<void> {
	try {
		const client = await getTemporalClient();
		let started = 0;
		let afterKey: string | null = null;
		while (started < MAX_INDEX_STARTS_PER_CHANGE) {
			const page = await listContextRepositorySyncAwaitingIndex(
				{
					projectId: input.projectId,
					organizationId: input.organizationId,
				},
				input.syncId,
				{ afterKey, limit: INDEX_START_PAGE_SIZE },
			);
			for (const row of page) {
				if (started >= MAX_INDEX_STARTS_PER_CHANGE) {
					break;
				}
				await startContextEmbeddingWorkflow(
					client,
					{
						contextId: row.id,
						projectId: input.projectId,
						userId: input.userId,
						organizationId: input.organizationId,
						sourcePath: row.sourcePath,
						title: row.title,
						reembed: true,
					},
					{ decorateStartOptions: withCorrelationMemo, dedupe: true },
				);
				started++;
			}
			const last = page.at(-1);
			if (page.length < INDEX_START_PAGE_SIZE || !last) {
				break;
			}
			afterKey = last.sourcePath;
		}
	} catch (error) {
		logger.warn(
			`[WriteFolderIndexing] Could not start indexing for sync ${input.syncId}; the next sync run will: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export async function settleIndexingChange(input: {
	reindex: ContextIndexReconcileResult;
	projectId: string;
	organizationId: string;
	syncId: string;
	userId: string;
}): Promise<void> {
	for (const record of input.reindex.cleanups) {
		await drainOnce(record);
	}
	if (input.reindex.included > 0) {
		await startIndexing(input);
	}
}
