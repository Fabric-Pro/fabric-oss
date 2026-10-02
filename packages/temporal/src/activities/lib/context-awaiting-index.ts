/**
 * An index-only pass for Living Memory rows a repository sync left unindexed.
 *
 * A sync's index step starts one embedding per managed row still unindexed,
 * and joins a pass that is already open for a row rather than repeating it
 * (`startContextEmbeddingWorkflow` with `dedupe`). A joined pass that had
 * already made its last hash check cannot see the content that arrived after
 * it, so its row stays `embeddedAt IS NULL` until a later run starts a pass
 * of its own. The automatic poll starts a run only when the repository's head
 * moved, so a repository that then stops changing would leave the row
 * unindexed indefinitely.
 *
 * This is that later start, on the hourly reaper tick, for every sync with no
 * run open: it starts the same deduplicated embedding the sync would for each
 * row still unindexed. A row whose pass is genuinely still open is joined (a
 * no-op), so nothing is embedded twice.
 *
 * It is bounded in time. A row whose embedding fails for good would otherwise
 * be restarted every hour forever, and each start can spend enrichment calls.
 * So a row is eligible on a tick only when the whole hours since its content
 * last changed (`contentUpdatedAt`, else `createdAt`) are one of
 * `INDEX_RETRY_HOURS` (1, 2, 4, 8, 16, 32 or 64): an exponential back-off with
 * no stored state, which caps automatic retries at 7 per content version. A
 * row that changes again restarts the schedule. After 64 hours the row stays
 * awaiting, and the next real sync run's index step retries it.
 *
 * Bounded in volume too: by syncs paged and by embedding starts per tick; what
 * is left is the next tick's work.
 */
import {
	listContextRepositorySyncAwaitingIndexSince,
	listContextRepositorySyncsAwaitingIndex,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "../../client";
import { startContextEmbeddingWorkflow } from "../../lib/context-embedding-start";

const HOUR_MS = 60 * 60 * 1000;
/** The whole hours after a content change at which a tick retries a row. */
export const INDEX_RETRY_HOURS: readonly number[] = [1, 2, 4, 8, 16, 32, 64];
/** Syncs read per page. */
export const AWAITING_INDEX_SYNC_PAGE_SIZE = 25;
/** Pages of syncs read per tick. */
export const MAX_AWAITING_INDEX_SYNC_PAGES = 8;
/** Rows read per page of one sync's rows. */
export const AWAITING_INDEX_ROW_PAGE_SIZE = 200;
/** Pages of one sync's rows read per tick. */
export const MAX_AWAITING_INDEX_ROW_PAGES = 10;
/** Embedding starts per tick, across syncs. */
export const MAX_AWAITING_INDEX_STARTS_PER_RUN = 200;

/** Whether a tick at `nowMs` retries a row whose content changed at `changedAtMs`. */
export function isIndexRetryDue(changedAtMs: number, nowMs: number): boolean {
	const hours = Math.floor((nowMs - changedAtMs) / HOUR_MS);
	return INDEX_RETRY_HOURS.includes(hours);
}

export type AwaitingIndexPassResult = {
	syncs: number;
	started: number;
	errorCount: number;
};

export async function startAwaitingContextIndexing(
	now: number = Date.now(),
): Promise<AwaitingIndexPassResult> {
	const result: AwaitingIndexPassResult = {
		syncs: 0,
		started: 0,
		errorCount: 0,
	};
	const oldest = INDEX_RETRY_HOURS[INDEX_RETRY_HOURS.length - 1] ?? 0;
	const changedBetween = {
		from: new Date(now - (oldest + 1) * HOUR_MS),
		to: new Date(now - HOUR_MS),
	};
	let client: Awaited<ReturnType<typeof getTemporalClient>> | null = null;
	let afterId: string | null = null;
	for (let page = 0; page < MAX_AWAITING_INDEX_SYNC_PAGES; page++) {
		if (result.started >= MAX_AWAITING_INDEX_STARTS_PER_RUN) {
			break;
		}
		const syncs = await listContextRepositorySyncsAwaitingIndex({
			changedBetween,
			afterId,
			limit: AWAITING_INDEX_SYNC_PAGE_SIZE,
		});
		for (const sync of syncs) {
			if (result.started >= MAX_AWAITING_INDEX_STARTS_PER_RUN) {
				break;
			}
			result.syncs++;
			try {
				let afterKey: string | null = null;
				for (
					let rowPage = 0;
					rowPage < MAX_AWAITING_INDEX_ROW_PAGES;
					rowPage++
				) {
					const rows =
						await listContextRepositorySyncAwaitingIndexSince(
							{
								projectId: sync.projectId,
								organizationId: sync.organizationId,
							},
							sync.id,
							{
								changedBetween,
								afterKey,
								limit: AWAITING_INDEX_ROW_PAGE_SIZE,
							},
						);
					for (const row of rows) {
						if (
							result.started >=
								MAX_AWAITING_INDEX_STARTS_PER_RUN ||
							!isIndexRetryDue(row.changedAt.getTime(), now)
						) {
							continue;
						}
						client ??= await getTemporalClient();
						await startContextEmbeddingWorkflow(
							client,
							{
								contextId: row.id,
								projectId: sync.projectId,
								userId: sync.userId,
								organizationId: sync.organizationId,
								sourcePath: row.sourcePath,
								title: row.title,
								reembed: true,
							},
							{ dedupe: true },
						);
						result.started++;
					}
					afterKey = rows.at(-1)?.sourcePath ?? null;
					if (
						rows.length < AWAITING_INDEX_ROW_PAGE_SIZE ||
						afterKey === null ||
						result.started >= MAX_AWAITING_INDEX_STARTS_PER_RUN
					) {
						break;
					}
				}
			} catch (error) {
				// Each sync belongs to a different tenant: one failure must not
				// stop the others. Its rows stay unindexed for the next tick.
				result.errorCount++;
				logger.warn(
					{
						event: "context.reaper.awaiting_index.start_failed",
						projectId: sync.projectId,
						organizationId: sync.organizationId,
						errorName:
							error instanceof Error ? error.name : typeof error,
					},
					"[ContextSyncReaper] Could not start an index-only pass; it is retried next run",
				);
			}
		}
		afterId = syncs.at(-1)?.id ?? null;
		if (syncs.length < AWAITING_INDEX_SYNC_PAGE_SIZE || afterId === null) {
			break;
		}
	}
	return result;
}
